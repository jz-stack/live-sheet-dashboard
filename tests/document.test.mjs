import test from 'node:test';
import assert from 'node:assert/strict';
import { clone, generateDefaultDocument, createEmptyDocument } from '../server/document.mjs';
import { applyPatch, dryRunPatch, revertTopPatch } from '../server/patch.mjs';
import { DocumentRepository } from '../server/document-repository.mjs';
import { projectDocument } from '../server/component-projection.mjs';

function snapshot() {
  return {
    instanceId: 'test-instance',
    version: 1,
    headers: ['日期', '地区', '销售额'],
    schema: [
      { name: '日期', type: 'date', nullCount: 0, nullRate: 0, distinct: 3, sample: ['2026-01', '2026-02'] },
      { name: '地区', type: 'string', nullCount: 0, nullRate: 0, distinct: 2, sample: ['华东', '华南'] },
      { name: '销售额', type: 'number', nullCount: 0, nullRate: 0, distinct: 6, sample: [10, 20] },
    ],
    rows: [
      { 日期: '2026-01', 地区: '华东', 销售额: 10 },
      { 日期: '2026-01', 地区: '华南', 销售额: 30 },
      { 日期: '2026-02', 地区: '华东', 销售额: 20 },
      { 日期: '2026-02', 地区: '华南', 销售额: 40 },
      { 日期: '2026-03', 地区: '华东', 销售额: 50 },
    ],
    rowNumbers: [2, 3, 4, 5, 6],
    rowCount: 5,
  };
}

test('默认 Document 覆盖 KPI、趋势、结构与明细并投影成功', () => {
  const document = generateDefaultDocument(snapshot());
  assert.equal(document.components.length, 7);
  assert.equal(document.revision, 1);
  const result = projectDocument(document, snapshot());
  assert.equal(result.components.length, 7);
  const sum = result.components.find((component) => component.spec.id === 'kpi-sum');
  assert.equal(sum.status, 'ok');
  assert.equal(sum.data.raw, 150);
  const main = result.components.find((component) => component.spec.id === 'main-chart');
  assert.deepEqual(main.data.labels, ['2026-01', '2026-02', '2026-03']);
  assert.deepEqual(main.data.series[0].values, [40, 60, 50]);
  const sub = result.components.find((component) => component.spec.id === 'sub-chart');
  assert.equal(sub.type, 'pie');
  assert.equal(sub.data.points.length, 2);
  const table = result.components.find((component) => component.spec.id === 'data-table');
  assert.equal(table.data.rows.length, 5);
  assert.ok(result.components.every((component) => component.status !== 'invalid'));
});

test('系列列缺失会降级而不是整组件失效', () => {
  const base = generateDefaultDocument(snapshot());
  const document = clone(base);
  const main = document.components.find((component) => component.id === 'main-chart');
  main.encoding.series = '不存在的列';
  const result = projectDocument(document, snapshot());
  const projected = result.components.find((component) => component.spec.id === 'main-chart');
  assert.equal(projected.status, 'degraded');
  assert.match(projected.reason, /系列列/);
});

test('度量列被删除时组件进入 invalid，但画布与表格不受影响', () => {
  const broken = { ...snapshot(), headers: ['日期', '地区'], schema: snapshot().schema.slice(0, 2), rows: snapshot().rows };
  const document = generateDefaultDocument(snapshot());
  const result = projectDocument(document, broken);
  const main = result.components.find((component) => component.spec.id === 'main-chart');
  assert.equal(main.status, 'invalid');
  const table = result.components.find((component) => component.spec.id === 'data-table');
  assert.equal(table.status, 'ok');
});

test('每种 Patch 都满足 revert(apply(doc)) 结构等价', () => {
  const data = snapshot();
  const patches = [
    { op: 'add', spec: { type: 'bar', title: '新增图', encoding: { x: '地区', y: '销售额', agg: 'sum' } } },
    { op: 'remove', componentId: 'data-table' },
    { op: 'move', componentId: 'data-table', to: { row: 9, col: 0, rowSpan: 4, colSpan: 12 } },
    { op: 'resize', componentId: 'main-chart', to: { row: 1, col: 0, rowSpan: 3, colSpan: 8 } },
    { op: 'remap', componentId: 'main-chart', field: 'agg', value: 'avg' },
    { op: 'retitle', componentId: 'main-chart', title: '新标题' },
    { op: 'restyle', componentId: 'main-chart', style: { accent: '#35C2A6' } },
  ];
  for (const patch of patches) {
    const before = generateDefaultDocument(data);
    const { document: applied, patch: record } = applyPatch(before, patch);
    assert.ok(applied.revision > before.revision, `${patch.op} 应递增画布版本`);
    assert.equal(applied.patches[0].id, record.id);
    const { document: reverted } = revertTopPatch(applied, record.id);
    assert.deepEqual(reverted.components, before.components, `${patch.op} 的 revert 必须恢复组件结构`);
    assert.deepEqual(reverted.patches, before.patches, `${patch.op} 的 revert 必须恢复历史`);
    assert.deepEqual({ ...reverted, components: undefined, patches: undefined, revision: undefined, updatedAt: undefined },
      { ...before, components: undefined, patches: undefined, revision: undefined, updatedAt: undefined });
  }
});

