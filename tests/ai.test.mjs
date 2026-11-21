import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createApplication } from '../server/app.mjs';
import { loadConfig } from '../server/config.mjs';
import { LocalLogger } from '../server/logger.mjs';
import { LocalMetrics } from '../server/metrics.mjs';
import { SnapshotRepository } from '../server/dataset.mjs';
import { DocumentRepository } from '../server/document-repository.mjs';
import { SseNotifier } from '../server/sse.mjs';
import { emptyProjection } from '../server/projection.mjs';
import { parseWorkbook } from '../server/parser.mjs';
import { buildSchemaCard } from '../server/ai/schema-card.mjs';
import { analyzeSnapshot } from '../server/ai/analysis.mjs';
import { parseModelJson, validateChartSpec, validateInsightSpec } from '../server/ai/protocols.mjs';
import { RuleProvider, ruleChart, ruleInsight, OpenAiCompatibleProvider, MockProvider } from '../server/ai/providers.mjs';
import { AiOrchestrator } from '../server/ai/orchestrator.mjs';

const silent = { log() {}, warn() {}, error() {} };

function loadSnapshotFromFile(file, limits) {
  const parsed = parseWorkbook(file, limits);
  return { ...parsed, instanceId: 'test-instance', version: 1 };
}

function buildStack({ file, provider = null } = {}) {
  const config = loadConfig({ AI_PROVIDER: 'rule', DATA_DIR: path.dirname(file), TARGET_FILE: file });
  const logger = new LocalLogger({ sink: silent });
  const metrics = new LocalMetrics();
  const repository = new SnapshotRepository();
  const documents = new DocumentRepository();
  const notifier = new SseNotifier({ config, logger, metrics });
  repository.commit(loadSnapshotFromFile(file, config.LIMITS), emptyProjection(), { file, reason: '测试' });
  const ai = new AiOrchestrator({ config, logger, metrics, repository, documents, notifier, provider });
  documents.project(repository.snapshot());
  return { config, logger, metrics, repository, documents, notifier, ai };
}

test('SchemaCard 不携带数据行，样例数量受限且可关闭', () => {
  const snapshot = loadSnapshotFromFile(path.resolve('data/sales.xlsx'), loadConfig({}).LIMITS);
  const card = buildSchemaCard(snapshot, { includeSamples: true });
  assert.ok(!('rows' in card));
  assert.ok(card.columns.length > 0);
  for (const column of card.columns) {
    assert.ok(!Array.isArray(column.samples) || column.samples.length <= 3);
  }
  assert.match(card.schemaHash, /^[0-9a-f]{16}$/);
  const noSamples = buildSchemaCard(snapshot, { includeSamples: false });
  for (const column of noSamples.columns) {
    assert.ok(!('samples' in column), '关闭样例后不得出现 samples 字段');
  }
});

test('模型输出解析：剥离代码围栏，垃圾输入直接失败', () => {
  const fenced = '好的，这是配置：\n```json\n{"type":"bar","title":"T"}\n```\n以上仅供参考。';
  assert.deepEqual(parseModelJson(fenced), { type: 'bar', title: 'T' });
  assert.deepEqual(parseModelJson('{"a":{"b":"}"}}'), { a: { b: '}' } });
  assert.throws(() => parseModelJson('这不是 JSON'), (error) => error.code === 'AI_NO_JSON');
  assert.throws(() => parseModelJson('{"type":"bar"'), (error) => error.code === 'AI_TRUNCATED_JSON');
  assert.throws(() => parseModelJson(''), (error) => error.code === 'AI_EMPTY_OUTPUT');
});

test('ChartSpec 校验：未知字段、编造列名与非数值度量全部拒绝', () => {
  const snapshot = loadSnapshotFromFile(path.resolve('data/sales.xlsx'), loadConfig({}).LIMITS);
  const card = buildSchemaCard(snapshot);
  const base = { type: 'bar', title: '测试', encoding: { x: '地区', y: '销售额', agg: 'sum' } };
  assert.equal(validateChartSpec(base, card).type, 'bar');
  assert.throws(() => validateChartSpec({ ...base, extra: 1 }, card), /未知字段/);
  assert.throws(() => validateChartSpec({ ...base, encoding: { x: '不存在的列', y: '销售额', agg: 'sum' } }, card), (error) => error.code === 'AI_UNKNOWN_COLUMN');
  assert.throws(() => validateChartSpec({ ...base, encoding: { x: '地区', y: '地区', agg: 'sum' } }, card), /不是 number 类型/);
  assert.throws(() => validateChartSpec({ ...base, encoding: { x: '地区', y: '销售额', agg: 'median' } }, card), /聚合方式/);
  assert.throws(() => validateChartSpec({ ...base, placement: { strategy: 'replace' } }, card), /targetId/);
});

