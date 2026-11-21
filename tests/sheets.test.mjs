import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import XLSX from 'xlsx';
import { createApplication } from '../server/app.mjs';
import { loadConfig } from '../server/config.mjs';
import { LocalLogger } from '../server/logger.mjs';

XLSX.set_fs(fs);
const silent = { log() {}, warn() {}, error() {} };

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function multiSheetFile(directory) {
  const file = path.join(directory, 'book.xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['日期', '地区', '金额'],
    ['2026-01-01', '华东', 100],
    ['2026-01-02', '华南', 200],
  ]), '1月');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['日期', '地区', '金额'],
    ['2026-02-01', '华东', 300],
    ['2026-02-02', '华南', 400],
    ['2026-02-03', '华北', 500],
  ]), '2月');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['日期', '地区', '金额'],
    ['2026-03-01', '华东', 600],
    ['2026-03-02', '华南', 700],
  ]), '3月');
  XLSX.writeFile(workbook, file);
  return file;
}

test('数据源可在合并视图与单张工作表之间切换', { timeout: 20_000 }, async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'live-sheet-sheets-'));
  const file = await multiSheetFile(directory);
  const port = await freePort();
  const config = loadConfig({
    PORT: String(port), DATA_DIR: directory, TARGET_FILE: file, ACCESS_TOKEN: '',
    ENABLE_SIMULATE: '0', DEBOUNCE_MS: '0', RETRY_ATTEMPTS: '1',
    AI_PROVIDER: 'rule', SOURCE_MODE: 'merged',
  });
  const application = createApplication({ config, logger: new LocalLogger({ sink: silent }) });
  await application.start();
  await application.ingest.refresh('测试初始化');
  t.after(async () => {
    await application.close();
    await fsp.rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;

  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.mode, 'merged');
  assert.equal(state.sheets.length, 3);
  assert.equal(state.rowCount, 7);
  assert.ok(state.headers.includes('工作表'));
  assert.ok(state.warnings.some((warning) => warning.code === 'sheet-merged'));

  const sheets = await (await fetch(`${base}/api/sheets`)).json();
  assert.deepEqual(sheets.sheets.map((sheet) => sheet.name), ['1月', '2月', '3月']);
  assert.equal(sheets.sheetColumn, '工作表');
  assert.equal(sheets.mode, 'merged');

  const document = await (await fetch(`${base}/api/document`)).json();
  const subChart = document.document.components.find((component) => component.id === 'sub-chart');
  assert.equal(subChart.encoding.x, '工作表', '默认布局应直接用工作表做分表对比');

  const mergedProjection = await (await fetch(`${base}/api/projection`)).json();
  const subComponent = mergedProjection.components.find((component) => component.spec.id === 'sub-chart');
  assert.equal(subComponent.status, 'ok');
  assert.deepEqual(subComponent.data.points.map((point) => point.name).sort(), ['1月', '2月', '3月']);

  const switchResponse = await fetch(`${base}/api/dataset/source`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'sheet', sheet: '2月' }),
  });
  assert.equal(switchResponse.status, 202);
  await application.ingest.whenIdle();

  const single = await (await fetch(`${base}/api/state`)).json();
  assert.equal(single.mode, 'sheet');
  assert.equal(single.activeSheet, '2月');
  assert.equal(single.rowCount, 3);
  assert.equal(single.headers.includes('工作表'), false);
  assert.equal(single.sheets.find((sheet) => sheet.name === '1月').status, 'idle');

  const singleProjection = await (await fetch(`${base}/api/projection`)).json();
  const singleSub = singleProjection.components.find((component) => component.spec.id === 'sub-chart');
  assert.equal(singleSub.status, 'invalid', '回到单表后「工作表」列不存在，应明确降级而不是静默');

  const missing = await fetch(`${base}/api/dataset/source`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'sheet', sheet: '不存在的表' }),
  });
  assert.equal(missing.status, 404);

  const back = await fetch(`${base}/api/dataset/source`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'merged' }),
  });
  assert.equal(back.status, 202);
  await application.ingest.whenIdle();
  const restored = await (await fetch(`${base}/api/state`)).json();
  assert.equal(restored.mode, 'merged');
  assert.equal(restored.rowCount, 7);
});

test('文件变动后合并视图重新解析且保留当前数据源', { timeout: 20_000 }, async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'live-sheet-sheets-'));
  const file = await multiSheetFile(directory);
  const port = await freePort();
  const config = loadConfig({
    PORT: String(port), DATA_DIR: directory, TARGET_FILE: file, ACCESS_TOKEN: '',
    ENABLE_SIMULATE: '0', DEBOUNCE_MS: '0', RETRY_ATTEMPTS: '1', AI_PROVIDER: 'rule',
  });
  const application = createApplication({ config, logger: new LocalLogger({ sink: silent }) });
  await application.start();
  await application.ingest.refresh('测试初始化');
  t.after(async () => {
    await application.close();
    await fsp.rm(directory, { recursive: true, force: true });
  });

  await fetch(`http://127.0.0.1:${port}/api/dataset/source`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'sheet', sheet: '3月' }),
  });
  await application.ingest.whenIdle();

  const workbook = XLSX.readFile(file);
  const sheet = workbook.Sheets['3月'];
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
  matrix.push(['2026-03-03', '华北', 800]);
  workbook.Sheets['3月'] = XLSX.utils.aoa_to_sheet(matrix);
  XLSX.writeFile(workbook, file);

  await application.ingest.refresh('模拟文件保存');
  const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
  assert.equal(state.mode, 'sheet');
  assert.equal(state.activeSheet, '3月');
  assert.equal(state.rowCount, 3);
});
