import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { DocumentStore } from '../server/document-store.mjs';
import { DocumentRepository } from '../server/document-repository.mjs';
import { createApplication } from '../server/app.mjs';
import { loadConfig } from '../server/config.mjs';
import { LocalLogger } from '../server/logger.mjs';

const silent = { log() {}, warn() {}, error() {} };

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'live-sheet-store-'));
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function repoWith(file) {
  const store = new DocumentStore({ file, flushDelayMs: 0 });
  const documents = new DocumentRepository({ store, logger: new LocalLogger({ sink: silent }) });
  return { store, documents };
}

test('画布修改落盘后可在新实例恢复', { timeout: 15_000 }, async (t) => {
  const directory = await tempDir();
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'document.json');

  const first = repoWith(file);
  const snapshot = {
    instanceId: 'i-1', version: 1,
    schema: [
      { name: '日期', type: 'date', distinct: 20 },
      { name: '地区', type: 'string', distinct: 4 },
      { name: '销售额', type: 'number', distinct: 90 },
    ],
  };
  first.documents.ensureInitialized(snapshot);
  const before = first.documents.getCurrent();
  assert.ok(before.components.length > 0);

  const kpiBefore = before.components.find((item) => item.id === 'kpi-sum');
  const moved = first.documents.submit({
    op: 'move',
    componentId: 'kpi-sum',
    to: { row: 20, col: 0, rowSpan: kpiBefore.span.rowSpan, colSpan: kpiBefore.span.colSpan },
  }).document;
  await first.store.close();
  assert.ok(fs.existsSync(file), '落盘文件应存在');

  const second = repoWith(file);
  const restored = second.documents.getCurrent();
  assert.equal(restored.revision, moved.revision, 'revision 应延续而不是归零');
  assert.equal(restored.components.length, moved.components.length);
  const kpi = restored.components.find((item) => item.id === 'kpi-sum');
  assert.deepEqual(kpi.span, { row: 20, col: 0, rowSpan: 1, colSpan: 3 }, '位置应被恢复');
  assert.equal(restored.patches.length, 0, '补丁历史不跨重启恢复（撤销栈仅存内存）');
});

test('配置文件损坏时隔离备份并回落默认布局', { timeout: 15_000 }, async (t) => {
  const directory = await tempDir();
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'document.json');
  await fsp.writeFile(file, '{ 这不是 JSON ', 'utf8');

  const { documents, store } = repoWith(file);
  assert.equal(documents.initialized, false, '损坏文件不应被当作已初始化');
  assert.equal(documents.getCurrent().components.length, 0);

  const backups = (await fsp.readdir(directory)).filter((name) => name.includes('.corrupt-'));
  assert.equal(backups.length, 1, '损坏文件应被重命名隔离');
  const backupBody = await fsp.readFile(path.join(directory, backups[0]), 'utf8');
  assert.match(backupBody, /这不是 JSON/, '隔离文件必须是原始内容');
  assert.equal(store.stats().error, null);
});

test('结构非法或版本过高的配置被拒绝', { timeout: 15_000 }, async (t) => {
  const directory = await tempDir();
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));

  const invalid = path.join(directory, 'invalid.json');
  await fsp.writeFile(invalid, JSON.stringify({
    schemaVersion: 1,
    document: {
      id: 'main', grid: { columns: 12, rowHeight: 72, gap: 12, padding: 12 }, revision: 3,
      components: [{ id: 'c1', type: 'bar', title: 'x', span: { row: 0, col: 99, rowSpan: 1, colSpan: 2 } }],
    },
  }), 'utf8');
  const invalidRepo = repoWith(invalid);
  assert.equal(invalidRepo.documents.getCurrent().components.length, 0, '越界组件不应被加载');
  assert.equal((await fsp.readdir(directory)).some((name) => name.startsWith('invalid.json.corrupt-')), true);

  const future = path.join(directory, 'future.json');
  await fsp.writeFile(future, JSON.stringify({ schemaVersion: 99, document: { components: [] } }), 'utf8');
  const futureStore = new DocumentStore({ file: future, flushDelayMs: 0 });
  assert.equal(futureStore.load(), null, '高版本配置应被拒绝');
  assert.equal((await fsp.readdir(directory)).some((name) => name.startsWith('future.json.corrupt-')), true);
});

test('原子写入不残留临时文件且内容是合法 JSON', { timeout: 15_000 }, async (t) => {
  const directory = await tempDir();
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'document.json');
  const { store, documents } = repoWith(file);

  documents.ensureInitialized({
    instanceId: 'i-2', version: 1,
    schema: [{ name: '日期', type: 'date', distinct: 10 }, { name: '金额', type: 'number', distinct: 30 }],
  });
  documents.submit({ op: 'retitle', componentId: 'kpi-sum', title: '改过的标题' });
  await store.close();

  const names = await fsp.readdir(directory);
  assert.deepEqual(names, ['document.json'], '只应有正式文件，没有 .tmp 残留');
  const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.equal(parsed.schemaVersion, 1);
  assert.ok(parsed.savedAt);
  assert.equal(parsed.document.components.find((item) => item.id === 'kpi-sum').title, '改过的标题');
  assert.equal(store.stats().lastSavedAt !== null, true);
});

test('服务重启后画布布局保持不变', { timeout: 30_000 }, async (t) => {
  const directory = await tempDir();
  const dataFile = path.join(directory, 'sales.xlsx');
  await fsp.copyFile(path.resolve('data/sales.xlsx'), dataFile);
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));

  const makeConfig = (port) => loadConfig({
    PORT: String(port), DATA_DIR: directory, TARGET_FILE: dataFile,
    DOCUMENT_FILE: path.join(directory, 'document.json'),
    ENABLE_SIMULATE: '0', DEBOUNCE_MS: '0', RETRY_ATTEMPTS: '1',
  });

  const firstPort = await freePort();
  const first = createApplication({ config: makeConfig(firstPort), logger: new LocalLogger({ sink: silent }) });
  await first.start();
  await first.ingest.refresh('测试初始化');
  const firstBase = `http://127.0.0.1:${firstPort}`;
  const projection = await (await fetch(`${firstBase}/api/projection`)).json();
  const target = projection.document.components.find((item) => item.type === 'kpi');
  assert.ok(target, '默认布局应包含 KPI 组件');

  const patched = await fetch(`${firstBase}/api/document/patches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'retitle', componentId: target.id, title: '重启后仍在' }),
  });
  assert.equal(patched.status, 200);
  await first.close();

  const secondPort = await freePort();
  const second = createApplication({ config: makeConfig(secondPort), logger: new LocalLogger({ sink: silent }) });
  await second.start();
  t.after(() => second.close());
  await second.ingest.refresh('重启加载');
  const secondBase = `http://127.0.0.1:${secondPort}`;
  const after = await (await fetch(`${secondBase}/api/document`)).json();
  const restored = after.document.components.find((item) => item.id === target.id);
  assert.equal(restored.title, '重启后仍在', '重启后应恢复自定义标题');
  assert.ok(after.document.revision >= 1);
  const health = await (await fetch(`${secondBase}/api/health`)).json();
  assert.equal(health.document.storage.persisted, true);
});
