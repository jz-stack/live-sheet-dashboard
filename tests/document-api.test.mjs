import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createApplication } from '../server/app.mjs';
import { loadConfig } from '../server/config.mjs';
import { LocalLogger } from '../server/logger.mjs';

const silent = { log() {}, warn() {}, error() {} };

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

test('Document 与 Patch API 支持校验、dry-run、撤销、草稿与重置', { timeout: 20_000 }, async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'live-sheet-doc-'));
  const file = path.join(directory, 'sales.xlsx');
  await fsp.copyFile(path.resolve('data/sales.xlsx'), file);
  const port = await freePort();
  const config = loadConfig({ PORT: String(port), DATA_DIR: directory, TARGET_FILE: file, ENABLE_SIMULATE: '0', DEBOUNCE_MS: '0', RETRY_ATTEMPTS: '1' });
  const application = createApplication({ config, logger: new LocalLogger({ sink: silent }) });
  await application.start();
  await application.ingest.refresh('测试初始化');
  t.after(async () => {
    await application.close();
    await fsp.rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;

  const projection = await (await fetch(`${base}/api/projection`)).json();
  assert.equal(projection.document.components.length, 7);
  assert.equal(projection.documentRevision, 1);
  assert.equal(projection.components.length, 7);
  assert.ok(projection.components.every((component) => component.status !== 'invalid'));
  assert.equal(projection.preview.rows.length, 12);

  const documentView = await (await fetch(`${base}/api/document`)).json();
  assert.equal(documentView.document.id, 'main');
  assert.equal(documentView.drafts.length, 0);

  const dryRun = await postJson(`${base}/api/document/patches/dry-run`, {
    op: 'retitle', componentId: 'main-chart', title: '试运行标题',
  });
  assert.equal(dryRun.status, 200);
  assert.equal((await dryRun.json()).document.components.find((component) => component.id === 'main-chart').title, '试运行标题');
  assert.equal((await (await fetch(`${base}/api/document`)).json()).document.components.find((component) => component.id === 'main-chart').title, '销售额 · 按日期');

  const move = await postJson(`${base}/api/document/patches`, {
    op: 'move', componentId: 'data-table', to: { row: 9, col: 0, rowSpan: 4, colSpan: 12 },
  });
  assert.equal(move.status, 200);
  const moved = (await move.json()).document;
  assert.equal(moved.components.find((component) => component.id === 'data-table').span.row, 9);
  assert.equal(moved.revision, 2);

  const overlap = await postJson(`${base}/api/document/patches`, {
    op: 'move', componentId: 'data-table', to: { row: 1, col: 0, rowSpan: 4, colSpan: 12 },
  });
  assert.equal(overlap.status, 400);
  assert.equal((await overlap.json()).code, 'GRID_OVERLAP');

  const add = await postJson(`${base}/api/document/patches`, {
    op: 'add', spec: { type: 'bar', title: '新增图', encoding: { x: '地区', y: '销售额', agg: 'sum' } },
  });
  assert.equal(add.status, 200);
  const addPayload = await add.json();
  const added = addPayload.document;
  assert.equal(added.components.length, 8);
  assert.ok(added.components.at(-1).span.col + added.components.at(-1).span.colSpan <= added.grid.columns);

  const revert = await postJson(`${base}/api/document/patches/${added.patches[0].id}/revert`, {});
  assert.equal(revert.status, 200);
  assert.equal((await revert.json()).document.components.length, 7);

  const wrongRevert = await postJson(`${base}/api/document/patches/not-exist/revert`, {});
  assert.equal(wrongRevert.status, 400);

  const draft = await postJson(`${base}/api/document/patches`, {
    draft: true, op: 'retitle', componentId: 'main-chart', title: '草稿标题',
  });
  assert.equal(draft.status, 202);
  const draftPayload = await draft.json();
  assert.equal(draftPayload.applied, false);
  assert.equal((await (await fetch(`${base}/api/document`)).json()).document.components.find((component) => component.id === 'main-chart').title, '销售额 · 按日期');

  const accepted = await postJson(`${base}/api/document/drafts/${draftPayload.draft.id}/accept`, {});
  assert.equal(accepted.status, 200);
  assert.equal((await (await fetch(`${base}/api/document`)).json()).document.components.find((component) => component.id === 'main-chart').title, '草稿标题');

  const rejected = await postJson(`${base}/api/document/patches`, {
    draft: true, op: 'retitle', componentId: 'main-chart', title: '不要采纳',
  });
  const reject = await postJson(`${base}/api/document/drafts/${(await rejected.json()).draft.id}/reject`, {});
  assert.equal(reject.status, 200);
  assert.equal((await (await fetch(`${base}/api/document`)).json()).document.components.find((component) => component.id === 'main-chart').title, '草稿标题');

  const reset = await postJson(`${base}/api/document/reset`, {});
  assert.equal(reset.status, 200);
  assert.equal((await reset.json()).document.components.length, 7);
  assert.equal((await (await fetch(`${base}/api/document`)).json()).document.patches.length, 0);

  const badPut = await fetch(`${base}/api/document`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ components: [{ type: 'magic' }] }),
  });
  assert.equal(badPut.status, 400);
  assert.equal((await badPut.json()).code, 'INVALID_COMPONENT_TYPE');

  const crossSite = await postJson(`${base}/api/document/patches`, { op: 'retitle', componentId: 'main-chart', title: 'x' });
  assert.equal(crossSite.status, 200);
  const blocked = await fetch(`${base}/api/document/patches`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ op: 'retitle', componentId: 'main-chart', title: 'y' }),
  });
  assert.equal(blocked.status, 403);

  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.status, 'ok');
  assert.ok(health.document.revision >= 1);
});
