import crypto from 'node:crypto';
import { AppError } from '../errors.mjs';

const AI_ERROR = (message, code, status = 502) => new AppError(message, { code, status, stage: 'ai' });

/**
 * LlmPort 的离线规则实现：不联网，基于 SchemaCard 与确定性规则产出合法结构。
 * 同时充当外部模型失败时的降级提供者。
 */
export class RuleProvider {
  constructor() {
    this.name = 'rule';
    this.model = 'rules-v1';
  }

  capabilities() {
    return { structuredOutput: true, streaming: false, external: false, repairable: false };
  }

  async complete(request) {
    const started = Date.now();
    let spec;
    if (request.task === 'chart') spec = ruleChart(request.context);
    else if (request.task === 'insight') spec = ruleInsight(request.context);
    else if (request.task === 'maintenance') spec = ruleMaintenance(request.context);
    else throw AI_ERROR(`规则提供者不支持任务类型：${request.task}`, 'AI_TASK_UNSUPPORTED', 400);
    return {
      provider: this.name,
      model: this.model,
      text: JSON.stringify(spec),
      usage: { inputTokens: 0, outputTokens: 0 },
      latencyMs: Date.now() - started,
      requestId: crypto.randomUUID(),
    };
  }
}

/** 匹配 OpenAI 兼容接口（DeepSeek、通义兼容模式等）。密钥只存在于服务端。 */
export class OpenAiCompatibleProvider {
  constructor({ baseUrl, apiKey, model, allowedHosts, fetchImpl = fetch, logger = null }) {
    this.name = 'openai-compatible';
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.model = model;
    this.allowedHosts = new Set(allowedHosts || []);
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.endpoint = this.baseUrl.endsWith('/chat/completions')
      ? this.baseUrl
      : `${this.baseUrl}/chat/completions`;
    let host = '';
    try { host = new URL(this.endpoint).hostname; } catch { host = ''; }
    if (!host || !this.allowedHosts.has(host)) {
      throw AI_ERROR(`模型服务地址不在白名单内：${host || '无效地址'}`, 'AI_BASE_URL_FORBIDDEN', 500);
    }
  }

  capabilities() {
    return { structuredOutput: true, streaming: false, external: true, repairable: true };
  }

  async complete(request, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort(new AppError('模型调用超时', { code: 'AI_TIMEOUT', status: 504, stage: 'ai' }));
    const timer = setTimeout(abort, request.timeoutMs);
    const onExternalAbort = () => controller.abort();
    signal?.addEventListener('abort', onExternalAbort, { once: true });
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: request.model || this.model,
          messages: [
            { role: 'system', content: request.instructions },
            { role: 'user', content: JSON.stringify(request.context) },
          ],
          temperature: request.temperature,
          max_tokens: request.maxOutputTokens,
          response_format: { type: 'json_object' },
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        const code = response.status === 429 ? 'AI_RATE_LIMIT'
          : response.status === 401 || response.status === 403 ? 'AI_AUTH'
            : 'AI_HTTP_ERROR';
        throw AI_ERROR(`模型服务返回 ${response.status}${detail ? `：${detail.slice(0, 200)}` : ''}`, code, 502);
      }
      const payload = await response.json();
      const text = payload?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw AI_ERROR('模型返回了空内容', 'AI_EMPTY_OUTPUT');
      return {
        provider: this.name,
        model: payload?.model || this.model,
        text,
        usage: payload?.usage ? { inputTokens: payload.usage.prompt_tokens, outputTokens: payload.usage.completion_tokens } : undefined,
        latencyMs: 0,
        requestId: payload?.id || crypto.randomUUID(),
      };
    } catch (error) {
      if (error.name === 'AbortError' || error.name === 'TimeoutError') {
        throw signal?.aborted
          ? AI_ERROR('任务已取消', 'AI_CANCELLED', 499)
          : AI_ERROR('模型调用超时', 'AI_TIMEOUT', 504);
      }
      if (error.cause?.code === 'ENOTFOUND' || error.cause?.code === 'ECONNREFUSED' || error.code === 'fetch failed') {
        throw AI_ERROR('无法连接模型服务', 'AI_NETWORK', 502);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }
}

/** 自动化测试用：注入脚本化响应（合法输出、非法输出、超时、异常）。 */
export class MockProvider {
  constructor(respond) {
    this.name = 'mock';
    this.model = 'mock-1';
    this.respond = respond;
  }

  capabilities() {
    return { structuredOutput: true, streaming: false, external: true, repairable: true };
  }

  async complete(request, signal) {
    const text = await this.respond(request, signal);
    return {
      provider: this.name, model: this.model, text,
      usage: { inputTokens: 10, outputTokens: 10 }, latencyMs: 0, requestId: crypto.randomUUID(),
    };
  }
}