test('离线规则：一句话建图命中正确的类型、维度与度量', () => {
  const snapshot = loadSnapshotFromFile(path.resolve('data/sales.xlsx'), loadConfig({}).LIMITS);
  const card = buildSchemaCard(snapshot);
  const spec = validateChartSpec(ruleChart({ schemaCard: card, instruction: '按地区看毛利排行' }), card);
  assert.equal(spec.type, 'bar');
  assert.equal(spec.encoding.x, '地区');
  assert.equal(spec.encoding.y, '毛利');
  assert.equal(spec.placement.strategy, 'append');
  assert.equal(spec.encoding.agg, 'sum');

  const trend = validateChartSpec(ruleChart({ schemaCard: card, instruction: '按日期看销售额趋势' }), card);
  assert.equal(trend.type, 'line');
  assert.equal(trend.encoding.x, '日期');
  assert.equal(trend.encoding.y, '销售额');
});

test('洞察数字忠实性：文案数值必须能追溯到证据', () => {
  const snapshot = loadSnapshotFromFile(path.resolve('data/sales.xlsx'), loadConfig({}).LIMITS);
  const evidence = analyzeSnapshot(snapshot);
  assert.ok(evidence.observations.length > 0, '样例数据应产生确定性观察');
  const card = buildSchemaCard(snapshot);
  const spec = validateInsightSpec(ruleInsight({ schemaCard: card, evidence }), evidence);
  assert.ok(spec.statement.length > 0);
  assert.deepEqual(spec.observationRefs, evidence.observations.slice(0, 3).map((item) => item.id));

  const fabricated = { ...spec, statement: `${spec.statement} 此外总量达到 999999。` };
  assert.throws(() => validateInsightSpec(fabricated, evidence), (error) => error.code === 'AI_UNTRACEABLE_NUMBER');
});

test('编排器：建议只入审阅队列，采纳后才修改 Document，画布变化后建议过期', async () => {
  const file = path.resolve('data/sales.xlsx');
  const { ai, documents, metrics, notifier } = buildStack({ file });
  notifier.close();
  const before = documents.getCurrent().components.length;

  const result = await ai.chart('按品类看毛利占比');
  assert.equal(result.task.status, 'succeeded');
  assert.equal(result.suggestion.kind, 'chart');
  assert.equal(result.suggestion.state, 'pending');
  assert.equal(result.suggestion.patches[0].op, 'add');
  assert.equal(documents.getCurrent().components.length, before, '未采纳前不得修改 Document');

  // 画布预览契约：建议必须直接给出“套用后长什么样”，前端据此原地渲染图表。
  const preview = result.suggestion.preview;
  assert.equal(preview.added.length, 1, '建图建议应给出一块可直接渲染的预览组件');
  assert.equal(preview.added[0].spec.type, 'pie');
  assert.ok(preview.added[0].data.points.length > 0, '预览必须携带真实聚合数据');
  assert.ok(preview.added[0].spec.span?.rowSpan > 0, '预览组件必须有确定栅格位置');
  assert.equal(preview.changed.length, 0);
  assert.equal(preview.removed.length, 0);
  assert.equal(preview.steps.length, 1);
  assert.match(preview.steps[0], /^新增/);
  assert.deepEqual(ai.suggestionsView().find((item) => item.id === result.suggestion.id).preview, preview, '预览应可重复读取');

  await ai.rejectSuggestion(result.suggestion.id);
  assert.equal(documents.getCurrent().components.length, before);
  assert.equal(ai.suggestionsView().find((item) => item.id === result.suggestion.id).preview, null, '已处理的建议不再保留预览');

  const second = await ai.chart('按品类看毛利占比');
  assert.equal(second.task.cached, true, '相同指令应命中缓存');
  assert.equal(metrics.snapshot().counters.aiCacheHits >= 1, true);

  const accepted = ai.acceptSuggestion(second.suggestion.id);
  assert.equal(accepted.ok, true);
  assert.equal(documents.getCurrent().components.length, before + 1);
  const added = documents.getCurrent().components.at(-1);
  assert.equal(added.encoding.y, '毛利');
  assert.equal(added.type, 'pie');

  // 维护建议依赖 documentRevision：建议创建后再有人的改动，建议应过期。
  documents.submit({ op: 'add', spec: { type: 'bar', title: '人工图', encoding: { x: '地区', y: '数量', agg: 'sum', series: '旧渠道' } } });
  const degraded = documents.project({ ...loadSnapshotFromFile(file, loadConfig({}).LIMITS), instanceId: 'test-instance', version: 2 });
  const degradedComponent = degraded.components.find((component) => component.status === 'degraded');
  assert.ok(degradedComponent, '系列列缺失的组件应进入 degraded');
  const scan = await ai.maintenanceScan({ auto: false });
  assert.equal(scan.count, 1);
  assert.equal(scan.suggestion.patches[0].op, 'remap');
  // 维护建议同样要有画布预览：被修的那块组件必须给出修好之后的投影。
  assert.equal(scan.suggestion.preview.changed.length, 1);
  assert.equal(scan.suggestion.preview.changed[0].spec.id, degradedComponent.spec.id);
  assert.notEqual(scan.suggestion.preview.changed[0].spec.encoding.series, '旧渠道');
  assert.ok(scan.suggestion.preview.changed[0].data, '修复后的组件应带真实投影数据');
  assert.match(scan.suggestion.preview.steps[0], /^改数据编码/);
  documents.submit({ op: 'retitle', componentId: 'main-chart', title: '人工改名' });
  assert.throws(() => ai.acceptSuggestion(scan.suggestion.id), (error) => error.code === 'AI_SUGGESTION_STALE');
  const staleView = ai.suggestionsView().find((item) => item.id === scan.suggestion.id);
  assert.equal(staleView.state, 'stale');
});

