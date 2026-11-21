import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { validateDocument } from './document.mjs';

// 配置文件信封版本，用于将来结构升级时拒绝不认识的旧/新格式
export const ENVELOPE_VERSION = 1;

/**
 * Document 的文件持久化。
 *
 * 设计要点：
 * 1. 原子写入：先写 `<file>.tmp` 再 rename，避免进程中断留下半个 JSON。
 * 2. 写入去抖：连续拖拽只落盘一次，不阻塞请求线程。
 * 3. 加载容错：文件损坏 / 结构非法 / 版本过高时隔离为 `.corrupt-*` 备份，
 *    返回 null 让上层回落到默认布局，绝不因配置文件问题导致进程起不来。
 * 4. 补丁历史不恢复：validateDocument 会清空 patches，撤销栈仅存在于内存，
 *    重启后从当前版式继续，避免未校验的历史补丁破坏画布不变式。
 */
export class DocumentStore {
  constructor({ file, logger = null, flushDelayMs = 250 } = {}) {
    this.file = file || '';
    this.logger = logger;
    this.flushDelayMs = flushDelayMs;
    this.pending = null;
    this.timer = null;
    this.writing = Promise.resolve();
    this.lastError = null;
    this.lastSavedAt = null;
  }

  get tempFile() {
    return `${this.file}.tmp`;
  }

  /** 启动时同步加载。返回合法 Document 或 null。 */
  load() {
    if (!this.file || !fs.existsSync(this.file)) return null;

    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (error) {
      return this.#quarantine('配置文件不是合法 JSON', error);
    }

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return this.#quarantine('配置文件内容不是对象', null);
    }

    const hasEnvelope = Object.hasOwn(raw, 'document');
    if (hasEnvelope && Number.isInteger(raw.schemaVersion) && raw.schemaVersion > ENVELOPE_VERSION) {
      return this.#quarantine(`配置文件版本 ${raw.schemaVersion} 高于支持的 ${ENVELOPE_VERSION}`, null);
    }

    const candidate = hasEnvelope ? raw.document : raw;
    try {
      const document = validateDocument(candidate);
      this.logger?.info('已恢复画布配置', { file: this.file, revision: document.revision, components: document.components.length });
      return document;
    } catch (error) {
      return this.#quarantine('画布结构校验失败', error);
    }
  }

  /** 记录最新版本并安排落盘；重复调用只保留最后一次。 */
  schedule(document) {
    if (!this.file) return;
    this.pending = document;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(() => {});
    }, this.flushDelayMs);
    this.timer.unref?.();
  }

  /** 立即把待写入内容落盘，返回写入完成的 Promise。 */
  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.pending) return this.writing;
    const document = this.pending;
    this.pending = null;
    this.writing = this.writing.then(() => this.#write(document)).catch(() => {});
    return this.writing;
  }

  async close() {
    await this.flush();
    await this.writing;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  stats() {
    return {
      file: this.file ? path.basename(this.file) : null,
      persisted: Boolean(this.file),
      lastSavedAt: this.lastSavedAt,
      pending: Boolean(this.pending),
      error: this.lastError ? String(this.lastError.message || this.lastError) : null,
    };
  }

  async #write(document) {
    if (!this.file) return;
    const body = JSON.stringify({
      schemaVersion: ENVELOPE_VERSION,
      savedAt: new Date().toISOString(),
      document,
    }, null, 2);
    try {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      await fsp.writeFile(this.tempFile, body, 'utf8');
      await fsp.rename(this.tempFile, this.file);
      this.lastSavedAt = new Date().toISOString();
      this.lastError = null;
    } catch (error) {
      // 持久化失败不能影响画布使用，只记录并留给上层健康检查展示
      this.lastError = error;
      this.logger?.warn('画布配置保存失败', { file: this.file, message: error.message, code: error.code });
      throw error;
    }
  }

  #quarantine(reason, error) {
    const backup = `${this.file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(this.file, backup);
      this.logger?.warn('画布配置不可用，已隔离并回落默认布局', { reason, backup, message: error?.message });
    } catch (renameError) {
      this.logger?.warn('画布配置不可用且隔离失败，将使用默认布局', { reason, message: renameError.message });
    }
    return null;
  }
}