test('非法 Patch 被拒绝且 dry-run 不修改原文档', () => {
  const before = generateDefaultDocument(snapshot());
  assert.throws(() => dryRunPatch(before, { op: 'move', componentId: 'main-chart', to: { row: 1, col: 0, rowSpan: 4, colSpan: 13 } }), /超出画布列数/);
  assert.throws(() => dryRunPatch(before, { op: 'move', componentId: 'main-chart', to: { row: 1, col: 8, rowSpan: 4, colSpan: 4 } }), /重叠/);
  assert.throws(() => dryRunPatch(before, { op: 'remove', componentId: '不存在' }), /目标组件不存在/);
  const preview = dryRunPatch(before, { op: 'retitle', componentId: 'main-chart', title: '试运行' });
  assert.equal(preview.document.components.find((component) => component.id === 'main-chart').title, '试运行');
  assert.deepEqual(before.components.find((component) => component.id === 'main-chart').title, '销售额 · 按日期');
  assert.equal(before.revision, 1);
});

test('仓库支持 draft 审阅、采纳、拒绝与栈顶撤销', () => {
  const data = snapshot();
  const repository = new DocumentRepository();
  const first = repository.project(data);
  assert.equal(first.documentRevision, 1);

  const draft = repository.submit({ op: 'add', spec: { type: 'text', title: '说明', text: '示例说明' }, draft: true }, { draft: true });
  assert.equal(draft.applied, false);
  assert.equal(repository.getCurrent().components.length, 7);
  assert.equal(repository.view().drafts.length, 1);

  const accepted = repository.acceptDraft(draft.draft.id);
  assert.equal(accepted.applied, true);
  assert.equal(repository.getCurrent().components.length, 8);
  assert.equal(repository.view().drafts.length, 0);
  assert.equal(accepted.document.revision, 2);

  const rejected = repository.submit({ op: 'add', spec: { type: 'text', title: '不要' }, draft: true }, { draft: true });
  repository.rejectDraft(rejected.draft.id);
  assert.equal(repository.getCurrent().components.length, 8);

  const result = repository.revert(accepted.patch.id);
  assert.equal(result.document.components.length, 7);
  assert.equal(result.document.revision, 3);

  const reset = repository.reset(data);
  assert.equal(reset.components.length, 7);
  assert.equal(repository.project(data).components.length, 7);
});

test('空文档与无数据快照不会抛错', () => {
  const repository = new DocumentRepository();
  const result = repository.project({ instanceId: 'x', version: 0, headers: [], schema: [], rows: [] });
  assert.deepEqual(result.components, []);
  assert.equal(result.document.components.length, 0);
  assert.equal(result.preview.rows.length, 0);
  assert.equal(createEmptyDocument().revision, 0);
});

test('合并快照的默认布局用「工作表」做分表对比而不是普通维度', () => {
  const base = snapshot();
  const merged = {
    ...base,
    headers: [...base.headers, '工作表'],
    schema: [...base.schema, { name: '工作表', type: 'string', nullCount: 0, nullRate: 0, distinct: 3, sample: ['1月', '2月'] }],
    rows: base.rows.map((row, index) => ({ ...row, 工作表: ['1月', '2月', '3月'][index % 3] })),
    sheetColumn: '工作表',
    mode: 'merged',
  };
  const document = generateDefaultDocument(merged, createEmptyDocument());
  const subChart = document.components.find((component) => component.id === 'sub-chart');
  assert.equal(subChart.encoding.x, '工作表');
  const projection = projectDocument(document, merged);
  const projected = projection.components.find((component) => component.spec.id === 'sub-chart');
  assert.equal(projected.status, 'ok');
  assert.equal(projected.data.points.length, 3);
});

test('默认布局优先选金额类列做主指标，而非第一个数值列', () => {
  const base = snapshot();
  const orderBook = {
    ...base,
    headers: ['订单号', '数量', '单价', '金额'],
    schema: [
      { name: '订单号', type: 'string', nullCount: 0, nullRate: 0, distinct: 120, sample: ['SO-1'] },
      { name: '数量', type: 'number', nullCount: 0, nullRate: 0, distinct: 30, sample: [3] },
      { name: '单价', type: 'number', nullCount: 0, nullRate: 0, distinct: 40, sample: [320] },
      { name: '金额', type: 'number', nullCount: 0, nullRate: 0, distinct: 90, sample: [960] },
    ],
    rows: [
      { 订单号: 'SO-1', 数量: 3, 单价: 320, 金额: 960 },
      { 订单号: 'SO-2', 数量: 5, 单价: 120, 金额: 600 },
    ],
    rowNumbers: [2, 3],
    rowCount: 2,
  };
  const document = generateDefaultDocument(orderBook, createEmptyDocument());
  const sum = document.components.find((component) => component.id === 'kpi-sum');
  assert.equal(sum.encoding.y, '金额');
  assert.equal(sum.title, '金额合计');
});

test('只有过程量时仍能退回第一个数值列，不会生成空指标', () => {
  const base = snapshot();
  const hours = {
    ...base,
    headers: ['日期', '项目', '工时'],
    schema: [
      { name: '日期', type: 'date', nullCount: 0, nullRate: 0, distinct: 2, sample: ['2026-01-01'] },
      { name: '项目', type: 'string', nullCount: 0, nullRate: 0, distinct: 2, sample: ['A'] },
      { name: '工时', type: 'number', nullCount: 0, nullRate: 0, distinct: 4, sample: [1.5] },
    ],
    rows: [
      { 日期: '2026-01-01', 项目: 'A', 工时: 1.5 },
      { 日期: '2026-01-02', 项目: 'B', 工时: 2 },
    ],
    rowNumbers: [2, 3],
    rowCount: 2,
  };
  const document = generateDefaultDocument(hours, createEmptyDocument());
  const sum = document.components.find((component) => component.id === 'kpi-sum');
  assert.equal(sum.encoding.y, '工时');
});
