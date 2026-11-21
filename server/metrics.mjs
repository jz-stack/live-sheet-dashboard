export class LocalMetrics {
  constructor() {
    this.startedAt = new Date().toISOString();
    this.counters = {
      parseSuccess: 0,
      parseFailure: 0,
      parseRetries: 0,
      staleResults: 0,
      workerRestarts: 0,
      slowClients: 0,
      rejectedRequests: 0,
    };
    this.lastParseMs = 0;
    this.lastQueueWaitMs = 0;
    this.lastSuccessAt = null;
    this.lastError = null;
  }

  increment(name, amount = 1) {
    this.counters[name] = (this.counters[name] || 0) + amount;
  }

  success(parseMs, queueWaitMs) {
    this.increment('parseSuccess');
    this.lastParseMs = parseMs;
    this.lastQueueWaitMs = queueWaitMs;
    this.lastSuccessAt = new Date().toISOString();
    this.lastError = null;
  }

  failure(error) {
    this.increment('parseFailure');
    this.lastError = {
      at: new Date().toISOString(),
      code: error?.code || 'UNKNOWN',
      stage: error?.stage || 'unknown',
      message: error?.message || String(error),
    };
  }

  snapshot() {
    return {
      startedAt: this.startedAt,
      counters: { ...this.counters },
      lastParseMs: this.lastParseMs,
      lastQueueWaitMs: this.lastQueueWaitMs,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError ? { ...this.lastError } : null,
    };
  }
}
