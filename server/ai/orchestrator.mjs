import crypto from 'node:crypto';
import { AppError } from '../errors.mjs';
import { buildSchemaCard, buildDocumentDigest } from './schema-card.mjs';
import { analyzeSnapshot } from './analysis.mjs';
import { buildInstructions, cacheKey, PROMPT_VERSION } from './prompt.mjs';
import { parseModelJson, validateChartSpec, validateInsightSpec, validateMaintenanceSpec } from './protocols.mjs';
import { RuleProvider, createProvider, ruleChart, ruleInsight, ruleMaintenance } from './providers.mjs';
import { dryRunPatch } from '../patch.mjs';
import { projectSpec } from '../component-projection.mjs';

const MAX_CACHE_ENTRIES = 100;
const MAX_INSIGHTS = 12;
const MAX_SUGGESTIONS = 20;

const AI_ERROR = (message, code, status = 500) => new AppError(message, { code, status, stage: 'ai' });
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);

function normalizeInstruction(instruction) {
  return String(instruction || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200);
}

/**
 * AI 编排器：所有模型调用都经过这里——缓存、并发、超时、一次修复、
 * 校验与降级。它只产出“建议”，修改 Document 必须经过人工采纳。
 */
export class AiOrchestrator {
  constructor({ config, logger, metrics, repository, documents, notifier, provider = null, fetchImpl }) {
    this.config = config;
    this.logger = logger;
    this.metrics = metrics;
    this.repository = repository;
    this.documents = documents;
    this.notifier = notifier;
    this.provider = provider || createProvider(config, { fetchImpl });
    this.fallback = new RuleProvider();
    this.tasks = new Map();
    this.suggestions = new Map();
    this.insights = [];
    this.cache = new Map();
    this.previewCache = new Map();
    this.inFlight = 0;
    this.waitQueue = [];
    this.controllers = new Set();
    this.modelCalls = 0;
    this.lastAutoInsightAt = 0;
    this.lastAutoMaintenanceAt = 0;
    this.lastEvidenceHash = null;
    this.closed = false;
  }

  capabilities() {
    const caps = this.provider.capabilities();
    return {
      provider: this.provider.name,
      model: this.provider.model,
      structuredOutput: caps.structuredOutput,
      external: Boolean(caps.external),
      privacyMode: caps.external ? 'schema-only' : 'local-only',
      promptVersion: PROMPT_VERSION,
      autoInsight: this.config.AI.AUTO_INSIGHT,
      budget: { used: this.modelCalls, limit: this.config.AI.MAX_DAILY_TASKS },
    };
  }

  status() {
    return {
      provider: this.provider.name,
      model: this.provider.model,
      external: this.provider.capabilities().external,
      tasks: this.tasks.size,
      pendingSuggestions: [...this.suggestions.values()].filter((item) => item.state === 'pending').length,
      currentInsights: this.insights.filter((item) => !item.stale).length,
      inFlight: this.inFlight,
      modelCalls: this.modelCalls,
    };
  }

  // -------------------------------------------------------------------------
  // 一句话建图
  // -------------------------------------------------------------------------

  async chart(instruction) {
    const snapshot = this.repository.snapshot();
    if (snapshot.status !== 'ready' || !snapshot.schema?.length) {
      throw AI_ERROR('数据尚未就绪，无法建图', 'AI_DATASET_NOT_READY', 409);
    }
    const normalized = normalizeInstruction(instruction);
    if (!normalized) throw AI_ERROR('请输入建图指令', 'INVALID_INSTRUCTION', 400);
    const card = buildSchemaCard(snapshot, { includeSamples: this.config.AI.INCLUDE_SAMPLES });
    const digest = buildDocumentDigest(this.documents.getCurrent(), this.documents.project(snapshot));
    const task = this._newTask({
      kind: 'chart', trigger: 'user',
      datasetVersion: snapshot.version,
      documentRevision: digest.documentRevision,
      inputHash: hash(normalized + card.schemaHash),
    });
    this._broadcastTask(task);

    const key = cacheKey('chart', [normalized, card.schemaHash]);
    const context = { schemaCard: card, instruction: String(instruction).trim(), documentDigest: digest };
    let spec;
    const cached = this.cache.get(key);
    if (cached) {
      task.status = 'succeeded';
      task.cached = true;
      this.metrics.increment('aiCacheHits');
      spec = cached;
    } else {
      spec = await this._runModelTask(task, 'chart', context, (value) => validateChartSpec(value, card, digest));
      this.cache.set(key, spec);
    }
    task.finishedAt = new Date().toISOString();
    this._broadcastTask(task);
    const suggestion = this._storeChartSuggestion(spec, digest, task, snapshot);
    return { task: this._taskView(task), suggestion };
  }

