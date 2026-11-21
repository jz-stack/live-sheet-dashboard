import { AppError } from './errors.mjs';
import {
  clone, createEmptyDocument, generateDefaultDocument, validateDocument,
} from './document.mjs';
import { applyPatch, dryRunPatch, normalizePatch, revertTopPatch } from './patch.mjs';
import { emptyDocumentProjection, projectDocument } from './component-projection.mjs';

export class DocumentRepository {
  constructor({ store = null, logger = null } = {}) {
    this.store = store;
    this.logger = logger;
    this.document = createEmptyDocument();
    this.initialized = false;
    this.drafts = new Map();
    this.cache = null;
    this.#restore();
  }

  #restore() {
    if (!this.store) return;
    try {
      const restored = this.store.load();
      if (!restored) return;
      this.document = restored;
      this.initialized = true;
    } catch (error) {
      this.logger?.warn('画布配置恢复失败，使用默认布局', { message: error.message });
    }
  }

  #persist() {
    if (!this.store) return;
    try {
      this.store.schedule(this.getCurrent());
    } catch (error) {
      this.logger?.warn('画布配置排队写入失败', { message: error.message });
    }
  }

  async flush() {
    if (!this.store) return;
    await this.store.flush();
  }

  storageStats() {
    return this.store ? this.store.stats() : { persisted: false };
  }

  getCurrent() {
    return clone(this.document);
  }

  view() {
    return { document: this.getCurrent(), revision: this.document.revision, drafts: [...this.drafts.values()].map(clone) };
  }

  ensureInitialized(snapshot) {
    if (this.initialized || !snapshot?.schema?.length) return;
    this.document = generateDefaultDocument(snapshot, this.document);
    this.initialized = true;
    this.cache = null;
    this.#persist();
  }

  project(snapshot) {
    this.ensureInitialized(snapshot);
    if (!snapshot?.schema?.length) {
      return { ...emptyDocumentProjection(), document: this.getCurrent(), documentRevision: this.document.revision };
    }
    const key = `${snapshot.instanceId}:${snapshot.version}:${this.document.revision}`;
    if (this.cache?.key === key) return clone(this.cache.value);
    const value = {
      ...projectDocument(this.document, snapshot),
      document: this.getCurrent(),
      documentRevision: this.document.revision,
    };
    this.cache = { key, value: clone(value) };
    return value;
  }

  dryRun(input) {
    return dryRunPatch(this.document, input);
  }

  submit(input, { draft = false } = {}) {
    const patch = normalizePatch(input);
    dryRunPatch(this.document, patch);
    if (draft) {
      this.drafts.set(patch.id, patch);
      return { draft: clone(patch), document: this.getCurrent(), applied: false };
    }
    const result = applyPatch(this.document, patch);
    this.document = result.document;
    this.cache = null;
    this.#persist();
    return { ...result, document: this.getCurrent(), applied: true };
  }

  acceptDraft(id) {
    const draft = this.drafts.get(id);
    if (!draft) throw new AppError('待审阅 Patch 不存在', { code: 'DRAFT_NOT_FOUND', status: 404, stage: 'patch' });
    const result = this.submit({ ...draft, id }, { draft: false });
    this.drafts.delete(id);
    return result;
  }

  rejectDraft(id) {
    const draft = this.drafts.get(id);
    if (!draft) throw new AppError('待审阅 Patch 不存在', { code: 'DRAFT_NOT_FOUND', status: 404, stage: 'patch' });
    this.drafts.delete(id);
    return { ...clone(draft), state: 'rejected' };
  }

  revert(id) {
    const result = revertTopPatch(this.document, id);
    this.document = result.document;
    this.cache = null;
    this.#persist();
    return { ...result, document: this.getCurrent() };
  }

  reset(snapshot) {
    if (!snapshot?.schema?.length) throw new AppError('当前没有可用于生成布局的数据', { code: 'DATASET_NOT_READY', status: 409, stage: 'document' });
    this.document = generateDefaultDocument(snapshot, this.document);
    this.initialized = true;
    this.drafts.clear();
    this.cache = null;
    this.#persist();
    return this.getCurrent();
  }

  replace(input) {
    const next = validateDocument(input);
    next.revision = (this.document.revision || 0) + 1;
    next.updatedAt = new Date().toISOString();
    this.document = next;
    this.initialized = true;
    this.drafts.clear();
    this.cache = null;
    this.#persist();
    return this.getCurrent();
  }
}