test('编排器：外部模型输出非法时降级到规则模式，一次修复可救回合法输出', async () => {
  const file = path.resolve('data/sales.xlsx');
  const card = buildSchemaCard(loadSnapshotFromFile(file, loadConfig({}).LIMITS));

  const garbage = new MockProvider(async () => '抱歉，我不知道怎么配置。');
  const garbageStack = buildStack({ file, provider: garbage });
  garbageStack.notifier.close();
  const fallbackResult = await garbageStack.ai.chart('按地区看毛利排行');
  assert.equal(fallbackResult.task.status, 'fallback', '非法输出应降级到规则模式');
  assert.equal(fallbackResult.suggestion.patches[0].spec.encoding.y, '毛利');
  assert.equal(garbageStack.metrics.snapshot().counters.aiValidationFailures >= 1, true);
  assert.equal(garbageStack.metrics.snapshot().counters.aiFallbacks >= 1, true);

  let calls = 0;
  const repairable = new MockProvider(async (request) => {
    calls += 1;
    if (request.instructions.includes('上一次输出存在以下问题')) {
      return JSON.stringify({ type: 'bar', title: '修复后的图', encoding: { x: '地区', y: '销售额', agg: 'sum' }, rationale: '修复' });
    }
    return JSON.stringify({ type: 'bar', title: '坏图', encoding: { x: '幻觉列', y: '销售额', agg: 'sum' } });
  });
  const repairStack = buildStack({ file, provider: repairable });
  repairStack.notifier.close();
  const repaired = await repairStack.ai.chart('按地区看销售额对比');
  assert.equal(calls, 2, '应恰好触发一次修复');
  assert.equal(repaired.task.status, 'succeeded');
  assert.equal(repaired.suggestion.patches[0].spec.title, '修复后的图');
  assert.equal(repairStack.metrics.snapshot().counters.aiRepairAttempts, 1);
  assert.equal(card.columns.length > 0, true);
});

