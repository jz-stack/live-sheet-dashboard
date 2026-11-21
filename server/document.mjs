import crypto from 'node:crypto';
import { AppError } from './errors.mjs';
import { SHEET_COLUMN } from './parser.mjs';

export const COMPONENT_TYPES = new Set(['kpi', 'line', 'bar', 'pie', 'table', 'text']);
export const AGGREGATIONS = new Set(['sum', 'count', 'avg', 'max']);
export const DEFAULT_GRID = Object.freeze({ columns: 12, rowHeight: 72, gap: 12, padding: 12 });

export function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function bad(message, code = 'INVALID_DOCUMENT') {
  throw new AppError(message, { code, status: 400, stage: 'document' });
}

function cleanText(value, fallback, max = 120) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') bad('文本字段必须是字符串');
  return value.trim().slice(0, max) || fallback;
}

export function validateSpan(span, grid = DEFAULT_GRID, { allowMissing = false } = {}) {
  if (!span && allowMissing) return null;
  if (!span || typeof span !== 'object') bad('组件缺少栅格位置', 'INVALID_GRID_SPAN');
  const result = {};
  for (const key of ['row', 'col', 'rowSpan', 'colSpan']) {
    if (!Number.isInteger(span[key])) bad(`栅格 ${key} 必须是整数`, 'INVALID_GRID_SPAN');
    result[key] = span[key];
  }
  if (result.row < 0 || result.col < 0 || result.rowSpan < 1 || result.colSpan < 1) {
    bad('栅格位置与大小必须为正数', 'INVALID_GRID_SPAN');
  }
  if (result.col + result.colSpan > grid.columns) bad('组件超出画布列数', 'GRID_OUT_OF_BOUNDS');
  if (result.row > 1000 || result.rowSpan > 100) bad('组件行位置超出限制', 'GRID_OUT_OF_BOUNDS');
  return result;
}

export function validateGrid(grid = DEFAULT_GRID) {
  const merged = { ...DEFAULT_GRID, ...(grid || {}) };
  for (const key of ['columns', 'rowHeight', 'gap', 'padding']) {
    if (!Number.isFinite(merged[key]) || merged[key] < 0) bad(`画布参数 ${key} 无效`, 'INVALID_GRID');
  }
  if (!Number.isInteger(merged.columns) || merged.columns < 1 || merged.columns > 24) bad('画布列数须为 1-24', 'INVALID_GRID');
  if (merged.rowHeight < 32 || merged.rowHeight > 300 || merged.gap > 60 || merged.padding > 100) bad('画布尺寸超出允许范围', 'INVALID_GRID');
  return merged;
}

export function validateEncoding(encoding = {}, type) {
  if (!encoding || typeof encoding !== 'object' || Array.isArray(encoding)) bad('组件编码必须是对象', 'INVALID_ENCODING');
  const result = { agg: encoding.agg || (type === 'table' || type === 'text' ? 'count' : 'sum') };
  for (const field of ['x', 'y', 'series']) {
    if (encoding[field] !== undefined && encoding[field] !== null && encoding[field] !== '') {
      if (typeof encoding[field] !== 'string') bad(`编码字段 ${field} 必须是列名`, 'INVALID_ENCODING');
      result[field] = encoding[field].slice(0, 200);
    }
  }
  if (!AGGREGATIONS.has(result.agg)) bad('不支持的聚合方式', 'INVALID_AGGREGATION');
  if (encoding.filter !== undefined && encoding.filter !== null) {
    const filter = encoding.filter;
    if (typeof filter !== 'object' || typeof filter.field !== 'string' || !['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'notin'].includes(filter.op)) {
      bad('过滤条件无效', 'INVALID_FILTER');
    }
    result.filter = { field: filter.field, op: filter.op, value: clone(filter.value) };
  }
  return result;
}

export function validateComponentSpec(spec, grid = DEFAULT_GRID, { allowMissingSpan = false } = {}) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) bad('组件定义必须是对象', 'INVALID_COMPONENT');
  if (!COMPONENT_TYPES.has(spec.type)) bad('不支持的组件类型', 'INVALID_COMPONENT_TYPE');
  const result = {
    id: cleanText(spec.id, crypto.randomUUID(), 80).replace(/[^a-zA-Z0-9_-]/g, '-'),
    type: spec.type,
    title: cleanText(spec.title, '未命名组件'),
    span: validateSpan(spec.span, grid, { allowMissing: allowMissingSpan }),
    encoding: validateEncoding(spec.encoding || {}, spec.type),
  };
  if (spec.style !== undefined && spec.style !== null) {
    if (typeof spec.style !== 'object' || Array.isArray(spec.style)) bad('组件样式必须是对象', 'INVALID_STYLE');
    result.style = {};
    if (spec.style.accent !== undefined) {
      if (typeof spec.style.accent !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(spec.style.accent)) bad('强调色须为 #RRGGBB', 'INVALID_STYLE');
      result.style.accent = spec.style.accent;
    }
  }
  if (spec.type === 'text') result.text = cleanText(spec.text, spec.title || '', 2000);
  return result;
}

export function spansOverlap(a, b) {
  return a.col < b.col + b.colSpan && a.col + a.colSpan > b.col && a.row < b.row + b.rowSpan && a.row + a.rowSpan > b.row;
}

