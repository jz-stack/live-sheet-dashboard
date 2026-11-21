import crypto from 'node:crypto';
import { AppError } from './errors.mjs';
import {
  assertNoOverlap, clone, findFreeSpan, validateComponentSpec, validateEncoding, validateSpan,
} from './document.mjs';

const OPERATIONS = new Set(['add', 'remove', 'move', 'resize', 'remap', 'retitle', 'restyle']);
const REMAP_FIELDS = new Set(['x', 'y', 'series', 'agg']);

function bad(message, code = 'INVALID_PATCH') {
  throw new AppError(message, { code, status: 400, stage: 'patch' });
}

export function normalizePatch(input, origin = 'human') {
  const source = input?.patch && typeof input.patch === 'object' ? input.patch : input;
  const nested = source && typeof source.op === 'object' ? source.op : null;
  const operation = nested || source;
  if (!source || typeof source !== 'object' || !OPERATIONS.has(operation?.op)) bad('不支持的 Patch 操作', 'INVALID_PATCH_OP');
  const explicitTarget = operation.idTarget || operation.componentId || operation.targetId || (nested ? operation.id : null);
  return {
    id: typeof source.id === 'string' && source.id && (nested || explicitTarget || source.spec) ? source.id : crypto.randomUUID(),
    origin: ['human', 'ai', 'system'].includes(source.origin) ? source.origin : origin,
    op: operation.op,
    state: 'draft',
    reason: typeof source.reason === 'string' ? source.reason.slice(0, 500) : undefined,
    createdAt: source.createdAt || new Date().toISOString(),
    spec: clone(operation.spec), index: operation.index,
    idTarget: explicitTarget || (!nested ? operation.id : null),
    to: clone(operation.to), field: operation.field, value: clone(operation.value), title: operation.title,
    style: clone(operation.style),
  };
}

function targetIndex(document, patch) {
  const id = patch.idTarget;
  if (!id) bad('Patch 缺少目标组件 id', 'MISSING_COMPONENT_ID');
  const index = document.components.findIndex((component) => component.id === id);
  if (index < 0) bad(`目标组件不存在：${id}`, 'COMPONENT_NOT_FOUND');
  return index;
}

export function applyOperation(document, patch) {
  const next = clone(document);
  let inverse;
  if (patch.op === 'add') {
    const component = validateComponentSpec(patch.spec, next.grid, { allowMissingSpan: true });
    if (next.components.some((item) => item.id === component.id)) bad(`组件 id 已存在：${component.id}`, 'DUPLICATE_COMPONENT');
    if (!component.span) component.span = findFreeSpan(next, { colSpan: component.type === 'kpi' ? 3 : 6, rowSpan: component.type === 'kpi' ? 1 : 4 });
    assertNoOverlap(next.components, component.span);
    const index = patch.index === undefined ? next.components.length : patch.index;
    if (!Number.isInteger(index) || index < 0 || index > next.components.length) bad('组件插入位置无效', 'INVALID_COMPONENT_INDEX');
    next.components.splice(index, 0, component);
    inverse = { op: 'remove', idTarget: component.id };
  } else {
    const index = targetIndex(next, patch);
    const previous = clone(next.components[index]);
    const component = clone(previous);
    if (patch.op === 'remove') {
      next.components.splice(index, 1);
      inverse = { op: 'add', spec: previous, index };
    } else if (patch.op === 'move' || patch.op === 'resize') {
      component.span = validateSpan(patch.to, next.grid);
      assertNoOverlap(next.components, component.span, component.id);
      next.components[index] = component;
      inverse = { op: patch.op, idTarget: component.id, to: previous.span };
    } else if (patch.op === 'remap') {
      if (!REMAP_FIELDS.has(patch.field)) bad('不允许修改该编码字段', 'INVALID_REMAP_FIELD');
      if (patch.value !== null && !['string', 'number'].includes(typeof patch.value)) bad('编码字段值无效', 'INVALID_REMAP_VALUE');
      const encoding = { ...component.encoding, [patch.field]: patch.value === '' ? null : patch.value };
      component.encoding = validateEncoding(encoding, component.type);
      next.components[index] = component;
      inverse = { op: 'remap', idTarget: component.id, field: patch.field, value: previous.encoding[patch.field] ?? null };
    } else if (patch.op === 'retitle') {
      if (typeof patch.title !== 'string' || !patch.title.trim()) bad('组件标题不能为空', 'INVALID_TITLE');
      component.title = patch.title.trim().slice(0, 120);
      next.components[index] = component;
      inverse = { op: 'retitle', idTarget: component.id, title: previous.title };
    } else if (patch.op === 'restyle') {
      const replacement = patch.style === null ? undefined : { ...(component.style || {}), ...(patch.style || {}) };
      const checked = validateComponentSpec({ ...component, style: replacement }, next.grid);
      if (!checked.style || Object.keys(checked.style).length === 0) delete checked.style;
      next.components[index] = checked;
      inverse = { op: 'restyle', idTarget: component.id, style: previous.style || null };
    } else bad('不支持的 Patch 操作', 'INVALID_PATCH_OP');
  }
  next.updatedAt = new Date().toISOString();
  return { document: next, inverse };
}

export function applyPatch(document, input) {
  const patch = normalizePatch(input);
  const { document: next, inverse } = applyOperation(document, patch);
  const record = { ...patch, state: 'applied', inverse };
  next.patches = [record, ...(next.patches || [])].slice(0, 200);
  next.revision = (next.revision || 0) + 1;
  next.updatedAt = new Date().toISOString();
  return { document: next, patch: record };
}

export function dryRunPatch(document, input) {
  const patch = normalizePatch(input);
  const { document: preview, inverse } = applyOperation(document, patch);
  preview.patches = document.patches;
  preview.revision = document.revision;
  return { document: preview, patch: { ...patch, inverse } };
}

export function revertTopPatch(document, id) {
  const top = document.patches?.[0];
  if (!top) bad('没有可撤销的操作', 'EMPTY_UNDO_STACK');
  if (id && top.id !== id) bad('只能撤销最近一次操作', 'UNDO_NOT_TOP');
  const inversePatch = normalizePatch({ ...top.inverse, origin: 'human' });
  const { document: next } = applyOperation(document, inversePatch);
  next.patches = document.patches.slice(1);
  next.revision = (document.revision || 0) + 1;
  next.updatedAt = new Date().toISOString();
  return { document: next, reverted: top };
}