  _storeChartSuggestion(spec, digest, task, snapshot) {
    const patches = [];
    if (spec.placement.strategy === 'replace' && spec.placement.targetId) {
      patches.push({
        op: 'remove', componentId: spec.placement.targetId,
        origin: 'ai', reason: spec.rationale || `替换为「${spec.title}」`,
      });
    }
    patches.push({
      op: 'add',
      spec: { type: spec.type, title: spec.title, encoding: spec.encoding },
      origin: 'ai', reason: spec.rationale || '一句话建图',
    });
    return this._storeSuggestion({
      kind: 'chart', taskId: task.id, patches,
      summary: `建议${spec.placement.strategy === 'replace' ? '替换' : '新增'}「${spec.title}」（${spec.type}）`,
      detail: { type: spec.type, title: spec.title, encoding: spec.encoding, rationale: spec.rationale },
      datasetVersion: snapshot.version,
      documentRevision: digest.documentRevision,
      schemaHash: buildSchemaCard(snapshot).schemaHash,
    });
  }

  // -------------------------------------------------------------------------
  // 自动洞察
  // -------------------------------------------------------------------------

  async insightScan({ auto = false } = {}) {
    const snapshot = this.repository.snapshot();
    if (snapshot.status !== 'ready' || !snapshot.rows?.length) {
      return { ok: true, count: 0, reason: '数据未就绪' };
    }
    const evidence = analyzeSnapshot(snapshot);
    if (!evidence.observations.length) {
      return { ok: true, count: 0, reason: '当前数据没有显著证据' };
    }
    const evidenceHash = hash(JSON.stringify(evidence.observations));
    if (auto) {
      if (evidenceHash === this.lastEvidenceHash) {
        return { ok: true, count: 0, reason: '证据未变化', cached: true };
      }
      if (Date.now() - this.lastAutoInsightAt < this.config.AI.INSIGHT_COOLDOWN_MS) {
        return { ok: true, count: 0, reason: '冷却中', skipped: 'cooldown' };
      }
      if (!isSignificant(evidence)) {
        this.lastEvidenceHash = evidenceHash;
        return { ok: true, count: 0, reason: '变化不显著', skipped: 'insignificant' };
      }
    }
    this.lastAutoInsightAt = Date.now();
    this.lastEvidenceHash = evidenceHash;

    const card = buildSchemaCard(snapshot, { includeSamples: this.config.AI.INCLUDE_SAMPLES });
    const task = this._newTask({
      kind: 'insight', trigger: auto ? 'metric-anomaly' : 'user',
      datasetVersion: snapshot.version,
      documentRevision: this.documents.getCurrent().revision,
      inputHash: evidenceHash,
    });
    this._broadcastTask(task);
    const context = { schemaCard: card, evidence };
    const key = cacheKey('insight', [evidenceHash]);
    let spec;
    const cached = this.cache.get(key);
    if (cached) {
      task.status = 'succeeded';
      task.cached = true;
      this.metrics.increment('aiCacheHits');
      spec = cached;
    } else {
      spec = await this._runModelTask(task, 'insight', context, (value) => validateInsightSpec(value, evidence));
      this.cache.set(key, spec);
    }
    task.finishedAt = new Date().toISOString();
    this._broadcastTask(task);

    for (const insight of this.insights) insight.stale = true;
    const record = {
      insightId: crypto.randomUUID(),
      severity: spec.severity,
      title: spec.title,
      statement: spec.statement,
      observationRefs: spec.observationRefs,
      suggestedAction: spec.suggestedAction,
      datasetVersion: snapshot.version,
      evidence,
      createdAt: new Date().toISOString(),
      stale: false,
    };
    this.insights.unshift(record);
    if (this.insights.length > MAX_INSIGHTS) this.insights.length = MAX_INSIGHTS;
    this.notifier.broadcast('ai-insight', this._insightView(record));
    this.logger.info('AI 洞察已生成', { task: task.id, severity: record.severity, datasetVersion: record.datasetVersion });
    return { ok: true, count: 1, insight: this._insightView(record) };
  }

