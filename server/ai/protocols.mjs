const CHART_TYPES = new Set(['kpi', 'line', 'bar', 'pie', 'table']);
const AGGS = new Set(['sum', 'count', 'avg', 'max']);
const SEVERITIES = new Set(['info', 'warning', 'critical']);
const PATCH_OPS = new Set(['add', 'remove', 'move', 'resize', 'remap', 'retitle']);
const REMAP_FIELDS = new Set(['x', 'y', 'series', 'agg']);
const PLACEMENT_STRATEGIES = new Set(['append', 'replace', 'insert-row']);

export function invalid(message, code = 'AI_INVALID_OUTPUT') {
  return Object.assign(new Error(message), { code, aiValidation: true });
}

/**
 * 从模型文本中提取单个完整 JSON 对象：去除代码围栏与前后缀文字。
 * 不做正则猜测字段，解析失败直接交给修复流程。
 */
export function parseModelJson(text) {
  if (typeof text !== 'string' || !text.trim()) throw invalid('模型返回为空', 'AI_EMPTY_OUTPUT');
  let source = text.trim();
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) source = fenced[1].trim();
  const start = source.indexOf('{');
  if (start < 0) throw invalid('输出中没有 JSON 对象', 'AI_NO_JSON');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const candidate = source.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch (error) {
          throw invalid(`JSON 解析失败：${error.message}`, 'AI_BAD_JSON');
        }
      }
    }
  }
  throw invalid('JSON 对象不完整（可能被截断）', 'AI_TRUNCATED_JSON');
}

function rejectUnknown(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw invalid(`${label} 含未知字段「${key}」，只允许：${[...allowed].join(', ')}`);
  }
}

/** ChartSpec 结构与业务校验：列名必须来自 SchemaCard，禁止模型创造列名。 */
export function validateChartSpec(spec, schemaCard, digest = null) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw invalid('ChartSpec 必须是对象');
  rejectUnknown(spec, new Set(['type', 'title', 'encoding', 'placement', 'rationale']), 'ChartSpec');
  if (!CHART_TYPES.has(spec.type)) throw invalid(`不支持的图表类型：${spec.type}`);
  if (typeof spec.title !== 'string' || !spec.title.trim()) throw invalid('title 不能为空');
  if (spec.title.length > 120) throw invalid('title 过长（最多 120 字）');
  if (spec.rationale !== undefined && (typeof spec.rationale !== 'string' || spec.rationale.length > 300)) {
    throw invalid('rationale 必须是 300 字以内的字符串');
  }
  const encoding = spec.encoding;
  if (!encoding || typeof encoding !== 'object' || Array.isArray(encoding)) throw invalid('encoding 必须是对象');
  rejectUnknown(encoding, new Set(['x', 'y', 'series', 'agg']), 'encoding');
  if (!AGGS.has(encoding.agg)) throw invalid(`不支持的聚合方式：${encoding.agg}`);

  const columns = new Map((schemaCard?.columns || []).map((column) => [column.name, column]));
  const columnOr = (name, label) => {
    if (!columns.has(name)) throw invalid(`列「${name}」不存在，${label} 必须来自当前表结构`, 'AI_UNKNOWN_COLUMN');
    return columns.get(name);
  };
  if (encoding.x !== undefined && encoding.x !== null && encoding.x !== '') {
    const column = columnOr(encoding.x, 'encoding.x');
    if (spec.type !== 'kpi' && spec.type !== 'table' && column.type === 'number') {
      throw invalid(`维度列「${encoding.x}」是数值类型，不能用作 x 轴`);
    }
  }
  if (encoding.y !== undefined && encoding.y !== null && encoding.y !== '') {
    const column = columnOr(encoding.y, 'encoding.y');
    if (column.type !== 'number') throw invalid(`数值列「${encoding.y}」不是 number 类型`);
  }
  if (encoding.series !== undefined && encoding.series !== null && encoding.series !== '') {
    columnOr(encoding.series, 'encoding.series');
  }
  if (spec.type !== 'kpi' && spec.type !== 'table') {
    if (!encoding.x) throw invalid(`${spec.type} 组件需要 encoding.x`);
    if (!encoding.y && encoding.agg !== 'count') throw invalid(`${spec.type} 组件需要数值列 encoding.y`);
  }
  if (spec.type === 'kpi' && encoding.agg !== 'count' && !encoding.y) throw invalid('该聚合方式需要数值列');

  let placement = null;
  if (spec.placement !== undefined && spec.placement !== null) {
    placement = spec.placement;
    if (typeof placement !== 'object' || Array.isArray(placement)) throw invalid('placement 必须是对象');
    rejectUnknown(placement, new Set(['strategy', 'targetId']), 'placement');
    if (!PLACEMENT_STRATEGIES.has(placement.strategy)) throw invalid(`不支持的布局策略：${placement.strategy}`);
    if (placement.strategy === 'replace') {
      if (!placement.targetId) throw invalid('replace 策略必须指定 targetId');
      if (digest && !digest.components.some((component) => component.id === placement.targetId)) {
        throw invalid(`目标组件不存在：${placement.targetId}`, 'AI_UNKNOWN_COMPONENT');
      }
    }
  }
  return {
    type: spec.type,
    title: spec.title.trim(),
    encoding: {
      ...(encoding.x ? { x: encoding.x } : {}),
      ...(encoding.y ? { y: encoding.y } : {}),
      ...(encoding.series ? { series: encoding.series } : {}),
      agg: encoding.agg,
    },
    placement: placement || { strategy: 'append' },
    rationale: spec.rationale,
  };
}

