import { Worker } from 'node:worker_threads';
import { AppError } from './errors.mjs';

export class WorkbookWorker {
  constructor({ config, logger, metrics }) {
    this.config = config;
    this.logger = logger;
    this.metrics = metrics;
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
    this.closing = false;
  }

  start() {
    if (this.worker) return;
    const worker = new Worker(new URL('./workbook-worker.mjs', import.meta.url), {
      resourceLimits: {
        maxOldGenerationSizeMb: this.config.WORKER_MEMORY_MB,
        maxYoungGenerationSizeMb: Math.min(64, this.config.WORKER_MEMORY_MB / 4),
      },
    });
    worker.on('message', (message) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result);
      else {
        const error = new AppError(message.error.message, message.error);
        pending.reject(error);
      }
    });
    worker.on('error', (error) => this.crash(error));
    worker.on('exit', (code) => {
      if (this.worker === worker) this.worker = null;
      if (code !== 0 && !this.closing) this.crash(new AppError(`解析 worker 异常退出（${code}）`, { code: 'WORKER_CRASH', stage: 'worker', retryable: true }));
    });
    worker.unref();
    this.worker = worker;
  }

  crash(error) {
    if (this.closing) return;
    this.metrics.increment('workerRestarts');
    this.logger.error('workbook worker 异常', { code: error.code, message: error.message });
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
  }

  request(type, file = this.config.TARGET_FILE, extra = {}) {
    if (this.closing) return Promise.reject(new AppError('服务正在关闭', { code: 'WORKER_CLOSED', stage: 'worker' }));
    this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new AppError(`worker 执行超过 ${this.config.WORKER_TIMEOUT_MS}ms，已终止`, {
          code: 'WORKER_TIMEOUT', stage: 'worker', retryable: false,
        });
        reject(error);
        this.crash(error);
      }, this.config.WORKER_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, type, file, limits: this.config.LIMITS, ...extra });
    });
  }

  parse(file, source) { return this.request('parse', file, { source }); }
  simulate(file, sheetName) { return this.request('simulate', file, { sheetName }); }

  async close() {
    this.closing = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AppError('服务正在关闭', { code: 'WORKER_CLOSED', stage: 'worker' }));
    }
    this.pending.clear();
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate();
  }
}