test('OpenAI 兼容提供者：payload 不含数据行，密钥只在请求头，非白名单地址被拒绝', async () => {
  const snapshot = loadSnapshotFromFile(path.resolve('data/sales.xlsx'), loadConfig({}).LIMITS);
  const card = buildSchemaCard(snapshot, { includeSamples: false });
  let captured = null;
  const provider = new OpenAiCompatibleProvider({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-test-key',
    model: 'test-model',
    allowedHosts: ['api.deepseek.com'],
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({ model: 'test-model', choices: [{ message: { content: '{"type":"bar","title":"T","encoding":{"x":"地区","y":"销售额","agg":"sum"}}' } }], usage: { prompt_tokens: 12, completion_tokens: 20 } }),
      };
    },
  });
  const response = await provider.complete({ task: 'chart', instructions: '只输出 JSON', context: { schemaCard: card }, temperature: 0.2, maxOutputTokens: 100, timeoutMs: 5_000 });
  const body = JSON.parse(captured.options.body);
  assert.equal(captured.url, 'https://api.deepseek.com/chat/completions');
  assert.match(captured.options.headers.Authorization, /^Bearer sk-test-key$/);
  assert.equal(body.stream, false);
  assert.equal(body.response_format.type, 'json_object');
  const context = JSON.parse(body.messages.find((message) => message.role === 'user').content);
  assert.ok(!('rows' in context.schemaCard), '上下文不得包含数据行');
  assert.ok(!context.schemaCard.columns.some((column) => 'samples' in column), '关闭样例后不得发送样例');
  assert.equal(response.usage.inputTokens, 12);

  assert.throws(() => new OpenAiCompatibleProvider({
    baseUrl: 'http://internal.intranet.evil',
    apiKey: 'k', model: 'm', allowedHosts: ['api.deepseek.com'], fetchImpl: async () => { throw new Error('不应发起请求'); },
  }), (error) => error.code === 'AI_BASE_URL_FORBIDDEN');
});

test('AI HTTP API：一句话建图、洞察扫描、维护建议、采纳与鉴权全链路', { timeout: 30_000 }, async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'live-sheet-ai-'));
  const file = path.join(directory, 'sales.xlsx');
  await fsp.copyFile(path.resolve('data/sales.xlsx'), file);
  const port = await freePort();
  const config = loadConfig({
    PORT: String(port), DATA_DIR: directory, TARGET_FILE: file,
    ENABLE_SIMULATE: '0', DEBOUNCE_MS: '0', RETRY_ATTEMPTS: '1', AI_PROVIDER: 'rule',
  });
  const application = createApplication({ config, logger: new LocalLogger({ sink: silent }) });
  await application.start();
  await application.ingest.refresh('测试初始化');
  t.after(async () => {
    await application.close();
    await fsp.rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;

  const caps = await (await fetch(`${base}/api/ai/capabilities`)).json();
  assert.equal(caps.provider, 'rule');
  assert.equal(caps.privacyMode, 'local-only');

  const empty = await postJson(`${base}/api/ai/chart`, { instruction: '' });
  assert.equal(empty.status, 400);

  const chart = await postJson(`${base}/api/ai/chart`, { instruction: '按地区看毛利排行' });
  assert.equal(chart.status, 200);
  const chartPayload = await chart.json();
  assert.equal(chartPayload.task.status, 'succeeded');
  assert.equal(chartPayload.suggestion.state, 'pending');
  const documentBefore = await (await fetch(`${base}/api/document`)).json();
  assert.equal(documentBefore.document.components.length, 7, '未采纳前组件数不变');

  const accept = await postJson(`${base}/api/ai/suggestions/${chartPayload.suggestion.id}/accept`, {});
  assert.equal(accept.status, 200);
  const documentAfter = await (await fetch(`${base}/api/document`)).json();
  assert.equal(documentAfter.document.components.length, 8);
  assert.equal(documentAfter.document.components.at(-1).encoding.y, '毛利');

  const repeatAccept = await postJson(`${base}/api/ai/suggestions/${chartPayload.suggestion.id}/accept`, {});
  assert.equal(repeatAccept.status, 409);

  const insight = await postJson(`${base}/api/ai/insights/scan`, {});
  assert.equal(insight.status, 200);
  const insightPayload = await insight.json();
  assert.equal(insightPayload.count, 1, '手动扫描应强制生成洞察');
  assert.ok(insightPayload.insight.statement.length > 0);
  const insightsList = await (await fetch(`${base}/api/ai/insights`)).json();
  assert.ok(insightsList.insights.length >= 1);

  const maintenance = await postJson(`${base}/api/ai/maintenance/scan`, {});
  const maintenancePayload = await maintenance.json();
  assert.equal(maintenancePayload.count, 0, '画布健康时不应产生维护建议');
  assert.match(maintenancePayload.reason, /正常/);

  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.ai.provider, 'rule');
  assert.equal(health.status, 'ok');

  const crossSite = await fetch(`${base}/api/ai/chart`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ instruction: '按地区看毛利排行' }),
  });
  assert.equal(crossSite.status, 403, 'AI 写接口必须经过 CSRF 校验');

  const task = await (await fetch(`${base}/api/ai/tasks/${chartPayload.task.id}`)).json();
  assert.equal(task.task.id, chartPayload.task.id);
  const missingTask = await fetch(`${base}/api/ai/tasks/not-exist`);
  assert.equal(missingTask.status, 404);
});

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