/** InsightSpec 校验：引用必须来自证据，数字必须可追溯。 */
export function validateInsightSpec(spec, evidence) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw invalid('InsightSpec 必须是对象');
  rejectUnknown(spec, new Set(['evidenceId', 'severity', 'title', 'statement', 'observationRefs', 'suggestedAction']), 'InsightSpec');
  if (spec.evidenceId !== evidence.evidenceId) throw invalid('evidenceId 与当前证据不匹配');
  if (!SEVERITIES.has(spec.severity)) throw invalid(`不支持的严重级别：${spec.severity}`);
  if (typeof spec.title !== 'string' || !spec.title.trim() || spec.title.length > 80) throw invalid('title 必须是 80 字以内的字符串');
  if (typeof spec.statement !== 'string' || !spec.statement.trim() || spec.statement.length > 400) throw invalid('statement 必须是 400 字以内的字符串');
  const observationIds = new Set(evidence.observations.map((observation) => observation.id));
  if (!Array.isArray(spec.observationRefs) || !spec.observationRefs.length) throw invalid('observationRefs 不能为空');
  for (const ref of spec.observationRefs) {
    if (!observationIds.has(ref)) throw invalid(`引用的观察不存在：${ref}`);
  }
  if (spec.suggestedAction !== undefined && (typeof spec.suggestedAction !== 'string' || spec.suggestedAction.length > 200)) {
    throw invalid('suggestedAction 必须是 200 字以内的字符串');
  }
  assertNumbersTraceable(spec.statement, evidence);
  return {
    evidenceId: spec.evidenceId,
    severity: spec.severity,
    title: spec.title.trim(),
    statement: spec.statement.trim(),
    observationRefs: spec.observationRefs,
    suggestedAction: spec.suggestedAction,
  };
}

/** MaintenanceSpec 校验：patch 数量与目标组件受限，真正的合法性交给 dry-run。 */
export function validateMaintenanceSpec(spec, digest) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw invalid('MaintenanceSpec 必须是对象');
  rejectUnknown(spec, new Set(['summary', 'patches', 'confidence']), 'MaintenanceSpec');
  if (typeof spec.summary !== 'string' || !spec.summary.trim() || spec.summary.length > 300) throw invalid('summary 必须是 300 字以内的字符串');
  if (!['low', 'medium', 'high'].includes(spec.confidence)) throw invalid('confidence 必须是 low/medium/high');
  if (!Array.isArray(spec.patches)) throw invalid('patches 必须是数组');
  if (spec.patches.length > 5) throw invalid('单次维护建议最多 5 个 Patch');
  const componentIds = new Set(digest.components.map((component) => component.id));
  const patches = spec.patches.map((patch) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalid('patch 必须是对象');
    rejectUnknown(patch, new Set(['op', 'componentId', 'spec', 'field', 'value', 'to', 'title', 'reason']), '维护 patch');
    if (!PATCH_OPS.has(patch.op)) throw invalid(`不支持的 Patch 操作：${patch.op}`);
    if (typeof patch.reason !== 'string' || !patch.reason.trim()) throw invalid('每个维护 patch 必须说明 reason');
    if (patch.op === 'add') {
      if (!patch.spec || typeof patch.spec !== 'object') throw invalid('add 操作必须携带 spec');
    } else if (patch.op === 'move' || patch.op === 'resize') {
      if (!patch.to || typeof patch.to !== 'object') throw invalid(`${patch.op} 操作必须携带 to`);
    } else if (patch.op === 'remap') {
      if (!REMAP_FIELDS.has(patch.field)) throw invalid(`不允许的 remap 字段：${patch.field}`);
    } else if (patch.op === 'retitle') {
      if (typeof patch.title !== 'string' || !patch.title.trim()) throw invalid('retitle 必须携带 title');
    }
    if (patch.op !== 'add' && !componentIds.has(patch.componentId)) {
      throw invalid(`目标组件不存在：${patch.componentId}`, 'AI_UNKNOWN_COMPONENT');
    }
    if (patch.op === 'remove' && !digest.components.some((component) => component.id === patch.componentId && component.status === 'invalid')) {
      throw invalid('remove 只允许针对状态为 invalid 的组件', 'AI_REMOVE_NOT_ALLOWED');
    }
    return { ...patch, reason: patch.reason.trim().slice(0, 300) };
  });
  return { summary: spec.summary.trim(), patches, confidence: spec.confidence };
}

/**
 * 数值忠实性检查：statement 中出现的数字必须能在证据中找到（两位小数容差）。
 * 这是“模型不能心算数字”的硬约束。
 */
export function assertNumbersTraceable(statement, evidence) {
  const allowed = new Set();
  const collect = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      allowed.add(normalizeNumber(value));
      allowed.add(normalizeNumber(Math.abs(value)));
    }
    if (typeof value === 'string' && value.length <= 40) allowed.add(value);
  };
  for (const observation of evidence.observations || []) {
    for (const value of Object.values(observation.values || {})) collect(value);
    for (const value of Object.values(observation.comparisons || {})) collect(value);
    for (const item of observation.ranking || []) {
      collect(item.key);
      collect(item.contribution);
    }
  }
  const tokens = String(statement).match(/-?\d+(?:\.\d+)?/g) || [];
  for (const token of tokens) {
    const numeric = Number(token);
    if (!allowed.has(normalizeNumber(numeric))) {
      throw invalid(`文案中的数字「${token}」无法在证据中找到，模型不得自行计算数值`, 'AI_UNTRACEABLE_NUMBER');
    }
  }
}

function normalizeNumber(value) {
  return String(Math.round(Number(value) * 100) / 100);
}
