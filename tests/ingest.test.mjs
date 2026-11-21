import test from 'node:test';
import assert from 'node:assert/strict';
import { IngestService } from '../server/ingest.mjs';
import { SnapshotRepository } from '../server/dataset.mjs';
import { buildProjection } from '../server/projection.mjs';
import { loadConfig } from '../server/config.mjs';
import { LocalLogger } from '../server/logger.mjs';
import { LocalMetrics } from '../server/metrics.mjs';

const silent = { log() {}, warn() {}, error() {} };
function parsed(value) {
  const data = {
    sheetName: '测试', sheetNames: ['测试'], headers: ['地区', '数值'],
    schema: [{ name: '地区', type: 'string', distinct: 1 }, { name: '数值', type: 'number', distinct: 1 }],
    rows: [{ 地区: '华东', 数值: value }], rowNumbers: [2], rowCount: 1, warnings: [], parseMs: 1,
  };
  return { parsed: data, projection: buildProjection(data) };
}
function setup(worker) {
  const config = loadConfig({ DEBOUNCE_MS: '0', RETRY_ATTEMPTS: '1' });
  const repository = new SnapshotRepository();
  const metrics = new LocalMetrics();
  const events = [];
  const notifier = { broadcast: (event, payload) => events.push({ event, payload }) };
  const ingest = new IngestService({ config, repository, worker, notifier, logger: new LocalLogger({ sink: silent }), metrics });
  return { ingest, repository, metrics, events };
}

test('single-flight 丢弃过期结果，只提交最后一次保存', async () => {
  const pending = [];
  let active = 0;
  let maxActive = 0;
  const worker = {
    parse() {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise((resolve) => pending.push(() => { active -= 1; resolve(parsed(pending.length + 10)); }));
    },
    async close() {},
  };
  const { ingest, repository, metrics } = setup(worker);
  ingest.schedule('第一次', { immediate: true });
  await new Promise((resolve) => setImmediate(resolve));
  ingest.schedule('第二次', { immediate: true });
  pending.shift()();
  while (pending.length < 1) await new Promise((resolve) => setImmediate(resolve));
  pending.shift()();
  await ingest.whenIdle();
  assert.equal(maxActive, 1);
  assert.equal(repository.metadata().version, 1);
  assert.equal(repository.metadata().reason, '第二次');
  assert.equal(metrics.counters.staleResults, 1);
  await ingest.close();
});

test('过期任务失败不会覆盖更新后的成功状态', async () => {
  const actions = [];
  const worker = { parse: () => new Promise((resolve, reject) => actions.push({ resolve, reject })), close: async () => {} };
  const { ingest, repository } = setup(worker);
  ingest.schedule('第一次', { immediate: true });
  while (actions.length < 1) await new Promise((resolve) => setImmediate(resolve));
  ingest.schedule('第二次', { immediate: true });
  actions.shift().reject(Object.assign(new Error('旧任务失败'), { code: 'BAD' }));
  while (actions.length < 1) await new Promise((resolve) => setImmediate(resolve));
  actions.shift().resolve(parsed(20));
  await ingest.whenIdle();
  assert.equal(repository.metadata().status, 'ready');
  assert.equal(repository.metadata().version, 1);
  await ingest.close();
});

test('文件删除使在途解析失效并保留 missing 状态', async () => {
  let finish;
  const worker = { parse: () => new Promise((resolve) => { finish = () => resolve(parsed(1)); }), close: async () => {} };
  const { ingest, repository } = setup(worker);
  ingest.schedule('启动', { immediate: true });
  while (typeof finish !== 'function') await new Promise((resolve) => setImmediate(resolve));
  ingest.markMissing();
  finish();
  await ingest.whenIdle();
  assert.equal(repository.metadata().status, 'missing');
  assert.equal(repository.metadata().version, 0);
  await ingest.close();
});