  // -------------------------------------------------------------------------
  // 看板自维护
  // -------------------------------------------------------------------------

  async maintenanceScan({ auto = false } = {}) {
    const snapshot = this.repository.snapshot();
    if (snapshot.status !== 'ready' || !snapshot.schema?.length) {
      return { ok: true, reason: '数据未就绪', count: 0 };
    }
    const projection = this.documents.project(snapshot);
    const digest = buildDocumentDigest(this.documents.getCurrent(), projection);
    const problematic = digest.components.filter((component) => component.status === 'degraded' || component.status === 'invalid');
    if (!problematic.length) return { ok: true, reason: '画布组件状态正常', count: 0 };
    if (auto && Date.now() - this.lastAutoMaintenanceAt < this.config.AI.MAINTENANCE_COOLDOWN_MS) {
      return { ok: true, reason: '冷却中', skipped: 'cooldown', count: 0 };
    }
    this.lastAutoMaintenanceAt = Date.now();

    const card = buildSchemaCard(snapshot, { includeSamples: this.config.AI.INCLUDE_SAMPLES });
    const task = this._newTask({
      kind: 'maintenance', trigger: auto ? 'component-status' : 'user',
      datasetVersion: snapshot.version,
      documentRevision: digest.documentRevision,
      inputHash: hash(digest.documentRevision + JSON.stringify(problematic.map((component) => [component.id, component.status]))),
    });
    this._broadcastTask(task);
    const context = { schemaCard: card, documentDigest: digest };
    const key = cacheKey('maintenance', [String(digest.documentRevision), task.inputHash]);
    let spec;
    const cached = this.cache.get(key);
    if (cached) {
      task.status = 'succeeded';
      task.cached = true;
      this.metrics.increment('aiCacheHits');
      spec = cached;
    } else {
      spec = await this._runModelTask(task, 'maintenance', context, (value) => validateMaintenanceSpec(value, digest));
      this.cache.set(key, spec);
    }
    task.finishedAt = new Date().toISOString();
    this._broadcastTask(task);
    if (!spec.patches.length) return { ok: true, count: 0, reason: spec.summary, task: this._taskView(task) };
    const suggestion = this._storeSuggestion({
      kind: 'maintenance', taskId: task.id,
      patches: spec.patches.map((patch) => ({ ...patch, origin: 'ai' })),
      summary: spec.summary,
      detail: { confidence: spec.confidence, components: problematic.map((component) => ({ id: component.id, title: component.title, status: component.status, statusReason: component.statusReason })) },
      datasetVersion: snapshot.version,
      documentRevision: digest.documentRevision,
      schemaHash: card.schemaHash,
    });
    return { ok: true, count: 1, suggestion, task: this._taskView(task) };
  }

  // -------------------------------------------------------------------------
  // 建议审阅
  // -------------------------------------------------------------------------