export function assertNoOverlap(components, candidate, ignoreId = null) {
  for (const component of components) {
    if (component.id === ignoreId || !component.span) continue;
    if (spansOverlap(component.span, candidate)) bad(`组件与「${component.title}」重叠`, 'GRID_OVERLAP');
  }
}

export function findFreeSpan(document, { colSpan = 6, rowSpan = 4 } = {}) {
  const grid = document.grid;
  const spanSize = { colSpan: Math.min(colSpan, grid.columns), rowSpan };
  for (let row = 0; row <= 1000; row += 1) {
    for (let col = 0; col + spanSize.colSpan <= grid.columns; col += 1) {
      const candidate = { row, col, ...spanSize };
      if (!document.components.some((component) => component.span && spansOverlap(component.span, candidate))) return candidate;
    }
  }
  bad('画布没有可用位置', 'GRID_FULL');
}

export function createEmptyDocument() {
  const now = new Date().toISOString();
  return {
    id: 'main', name: '实时数据大屏', datasetId: null, schemaVersion: 1,
    grid: { ...DEFAULT_GRID }, components: [], patches: [], revision: 0,
    createdAt: now, updatedAt: now,
  };
}

// 办公表的第一个数值列经常是「数量」「单价」这类过程量，直接拿来当主指标会看不出业务规模。
// 按下面顺序找「最像结果口径」的列，找不到再退回第一列。
const MEASURE_KEYWORDS = [
  '销售额', '金额', '收入', '营收', '毛利', '利润', '成本', '费用',
  '工资', '月薪', '总额', '余额', '数量', '工时', '时长', '评分',
];

function pickMeasure(numbers) {
  for (const keyword of MEASURE_KEYWORDS) {
    const hit = numbers.find((column) => column.name.includes(keyword));
    if (hit) return hit;
  }
  return numbers[0] || null;
}

function pickColumns(schema) {
  const numbers = schema.filter((column) => column.type === 'number' && column.distinct > 1);
  const dates = schema.filter((column) => column.type === 'date');
  const dimensions = schema.filter((column) => column.type === 'string' && column.distinct > 1 && column.distinct <= 40);
  // 合并视图里「工作表」是虚拟列，优先用它做分表对比
  const sheetDimension = dimensions.find((column) => column.name === SHEET_COLUMN && column.distinct > 1) || null;
  return { measure: pickMeasure(numbers), date: dates[0] || null, dimensions, sheetDimension };
}

export function generateDefaultDocument(snapshot, previous = createEmptyDocument()) {
  const document = clone(previous);
  const { measure, date, dimensions, sheetDimension } = pickColumns(snapshot.schema || []);
  const dimension = date || dimensions[0] || null;
  const subDimension = sheetDimension || dimensions.find((column) => column.name !== dimension?.name) || null;
  const components = [];
  if (measure) {
    for (const [index, agg] of ['sum', 'count', 'avg', 'max'].entries()) {
      const labels = { sum: `${measure.name}合计`, count: '记录数', avg: '平均单条', max: '峰值' };
      components.push({
        id: `kpi-${agg}`, type: 'kpi', title: labels[agg],
        span: { row: 0, col: index * 3, rowSpan: 1, colSpan: 3 },
        encoding: { y: measure.name, agg },
      });
    }
  }
  if (measure && dimension) {
    components.push({
      id: 'main-chart', type: dimension.type === 'date' ? 'line' : 'bar',
      title: `${measure.name} · 按${dimension.name}`,
      span: { row: 1, col: 0, rowSpan: 4, colSpan: 8 },
      encoding: { x: dimension.name, y: measure.name, agg: 'sum' },
    });
  }
  if (measure && subDimension) {
    components.push({
      id: 'sub-chart', type: subDimension.distinct <= 8 ? 'pie' : 'bar',
      title: `${measure.name} · 按${subDimension.name}`,
      span: { row: 1, col: 8, rowSpan: 4, colSpan: 4 },
      encoding: { x: subDimension.name, y: measure.name, agg: 'sum' },
    });
  }
  components.push({
    id: 'data-table', type: 'table', title: '数据表格',
    span: { row: 5, col: 0, rowSpan: 4, colSpan: 12 }, encoding: { agg: 'count' },
  });
  document.components = components.map((component) => validateComponentSpec(component, document.grid));
  document.datasetId = 'default';
  document.revision = (previous.revision || 0) + 1;
  document.updatedAt = new Date().toISOString();
  document.patches = [];
  return document;
}

export function validateDocument(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('Document 必须是对象');
  const grid = validateGrid(input.grid);
  const ids = new Set();
  const components = (Array.isArray(input.components) ? input.components : []).map((spec) => {
    const component = validateComponentSpec(spec, grid);
    if (ids.has(component.id)) bad(`组件 id 重复：${component.id}`, 'DUPLICATE_COMPONENT');
    ids.add(component.id);
    return component;
  });
  for (let index = 0; index < components.length; index += 1) {
    assertNoOverlap(components.slice(0, index), components[index].span);
  }
  const now = new Date().toISOString();
  return {
    id: cleanText(input.id, 'main', 80), name: cleanText(input.name, '实时数据大屏'),
    datasetId: input.datasetId === null ? null : cleanText(input.datasetId, 'default', 80),
    schemaVersion: 1, grid, components, patches: [], revision: Number.isInteger(input.revision) ? input.revision : 0,
    createdAt: input.createdAt || now, updatedAt: now,
  };
}
