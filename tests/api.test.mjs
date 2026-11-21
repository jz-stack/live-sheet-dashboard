import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { createApplication } from '../server/app.mjs';
import { loadConfig } from '../server/config.mjs';
import { LocalLogger } from '../server/logger.mjs';

const silent = { log() {}, warn() {}, error() {} };
let firstInstanceId = null;
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function readUntil(reader, marker) {
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes(marker)) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`SSE 在收到 ${marker} 前结束`);
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

test('HTTP、SSE、分页与安全拦截形成完整闭环', { timeout: 15_000 }, async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'live-sheet-api-'));
  const file = path.join(directory, 'sales.xlsx');
  await fsp.copyFile(path.resolve('data/sales.xlsx'), file);
  const port = await freePort();
  const config = loadConfig({ PORT: String(port), DATA_DIR: directory, TARGET_FILE: file, ACCESS_TOKEN: '', ENABLE_SIMULATE: '0', DEBOUNCE_MS: '0', RETRY_ATTEMPTS: '1' });
  const application = createApplication({ config, logger: new LocalLogger({ sink: silent }) });
  await application.start();
  await application.ingest.refresh('测试初始化');
  t.after(async () => {
    await application.close();
    await fsp.rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;

  const stateResponse = await fetch(`${base}/api/state`);
  const state = await stateResponse.json();
  assert.equal(stateResponse.status, 200);
  assert.equal(state.status, 'ready');
  assert.match(state.instanceId, /^[0-9a-f-]{36}$/);
  firstInstanceId = state.instanceId;
  assert.equal(Object.hasOwn(state, 'rows'), false);
  assert.equal(Object.hasOwn(state, 'sourcePath'), false);

  const projection = await (await fetch(`${base}/api/projection`)).json();
  assert.equal(projection.preview.rows.length, 12);
  assert.equal(Object.hasOwn(projection, 'rows'), false);
  const page = await (await fetch(`${base}/api/rows?offset=2&limit=5`)).json();
  assert.equal(page.rows.length, 5);
  assert.equal(page.offset, 2);
  assert.ok(page.rows[0].id > 0);

  const reload = await fetch(`${base}/api/reload`, { method: 'POST' });
  assert.equal(reload.status, 202);
  await application.ingest.whenIdle();
  assert.equal((await reload.json()).ok, true);

  const simulate = await fetch(`${base}/api/simulate`, { method: 'POST' });
  assert.equal(simulate.status, 404, '生产模式不得开放模拟写接口');
  const badHost = await new Promise((resolve, reject) => {
    const request = http.request(`${base}/api/state`, { headers: { Host: 'evil.example' } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(badHost, 403);
  const crossSite = await fetch(`${base}/api/reload`, { method: 'POST', headers: { Origin: 'https://evil.example' } });
  assert.equal(crossSite.status, 403);
  const largeBody = await fetch(`${base}/api/reload`, { method: 'POST', body: 'x'.repeat(config.MAX_BODY_BYTES + 1) });
  assert.equal(largeBody.status, 413);
  const malformed = await fetch(`${base}/%`);
  assert.equal(malformed.status, 400);
  const traversal = await fetch(`${base}/..%2Fpackage.json`);
  assert.ok([403, 404].includes(traversal.status));

  const events = await fetch(`${base}/api/events`);
  const reader = events.body.getReader();
  const ready = await readUntil(reader, 'event: ready');
  assert.ok(ready.includes('"revision"'));
  await fetch(`${base}/api/reload`, { method: 'POST' });
  const update = await readUntil(reader, 'event: update');
  assert.ok(update.includes('"version"'));
  await reader.cancel();

  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.status, 'ok');
  assert.equal(health.metrics.counters.parseSuccess >= 2, true);
  assert.ok(health.metrics.lastQueueWaitMs >= 0);
});

test('访问口令可通过安全会话换取 HttpOnly Cookie', { timeout: 10_000 }, async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'live-sheet-auth-'));
  const file = path.join(directory, 'sales.xlsx');
  await fsp.copyFile(path.resolve('data/sales.xlsx'), file);
  const port = await freePort();
  const config = loadConfig({ PORT: String(port), DATA_DIR: directory, TARGET_FILE: file, ACCESS_TOKEN: 'test-secret', DEBOUNCE_MS: '0', RETRY_ATTEMPTS: '1' });
  const application = createApplication({ config, logger: new LocalLogger({ sink: silent }) });
  await application.start();
  t.after(async () => {
    await application.close();
    await fsp.rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  const session = await fetch(`${base}/api/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'test-secret' }),
  });
  assert.equal(session.status, 200);
  const cookie = session.headers.get('set-cookie');
  assert.ok(cookie.includes('HttpOnly'));
  assert.ok(cookie.includes('SameSite=Strict'));
  const authorized = await fetch(`${base}/api/state`, { headers: { Cookie: cookie.split(';')[0] } });
  assert.equal(authorized.status, 200);
  const secondInstance = (await authorized.json()).instanceId;
  assert.match(secondInstance, /^[0-9a-f-]{36}$/);
  assert.notEqual(secondInstance, firstInstanceId);
  const bearer = await fetch(`${base}/api/state`, { headers: { Authorization: 'Bearer test-secret' } });
  assert.equal(bearer.status, 200);
});