  acceptSuggestion(id) {
    const suggestion = this.suggestions.get(id);
    if (!suggestion) throw AI_ERROR('建议不存在', 'AI_SUGGESTION_NOT_FOUND', 404);
    if (suggestion.state !== 'pending') throw AI_ERROR(`建议当前状态为 ${suggestion.state}，不能采纳`, 'AI_SUGGESTION_NOT_PENDING', 409);

    const snapshot = this.repository.snapshot();
    const currentCard = snapshot.schema?.length ? buildSchemaCard(snapshot, { includeSamples: false }) : null;
    if (suggestion.schemaHash && currentCard && suggestion.schemaHash !== currentCard.schemaHash) {
      suggestion.state = 'stale';
      this.metrics.increment('aiStaleResults');
      throw AI_ERROR('表结构已变化，建议已过期，请重新生成', 'AI_SUGGESTION_STALE', 409);
    }
    if (suggestion.kind === 'maintenance' && this.documents.getCurrent().revision !== suggestion.documentRevision) {
      suggestion.state = 'stale';
      this.metrics.increment('aiStaleResults');
      throw AI_ERROR('画布已变化，维护建议已过期，请重新扫描', 'AI_SUGGESTION_STALE', 409);
    }

    const applied = [];
    try {
      for (const patch of suggestion.patches) {
        applied.push(this.documents.submit(patch));
      }
    } catch (error) {
      suggestion.state = 'invalid';
      this.logger.warn('AI 建议采纳失败', { code: error.code, message: error.message });
      throw AI_ERROR(`建议无法套用：${error.message}`, error.code || 'AI_PATCH_REJECTED', error.status || 400);
    }
    suggestion.state = 'accepted';
    suggestion.acceptedAt = new Date().toISOString();
    this.metrics.increment('aiSuggestionsAccepted');
    const document = this.documents.getCurrent();
    this.notifier.broadcast('document', { revision: document.revision, reason: '采纳 AI 建议' });
    this.logger.info('AI 建议已采纳', { suggestion: id, patches: suggestion.patches.length, revision: document.revision });
    return { ok: true, suggestion: this._suggestionView(suggestion), document };
  }

  rejectSuggestion(id) {
    const suggestion = this.suggestions.get(id);
    if (!suggestion) throw AI_ERROR('建议不存在', 'AI_SUGGESTION_NOT_FOUND', 404);
    if (suggestion.state !== 'pending') throw AI_ERROR(`建议当前状态为 ${suggestion.state}，不能重复处理`, 'AI_SUGGESTION_NOT_PENDING', 409);
    suggestion.state = 'rejected';
    suggestion.rejectedAt = new Date().toISOString();
    this.metrics.increment('aiSuggestionsRejected');
    return { ok: true, suggestion: this._suggestionView(suggestion) };
  }

  suggestionsView() {
    return [...this.suggestions.values()].map((item) => this._suggestionView(item));
  }

  /**
   * 数据源切换后，此前基于另一份 Schema 算出的建议不再可信：
   * 统一标记为 expired，避免画布上出现「对旧数据算出来的修复预览」。
   */
  expirePendingSuggestions(reason = '数据源已切换') {
    const now = new Date().toISOString();
    let expired = 0;
    for (const suggestion of this.suggestions.values()) {
      if (suggestion.state !== 'pending') continue;
      suggestion.state = 'expired';
      suggestion.rejectedAt = now;
      suggestion.expiredReason = reason;
      expired += 1;
    }
    if (expired) {
      this.previewCache.clear();
      this.notifier.broadcast('ai-suggestion', { state: 'expired', count: expired, reason });
      this.logger.info('已作废旧数据源下的 AI 建议', { count: expired, reason });
    }
    return expired;
  }

  insightsView() {
    return this.insights.map((item) => this._insightView(item));
  }

  taskView(id) {
    const task = this.tasks.get(id);
    if (!task) throw AI_ERROR('任务不存在', 'AI_TASK_NOT_FOUND', 404);
    return this._taskView(task);
  }

