import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import XLSX from 'xlsx';
import { parseWorkbook, parseWorkbookSource, toDateKey } from '../server/parser.mjs';
import { buildProjection } from '../server/projection.mjs';

XLSX.set_fs(fs);
const limits = { maxFileBytes: 2_000_000, maxRows: 1000, maxColumns: 20, maxCells: 20_000, skipTotalRows: true };

async function fixture(t, rows) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'live-sheet-parser-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'case.xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), '测试');
  XLSX.writeFile(workbook, file);
  return file;
}

test('百分比、货币和括号负数按明确口径转换', async (t) => {
  const file = await fixture(t, [
    ['日期', '地区', '金额', '完成率'],
    ['2026/1/1', '华东', '¥1,200', '12%'],
    ['2026/1/2', '华南', '(300)', '25%'],
    ['2026年1月', '华北', '800', '50%'],
  ]);
  const result = parseWorkbook(file, limits);
  assert.equal(result.rows[0]['金额'], 1200);
  assert.equal(result.rows[1]['金额'], -300);
  assert.equal(result.rows[0]['完成率'], 0.12);
  assert.equal(result.rows[1]['完成率'], 0.25);
  assert.equal(result.rows[2]['日期'], '2026-01-01');
  assert.ok(result.warnings.some((warning) => warning.code === 'percentage-normalized'));
});

test('混合类型不会静默丢值，特殊表头不会污染原型', async (t) => {
  const file = await fixture(t, [
    ['__proto__', '数值'],
    ['a', 1], ['b', 'bad'], ['c', 3], ['d', 4], ['e', 5],
  ]);
  const result = parseWorkbook(file, limits);
  assert.equal(result.schema[1].type, 'number');
  assert.equal(result.rows[1]['数值'], null);
  assert.ok(result.warnings.some((warning) => warning.code === 'value-coerced-null'));
  assert.equal({}.polluted, undefined);
  assert.equal(result.rows[0]['__proto__'], 'a');
});

test('比表头更宽的行会补列而不是丢弃额外单元格', async (t) => {
  const file = await fixture(t, [['地区', '数值'], ['华东', 1, '额外值'], ['华南', 2, '另一值']]);
  const result = parseWorkbook(file, limits);
  assert.deepEqual(result.headers, ['地区', '数值', '列3']);
  assert.equal(result.rows[0]['列3'], '额外值');
  assert.ok(result.warnings.some((warning) => warning.code === 'extra-columns-recovered'));
});

test('合计行规则可关闭，源行号保持稳定', async (t) => {
  const rows = [['地区', '数值'], ['华东', 1], ['合计', 1]];
  const skipped = parseWorkbook(await fixture(t, rows), limits);
  assert.equal(skipped.rowCount, 1);
  const kept = parseWorkbook(await fixture(t, rows), { ...limits, skipTotalRows: false });
  assert.equal(kept.rowCount, 2);
  assert.deepEqual(kept.rowNumbers, [2, 3]);
});

test('资源上限在工作表转换前生效', async (t) => {
  const file = await fixture(t, [['地区', '数值'], ['a', 1], ['b', 2], ['c', 3]]);
  assert.throws(() => parseWorkbook(file, { ...limits, maxRows: 2 }), (error) => error.code === 'LIMIT_EXCEEDED' && error.stage === 'read');
});

test('非法日期不会混入标准化日期列', async (t) => {
  const file = await fixture(t, [
    ['日期', '数值'], ['2026-01-01', 1], ['2026-02-30', 2], ['2026-01-03', 3], ['2026-01-04', 4], ['2026-01-05', 5],
  ]);
  const result = parseWorkbook(file, limits);
  assert.equal(result.schema[0].type, 'date');
  assert.equal(result.rows[1]['日期'], null);
  assert.ok(result.warnings.some((warning) => warning.code === 'value-coerced-null'));
});