export function createProvider(config, { fetchImpl = fetch, logger = null } = {}) {
  if (config.AI.PROVIDER !== 'openai') return new RuleProvider();
  return new OpenAiCompatibleProvider({
    baseUrl: config.AI.BASE_URL,
    apiKey: config.AI.API_KEY,
    model: config.AI.MODEL,
    allowedHosts: config.AI.ALLOWED_HOSTS,
    fetchImpl,
    logger,
  });
}

// ---------------------------------------------------------------------------
// 离线规则：一句话建图
// ---------------------------------------------------------------------------

const CHART_TYPE_HINTS = [
  { type: 'line', words: ['趋势', '走势', '变化', '曲线', '按时间', '随时间', '按日', '按月', '每天', '每月'] },
  { type: 'pie', words: ['占比', '比例', '构成', '分布', '份额'] },
  { type: 'bar', words: ['排行', '排名', 'top', 'Top', 'TOP', '榜', '对比', '比较', '柱状'] },
  { type: 'kpi', words: ['总计', '总共', '合计', '总额', '整体', '总'] },
  { type: 'table', words: ['明细', '清单', '列表', '表格', '原始'] },
];

function matchColumns(card, text) {
  const hits = [];
  for (const column of card.columns || []) {
    if (column.name && text.includes(column.name)) hits.push(column);
  }
  return hits;
}

export function ruleChart(context) {
  const card = context?.schemaCard;
  const instruction = String(context?.instruction || '');
  if (!card || !card.columns?.length) throw AI_ERROR('当前没有可用的表结构', 'AI_NO_SCHEMA', 409);
  const text = instruction;
  const hits = matchColumns(card, text);
  const numberColumns = card.columns.filter((column) => column.type === 'number');
  const dateColumns = card.columns.filter((column) => column.type === 'date');
  const dimensionColumns = card.columns.filter((column) => column.type === 'string' || column.type === 'date');

  let type = null;
  for (const hint of CHART_TYPE_HINTS) {
    if (hint.words.some((word) => text.includes(word))) { type = hint.type; break; }
  }
  if (!type) type = dateColumns.length && !text.includes('按') ? 'bar' : dimensionColumns.length ? 'bar' : 'kpi';
  if (type === 'line' && !dateColumns.length) type = 'bar';
  if (type === 'pie' && !dimensionColumns.length) type = 'bar';

  const measure = hits.find((column) => column.type === 'number') || numberColumns[0] || null;
  const mentionedDimensions = hits.filter((column) => column.type !== 'number');
  const dimension = mentionedDimensions[0]
    || (type === 'line' ? dateColumns[0] : null)
    || dimensionColumns.find((column) => (column.distinct || 0) > 1 && (column.distinct || 0) <= 40)
    || dimensionColumns[0]
    || null;
  const series = mentionedDimensions[1] || dimensionColumns.find((column) => column !== dimension && (column.distinct || 0) > 1 && (column.distinct || 0) <= 12) || undefined;

  let agg = 'sum';
  if (/平均|均值|人均/.test(text)) agg = 'avg';
  else if (/最大|峰值|最高/.test(text)) agg = 'max';
  else if (/条数|记录数|计数|数量统计/.test(text)) agg = 'count';

  if ((type !== 'table' || type === 'kpi') && !measure && agg !== 'count') {
    throw AI_ERROR('没有找到可聚合的数值列，请确认指令或先补充数据', 'AI_NO_MEASURE', 422);
  }
  if (type !== 'kpi' && type !== 'table' && !dimension) {
    throw AI_ERROR('没有找到可用的维度列，试试指明按哪一列分组', 'AI_NO_DIMENSION', 422);
  }

  const encoding = type === 'kpi'
    ? { y: measure?.name, agg }
    : type === 'table'
      ? { agg: 'count' }
      : { x: dimension.name, y: measure?.name, agg, ...(series ? { series: series.name } : {}) };

  const title = buildTitle(type, dimension?.name, measure?.name, series?.name, agg);
  return {
    type, title, encoding,
    placement: { strategy: 'append' },
    rationale: `规则匹配：指令关键词指向「${type}」，维度列取「${dimension?.name || '—'}」，数值列取「${measure?.name || '计数'}」，聚合方式为 ${agg}。`,
  };
}

function buildTitle(type, dimension, measure, series, agg) {
  const aggLabel = { sum: '', avg: '平均', max: '最大', count: '计数' }[agg] || '';
  const measureLabel = measure ? `${aggLabel}${measure}` : '记录数';
  if (type === 'kpi') return `${measureLabel}（总计）`;
  if (type === 'table') return '数据明细';
  const seriesLabel = series ? ` · 按${series}拆分` : '';
  return `${measureLabel} · 按${dimension}${seriesLabel}`;
}

// ---------------------------------------------------------------------------
// 离线规则：自动洞察（模板话术，数字全部来自 AnalysisEvidence）
// ---------------------------------------------------------------------------

function formatNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value ?? '—');
  return String(Math.round(numeric * 100) / 100);
}