  cancelTask(id) {
    const task = this.tasks.get(id);
    if (!task) throw AI_ERROR('任务不存在', 'AI_TASK_NOT_FOUND', 404);
    if (task.status !== 'running' && task.status !== 'queued') {
      return { ok: true, task: this._taskView(task), note: '任务已结束' };
    }
    for (const controller of this.controllers) controller.abort();
    task.status = 'cancelled';
    task.finishedAt = new Date().toISOString();
    this._broadcastTask(task);
    return { ok: true, task: this._taskView(task) };
  }

  // -------------------------------------------------------------------------
  // 数据更新后的自动触发（绝不阻断主链路）
  // -------------------------------------------------------------------------

  async onDatasetUpdated() {
    if (this.closed) return;
    try {
      if (this.config.AI.AUTO_INSIGHT) await this.insightScan({ auto: true });
      await this.maintenanceScan({ auto: true });
    } catch (error) {
      this.metrics.increment('aiFallbacks');
      this.logger.warn('AI 自动任务失败，大屏不受影响', { code: error.code, message: error.message });
    }
  }

  close() {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }

  // -------------------------------------------------------------------------
  // 内部：模型调用、修复与降级
  // -------------------------------------------------------------------------

  async _runModelTask(task, kind, context, validator) {
    task.status = 'running';
    this._broadcastTask(task);
    const instructions = buildInstructions(kind, context);
    try {
      const spec = await this._callAndValidate(task, kind, instructions, context, validator);
      task.status = task.usedFallback ? 'fallback' : 'succeeded';
      return spec;
    } catch (error) {
      // 外部模型失败或输出非法：降级到离线规则；规则也无法给出结论时任务失败。
      task.error = safeError(error);
      try {
        const ruleSpec = kind === 'chart'
          ? validateChartSpec(ruleChart(context), context.schemaCard, context.documentDigest)
          : kind === 'insight'
            ? validateInsightSpec(ruleInsight(context), context.evidence)
            : validateMaintenanceSpec(ruleMaintenance(context), context.documentDigest);
        task.status = 'fallback';
        task.usedFallback = true;
        this.metrics.increment('aiFallbacks');
        this.logger.warn('AI 任务已降级到规则模式', { task: task.id, kind, code: error.code });
        return ruleSpec;
      } catch (fallbackError) {
        task.status = 'failed';
        task.error = safeError(fallbackError);
        this.metrics.increment('aiTasksFailed');
        const failure = new AppError(fallbackError.message || '未能生成可靠的配置', { code: fallbackError.code || 'AI_FAILED', status: fallbackError.status || 422, stage: 'ai' });
        failure.task = this._taskView(task);
        throw failure;
      }
    }
  }

  async _callAndValidate(task, kind, instructions, context, validator) {
    const response = await this._callProvider(kind, instructions, context);
    task.provider = response.provider;
    task.model = response.model;
    task.usage = response.usage;
    task.latencyMs = response.latencyMs;
    let parsed;
    try {
      parsed = parseModelJson(response.text);
      return validator(parsed);
    } catch (error) {
      this.metrics.increment('aiValidationFailures');
      if (!this.provider.capabilities().repairable) throw error;
      this.metrics.increment('aiRepairAttempts');
      const repairInstructions = `${instructions}\n\n上一次输出存在以下问题，请修正后重新输出完整 JSON：\n${error.message}`;
      const repairContext = { previousOutput: parsed ?? null, problem: { code: error.code, message: error.message } };
      const second = await this._callProvider(kind, repairInstructions, repairContext);
      const reparsed = parseModelJson(second.text);
      return validator(reparsed);
    }
  }