test('大数组 KPI 不使用展开运算符，十万行可计算', () => {
  const rows = Array.from({ length: 100_000 }, (_, index) => ({ 日期: `2026-01-${String(index % 30 + 1).padStart(2, '0')}`, 数值: index }));
  const snapshot = {
    rows,
    headers: ['日期', '数值'],
    schema: [{ name: '日期', type: 'date', distinct: 30 }, { name: '数值', type: 'number', distinct: 100_000 }],
    rowNumbers: rows.map((_, index) => index + 2),
  };
  const projection = buildProjection(snapshot);
  assert.equal(projection.kpis.find((kpi) => kpi.key === 'max').raw, 99_999);
  assert.equal(projection.kpis.find((kpi) => kpi.key === 'count').raw, 100_000);
});

async function multiFixture(t, sheets) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'live-sheet-multi-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'book.xlsx');
  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name);
  }
  workbook.Workbook = { Sheets: sheets.map((sheet) => (sheet.hidden ? { Hidden: 1 } : {})) };
  XLSX.writeFile(workbook, file);
  return file;
}

test('合并视图：多张表按列并集合并，并追加来源列', async (t) => {
  const file = await multiFixture(t, [
    { name: '1月', rows: [['日期', '地区', '金额'], ['2026-01-01', '华东', 100], ['2026-01-02', '华南', 200]] },
    { name: '2月', rows: [['日期', '地区', '金额'], ['2026-02-01', '华东', 300], ['2026-02-02', '华南', 400], ['2026-02-03', '华北', 500]] },
    { name: '3月', rows: [['日期', '地区', '金额', '毛利'], ['2026-03-01', '华东', 600, 120]] },
  ]);
  const merged = parseWorkbookSource(file, limits, { mode: 'merged' });
  assert.equal(merged.rowCount, 6);
  assert.deepEqual(merged.headers, ['日期', '地区', '金额', '毛利', '工作表']);
  assert.equal(merged.sheetColumn, '工作表');
  assert.deepEqual([...new Set(merged.rows.map((row) => row['工作表']))], ['1月', '2月', '3月']);
  const gross = merged.schema.find((column) => column.name === '毛利');
  assert.equal(gross.type, 'number');
  assert.equal(gross.nullCount, 5);
  assert.ok(merged.warnings.some((warning) => warning.code === 'sheet-merged'));
  assert.ok(merged.warnings.some((warning) => warning.code === 'sheet-column-missing'));
  assert.equal(merged.sheets.length, 3);
  assert.equal(merged.sheets[1].rowCount, 3);
});

test('合并视图跳过隐藏表与坏表，单表失败不拖垮整本工作簿', async (t) => {
  const file = await multiFixture(t, [
    { name: '1月', rows: [['地区', '金额'], ['华东', 100]] },
    { name: '4月', rows: [['地区', '金额'], ['西南', 60]] },
    { name: '内部', rows: [['地区', '金额'], ['华南', 999]], hidden: true },
    { name: '残表', rows: [['只有一列'], [1]] },
  ]);
  const merged = parseWorkbookSource(file, limits, { mode: 'merged' });
  assert.equal(merged.rowCount, 2);
  assert.deepEqual(merged.rows.map((row) => row['工作表']), ['1月', '4月']);
  assert.ok(merged.warnings.some((warning) => warning.code === 'sheet-skipped' && warning.message.includes('隐藏')));
  assert.ok(merged.warnings.some((warning) => warning.code === 'sheet-skipped' && warning.message.includes('残表')));
  // 对外清单必须保留 hidden 与跳过原因，前端才能把这类工作表置灰而不是让用户点了才失败
  const hiddenSheet = merged.sheets.find((sheet) => sheet.name === '内部');
  assert.equal(hiddenSheet.hidden, true);
  assert.equal(hiddenSheet.status, 'skipped');
  assert.equal(hiddenSheet.reason, '隐藏工作表');
  const brokenSheet = merged.sheets.find((sheet) => sheet.name === '残表');
  assert.equal(brokenSheet.hidden, false);
  assert.equal(brokenSheet.status, 'skipped');
  assert.ok(brokenSheet.reason.includes('表头'));
  assert.equal(merged.sheets.find((sheet) => sheet.name === '1月').hidden, false);
});