export function ruleInsight(context) {
  const evidence = context?.evidence;
  if (!evidence || !evidence.observations?.length) {
    throw AI_ERROR('当前数据没有显著变化，不生成洞察', 'AI_NO_EVIDENCE', 422);
  }
  const observations = evidence.observations.slice(0, 3);
  const parts = [];
  let severity = 'info';
  for (const observation of observations) {
    if (observation.type === 'period-change') {
      const pct = Number(observation.comparisons?.pct);
      const direction = pct < 0 ? '下降' : '上升';
      parts.push(`「${observation.values.metric}」最新一期为 ${formatNumber(Number(observation.values.current))}，环比${direction} ${formatNumber(Math.abs(pct))}%`);
      if (pct <= -20) severity = 'warning';
      if (pct <= -50) severity = 'critical';
    } else if (observation.type === 'streak') {
      parts.push(`已连续 ${observation.values.length} 期${Number(observation.values.direction) < 0 ? '下滑' : '上升'}`);
      if (Number(observation.values.direction) < 0 && Number(observation.values.length) >= 3) severity = 'warning';
    } else if (observation.type === 'outlier') {
      parts.push(`${observation.values.key} 显著偏离常态（${formatNumber(Number(observation.values.z))}σ）`);
      severity = severity === 'critical' ? 'critical' : 'warning';
    } else if (observation.type === 'contribution' && observation.ranking?.length) {
      const top = observation.ranking[0];
      parts.push(`主要影响来自 ${top.key}（贡献 ${formatNumber(Number(top.contribution))}%）`);
    } else if (observation.type === 'data-quality') {
      parts.push(String(observation.values.message || '数据质量需要关注'));
    }
  }
  if (!parts.length) throw AI_ERROR('证据类型无法生成文案', 'AI_NO_EVIDENCE', 422);
  return {
    evidenceId: evidence.evidenceId,
    severity,
    title: `数据快照 v${evidence.datasetVersion} 洞察`,
    statement: parts.join('；') + '。',
    observationRefs: observations.map((observation) => observation.id),
    suggestedAction: severity === 'info' ? undefined : '可查看主图最近几期的变化，确认是否为真实业务波动。',
  };
}

// ---------------------------------------------------------------------------
// 离线规则：看板自维护（只提出建议，不直接修改 Document）
// ---------------------------------------------------------------------------

export function ruleMaintenance(context) {
  const digest = context?.documentDigest;
  const card = context?.schemaCard;
  if (!digest || !card) throw AI_ERROR('缺少画布或表结构上下文', 'AI_NO_CONTEXT', 409);
  const columns = card.columns || [];
  const numbers = columns.filter((column) => column.type === 'number' && (column.distinct || 0) > 1);
  const dimensions = columns.filter((column) => (column.type === 'string' || column.type === 'date') && (column.distinct || 0) > 1);
  const patches = [];
  const problematic = (digest.components || []).filter((component) => component.status === 'degraded' || component.status === 'invalid');
  for (const component of problematic) {
    const encoding = component.encoding || {};
    if (component.status === 'degraded' && component.statusReason?.includes('系列列')) {
      const missing = encoding.series;
      const alternative = dimensions.find((column) => column.name !== encoding.x && (column.distinct || 0) <= 12);
      patches.push({
        op: 'remap', componentId: component.id, field: 'series',
        value: alternative ? alternative.name : null,
        reason: `系列列「${missing}」已不存在，${alternative ? `建议改用「${alternative.name}」拆分` : '建议改为单系列展示'}`,
      });
      continue;
    }
    if (component.status === 'invalid') {
      const xOk = dimensions.some((column) => column.name === encoding.x);
      const yOk = numbers.some((column) => column.name === encoding.y);
      if (!xOk && component.type !== 'kpi' && dimensions.length) {
        patches.push({
          op: 'remap', componentId: component.id, field: 'x',
          value: dimensions.find((column) => (column.distinct || 0) <= 40)?.name || dimensions[0].name,
          reason: `维度列「${encoding.x || '未配置'}」不可用，建议改用现有维度列`,
        });
      } else if (!yOk && numbers.length && component.encoding?.agg !== 'count') {
        patches.push({
          op: 'remap', componentId: component.id, field: 'y',
          value: numbers[0].name,
          reason: `数值列「${encoding.y || '未配置'}」不可用，建议改用「${numbers[0].name}」`,
        });
      } else {
        patches.push({
          op: 'remove', componentId: component.id,
          reason: component.statusReason || '组件配置无效且没有兼容列可替换',
        });
      }
    }
  }
  if (!patches.length) {
    return { summary: '画布组件状态正常，没有需要维护的项目。', patches: [], confidence: 'high' };
  }
  return {
    summary: `发现 ${problematic.length} 个异常组件，建议按以下方式修复（不会自动生效，需人工采纳）。`,
    patches: patches.slice(0, 5),
    confidence: 'medium',
  };
}