  async _callProvider(kind, instructions, context) {
    await this._acquire();
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const external = this.provider.capabilities().external;
      const budgetExceeded = this.modelCalls >= this.config.AI.MAX_DAILY_TASKS;
      if (external && budgetExceeded) {
        this.metrics.increment('aiBudgetRejects');
        return await this.fallback.complete({ task: kind, instructions, context, temperature: 0.2, maxOutputTokens: 800, timeoutMs: this.config.AI.TIMEOUT_MS });
      }
      const response = await this.provider.complete(
        { task: kind, instructions, context, temperature: 0.2, maxOutputTokens: 800, timeoutMs: this.config.AI.TIMEOUT_MS },
        controller.signal,
      );
      if (external) this.modelCalls += 1;
      return response;
    } finally {
      this.controllers.delete(controller);
      this._release();
    }
  }

  async _acquire() {
    if (this.inFlight < this.config.AI.CONCURRENCY) {
      this.inFlight += 1;
      return;
    }
    await new Promise((resolve) => this.waitQueue.push(resolve));
    this.inFlight += 1;
  }

  _release() {
    this.inFlight -= 1;
    const next = this.waitQueue.shift();
    if (next) next();
  }

  // -------------------------------------------------------------------------
  // 内部：任务、建议与视图
  // -------------------------------------------------------------------------

  _newTask({ kind, trigger, datasetVersion, documentRevision, inputHash }) {
    const task = {
      id: crypto.randomUUID(), kind, trigger,
      status: 'queued', instanceId: this.repository.instanceId,
      datasetVersion, documentRevision, inputHash,
      createdAt: new Date().toISOString(), finishedAt: null,
      provider: null, model: null, usage: null, latencyMs: null,
      cached: false, usedFallback: false, error: null,
    };
    this.tasks.set(task.id, task);
    if (this.tasks.size > 100) {
      const oldest = this.tasks.keys().next().value;
      if (this.tasks.get(oldest)?.status !== 'running') this.tasks.delete(oldest);
    }
    this.metrics.increment('aiTasksTotal');
    return task;
  }

  _storeSuggestion({ kind, taskId, patches, summary, detail, datasetVersion, documentRevision, schemaHash }) {
    const suggestion = {
      id: crypto.randomUUID(), kind, taskId, patches, summary, detail,
      datasetVersion, documentRevision, schemaHash,
      state: 'pending', createdAt: new Date().toISOString(),
      acceptedAt: null, rejectedAt: null,
    };
    this.suggestions.set(suggestion.id, suggestion);
    if (this.suggestions.size > MAX_SUGGESTIONS) {
      const entries = [...this.suggestions.entries()];
      const victim = (entries.find(([, item]) => item.state !== 'pending') || entries[0])[0];
      this.suggestions.delete(victim);
    }
    this.notifier.broadcast('ai-suggestion', { suggestionId: suggestion.id, kind: suggestion.kind, summary: suggestion.summary, state: suggestion.state, revision: documentRevision });
    this.logger.info('AI 建议待审阅', { suggestion: suggestion.id, kind, patches: patches.length });
    return this._suggestionView(suggestion);
  }

  /**
   * 画布预览：把建议里的 patch 在当前 Document 上 dry-run 一遍，再对新增/改动的
   * 组件做一次真实投影。前端据此直接把“套用后的图表”画在画布上，并配
   * 采用 / 撤销 操作，而不是用文字描述让用户自行想象效果。
   *
   * 结果按 (建议 id, 画布 revision, 数据版本) 缓存，数据刷新时自动重算。
   */
  _preview(suggestion) {
    const snapshot = this.repository.snapshot();
    if (!snapshot || snapshot.status !== 'ready' || !snapshot.schema?.length) {
      return { error: '数据尚未就绪，暂不能预览', steps: describePatches(suggestion.patches) };
    }
    const document = this.documents.getCurrent();
    const key = `${suggestion.id}:${document.revision}:${snapshot.instanceId}:${snapshot.version}`;
    const cached = this.previewCache.get(key);
    if (cached) return cached;

    const titles = new Map(document.components.map((component) => [component.id, component.title]));
    let value;
    try {
      let next = document;
      for (const patch of suggestion.patches) next = dryRunPatch(next, patch).document;
      for (const component of next.components) if (!titles.has(component.id)) titles.set(component.id, component.title);
      const before = new Map(document.components.map((component) => [component.id, component]));
      const survivorIds = new Set(next.components.map((component) => component.id));
      const added = [];
      const changed = [];
      for (const spec of next.components) {
        const previous = before.get(spec.id);
        if (!previous) added.push(projectSpec(snapshot, spec));
        else if (JSON.stringify(previous) !== JSON.stringify(spec)) changed.push(projectSpec(snapshot, spec));
      }
      const removed = document.components
        .filter((component) => !survivorIds.has(component.id))
        .map((component) => ({ id: component.id, title: component.title }));
      value = {
        added, changed, removed,
        addedComponents: added.map((item) => item.title),
        componentCount: next.components.length,
        grid: next.grid,
        steps: describePatches(suggestion.patches, titles),
        documentRevision: document.revision,
        datasetVersion: snapshot.version,
      };
    } catch (error) {
      value = { error: error.message, steps: describePatches(suggestion.patches, titles) };
    }
    this.previewCache.set(key, value);
    if (this.previewCache.size > 40) this.previewCache.delete(this.previewCache.keys().next().value);
    return value;
  }

  _taskView(task) {
    return {
      id: task.id, kind: task.kind, trigger: task.trigger, status: task.status,
      datasetVersion: task.datasetVersion, documentRevision: task.documentRevision,
      provider: task.provider, model: task.model, usage: task.usage, latencyMs: task.latencyMs,
      cached: task.cached, usedFallback: task.usedFallback, error: task.error,
      createdAt: task.createdAt, finishedAt: task.finishedAt,
    };
  }

  _suggestionView(suggestion) {
    return {
      id: suggestion.id, kind: suggestion.kind, taskId: suggestion.taskId,
      state: suggestion.state, summary: suggestion.summary, detail: suggestion.detail,
      preview: suggestion.state === 'pending' ? this._preview(suggestion) : null,
      patches: suggestion.patches.map((patch) => ({
        op: patch.op, componentId: patch.componentId || null, field: patch.field ?? null,
        value: patch.value ?? null, title: patch.title ?? null, reason: patch.reason || null,
        ...(patch.spec ? { spec: patch.spec } : {}),
      })),
      datasetVersion: suggestion.datasetVersion, documentRevision: suggestion.documentRevision,
      createdAt: suggestion.createdAt, acceptedAt: suggestion.acceptedAt, rejectedAt: suggestion.rejectedAt,
    };
  }

  _insightView(insight) {
    return {
      insightId: insight.insightId, severity: insight.severity, title: insight.title,
      statement: insight.statement, observationRefs: insight.observationRefs,
      suggestedAction: insight.suggestedAction, datasetVersion: insight.datasetVersion,
      stale: insight.stale, createdAt: insight.createdAt,
    };
  }

  _broadcastTask(task) {
    this.notifier.broadcast('ai-task', {
      taskId: task.id, kind: task.kind, status: task.status,
      datasetVersion: task.datasetVersion, cached: task.cached, usedFallback: task.usedFallback,
    });
  }
}

function describePatches(patches = [], titles = new Map()) {
  const label = { add: '新增', remove: '删除', move: '移动', resize: '缩放', remap: '改数据编码', retitle: '改标题', restyle: '改样式' };
  return patches.map((patch) => {
    const target = patch.spec?.title || patch.title || titles.get(patch.componentId) || '';
    const detail = patch.field ? ` · ${patch.field}` : '';
    return `${label[patch.op] || patch.op}${target ? `「${target}」` : ''}${detail}`;
  });
}

function isSignificant(evidence) {
  return evidence.observations.some((observation) => {
    if (observation.type === 'period-change') return Math.abs(Number(observation.comparisons?.pct) || 0) >= 5;
    if (observation.type === 'streak') return Number(observation.values.length) >= 3;
    if (observation.type === 'outlier') return true;
    if (observation.type === 'contribution') return observation.ranking?.some((item) => Math.abs(Number(item.contribution)) >= 30) || false;
    if (observation.type === 'data-quality') return true;
    return false;
  });
}

function safeError(error) {
  return { code: error?.code || 'UNKNOWN', message: error?.message || String(error) };
}
