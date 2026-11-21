import { AppError } from './errors.mjs';

const RETRYABLE = new Set(['EBUSY', 'EPERM', 'EBLOCKED', 'ENOENT', 'UNKNOWN', 'WORKER_CRASH']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class IngestService {
  constructor({ config, repository, worker, notifier, logger, metrics, onCommit = null }) {
    this.config = config;
    this.repository = repository;
    this.worker = worker;
    this.notifier = notifier;
    this.logger = logger;
    this.metrics = metrics;
    this.onCommit = onCommit;
    this.requestedGeneration = 0;
    this.handledGeneration = 0;
    this.latestReason = null;
    this.timer = null;
    this.running = false;
    this.missing = false;
    this.closed = false;
    this.idlePromise = Promise.resolve();
    this.resolveIdle = null;
  }

  ensureIdle() {
    if (!this.resolveIdle) {
      this.idlePromise = new Promise((resolve) => { this.resolveIdle = resolve; });
    }
  }

  settleIdle() {
    if (this.running || this.timer || this.handledGeneration !== this.requestedGeneration) return;
    this.resolveIdle?.();
    this.resolveIdle = null;
  }

  schedule(reason, { immediate = false } = {}) {
    if (this.closed) return 0;
    this.ensureIdle();
    this.missing = false;
    this.latestReason = reason;
    this.requestedGeneration += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drain().catch((error) => this.logger.error('摄入调度器异常', { message: error.message }));
    }, immediate ? 0 : this.config.DEBOUNCE_MS);
    return this.requestedGeneration;
  }

  refresh(reason = '手动刷新') {
    this.schedule(reason, { immediate: true });
    return this.whenIdle();
  }

  markMissing(reason = '文件被移走或删除') {
    if (this.closed) return;
    this.ensureIdle();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.requestedGeneration += 1;
    this.handledGeneration = this.running ? this.handledGeneration : this.requestedGeneration;
    this.missing = true;
    const state = this.repository.markStatus('missing', reason);
    this.notifier.broadcast('status', { status: state.status, revision: state.revision, reason });
    this.logger.warn('目标文件消失', { revision: state.revision });
    this.settleIdle();
  }

  async parseWithRetry(generation) {
    for (let attempt = 0; attempt < this.config.RETRY_ATTEMPTS; attempt += 1) {
      if (generation !== this.requestedGeneration || this.missing || this.closed) return null;
      try {
        return await this.worker.parse(this.config.TARGET_FILE, this.repository.sourceSpec());
      } catch (error) {
        const retryable = error.retryable || RETRYABLE.has(error.code);
        if (!retryable || attempt === this.config.RETRY_ATTEMPTS - 1) throw error;
        this.metrics.increment('parseRetries');
        await sleep(120 * (attempt + 1));
      }
    }
    return null;
  }

  async drain() {
    if (this.running || this.closed) return;
    this.running = true;
    try {
      while (!this.closed && this.handledGeneration < this.requestedGeneration) {
        if (this.missing) {
          this.handledGeneration = this.requestedGeneration;
          continue;
        }
        const generation = this.requestedGeneration;
        const reason = this.latestReason;
        this.handledGeneration = generation;
        const queueStartedAt = Date.now();
        let state = this.repository.markStatus('parsing', reason);
        this.notifier.broadcast('status', { status: state.status, revision: state.revision, reason });
        try {
          const result = await this.parseWithRetry(generation);
          if (!result || generation !== this.requestedGeneration || this.missing || this.closed) {
            this.metrics.increment('staleResults');
            continue;
          }
          state = this.repository.commit(result.parsed, result.projection, { file: this.config.TARGET_FILE, reason });
          this.metrics.success(state.parseMs, Date.now() - queueStartedAt);
          this.notifier.broadcast('update', {
            version: state.version,
            revision: state.revision,
            reason,
            rowCount: state.rowCount,
            parseMs: state.parseMs,
            updatedAt: state.updatedAt,
          });
          this.logger.info('数据快照已更新', { version: state.version, revision: state.revision, reason, rows: state.rowCount, parseMs: state.parseMs });
          if (this.onCommit) {
            try { await this.onCommit(state); } catch (hookError) {
              this.logger.warn('提交后回调失败，不影响数据链路', { message: hookError.message });
            }
          }
        } catch (error) {
          if (generation !== this.requestedGeneration || this.missing || this.closed) {
            this.metrics.increment('staleResults');
            continue;
          }
          state = this.repository.applyError(error, { file: this.config.TARGET_FILE, reason });
          this.metrics.failure(error);
          this.notifier.broadcast('failure', { revision: state.revision, reason, ...state.error });
          this.logger.warn('数据解析失败，保留上一版快照', { version: state.version, revision: state.revision, ...state.error });
        }
      }
    } finally {
      this.running = false;
      this.settleIdle();
      if (!this.closed && !this.timer && this.handledGeneration < this.requestedGeneration && !this.missing) {
        this.schedule(this.latestReason, { immediate: true });
      }
    }
  }

  whenIdle() { return this.idlePromise; }

  status() {
    return {
      running: this.running,
      queued: Boolean(this.timer) || this.handledGeneration !== this.requestedGeneration,
      requestedGeneration: this.requestedGeneration,
      handledGeneration: this.handledGeneration,
    };
  }

  async close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.resolveIdle?.();
    this.resolveIdle = null;
    await this.worker.close();
  }
}