test('单表模式只解析指定工作表，不追加来源列', async (t) => {
  const file = await multiFixture(t, [
    { name: '1月', rows: [['地区', '金额'], ['华东', 100]] },
    { name: '2月', rows: [['地区', '金额'], ['华南', 200], ['华北', 300]] },
  ]);
  const single = parseWorkbookSource(file, limits, { mode: 'sheet', sheetName: '2月' });
  assert.equal(single.mode, 'sheet');
  assert.equal(single.activeSheet, '2月');
  assert.equal(single.rowCount, 2);
  assert.deepEqual(single.headers, ['地区', '金额']);
  assert.equal(single.sheets.length, 2);
  assert.equal(single.sheets.find((sheet) => sheet.name === '1月').status, 'idle');
});

test('表内已有「工作表」列时，来源列自动避让不覆盖用户列', async (t) => {
  const file = await multiFixture(t, [
    { name: '明细', rows: [['地区', '金额', '工作表'], ['华东', 100, '自定义A']] },
    { name: '明细2', rows: [['地区', '金额', '工作表'], ['华南', 200, '自定义B']] },
  ]);
  const merged = parseWorkbookSource(file, limits, { mode: 'merged' });
  assert.equal(merged.sheetColumn, '工作表(分表)');
  assert.deepEqual(merged.headers, ['地区', '金额', '工作表', '工作表(分表)']);
  assert.equal(merged.rows[0]['工作表'], '自定义A');
  assert.equal(merged.rows[0]['工作表(分表)'], '明细');
  assert.ok(merged.warnings.some((warning) => warning.code === 'sheet-column-renamed'));
});

test('只有一张有效表时不生成来源列，保持单表数据形状', async (t) => {
  const file = await multiFixture(t, [
    { name: '唯一', rows: [['地区', '金额'], ['华东', 100]] },
    { name: '空白', rows: [['只有一列'], [1]] },
  ]);
  const merged = parseWorkbookSource(file, limits, { mode: 'merged' });
  assert.deepEqual(merged.headers, ['地区', '金额']);
  assert.equal(merged.sheetColumn, undefined);
  assert.equal(merged.warnings.some((warning) => warning.code === 'sheet-merged'), false);
});

test('合并总行数超过上限时报 LIMIT_EXCEEDED', async (t) => {
  const file = await multiFixture(t, [
    { name: '1月', rows: [['地区', '金额'], ['华东', 1], ['华南', 2], ['华北', 3]] },
    { name: '2月', rows: [['地区', '金额'], ['华东', 4], ['华南', 5], ['华北', 6]] },
  ]);
  assert.throws(
    () => parseWorkbookSource(file, { ...limits, maxWorkbookRows: 5 }, { mode: 'merged' }),
    (error) => error.code === 'LIMIT_EXCEEDED' && error.stage === 'merge',
  );
});

test('带时分的时间字符串识别为日期列，聚合粒度仍到天', async (t) => {
  assert.equal(toDateKey('2026-01-06 14:23'), '2026-01-06');
  assert.equal(toDateKey('2026/1/6 9:05:30'), '2026-01-06');
  assert.equal(toDateKey('2026-01-06T14:23:00Z'), '2026-01-06');
  assert.equal(toDateKey('14:23'), null, '纯时间不是日期');
  assert.equal(toDateKey('2026-01-06 25:00'), null, '非法小时不应被接受');

  const file = await multiFixture(t, [
    { name: '工单', rows: [['工单号', '创建时间', '时长'], ['TK-1', '2026-01-06 14:23', 3], ['TK-2', '2026-01-07 09:05', 5]] },
  ]);
  const parsed = parseWorkbookSource(file, limits, { mode: 'sheet' });
  const createdAt = parsed.schema.find((column) => column.name === '创建时间');
  assert.equal(createdAt.type, 'date');
});
