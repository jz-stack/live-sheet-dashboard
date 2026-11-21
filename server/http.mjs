import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { AppError } from './errors.mjs';
import {
  isAuthenticated, readBody, resolvePublicFile, sessionCookie, setSecurityHeaders,
  validateHost, validateMutation, verifyAccessToken,
} from './security.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

async function sendFile(req, res, root, relativeName) {
  const file = await resolvePublicFile(root, relativeName);
  const handle = await fsp.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new AppError('资源不存在', { code: 'NOT_FOUND', status: 404 });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') {
      await handle.close();
      res.end();
      return;
    }
    await pipeline(handle.createReadStream(), res);
  } finally {
    await handle.close().catch(() => {});
  }
}

function integerParam(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new AppError('分页参数无效', { code: 'INVALID_PAGINATION', status: 400 });
  }
  return parsed;
}

async function jsonBody(req, config) {
  const body = await readBody(req, config.MAX_BODY_BYTES);
  return body ? JSON.parse(body) : {};
}

function notifyDocument(application, reason) {
  const document = application.documents.getCurrent();
  application.notifier.broadcast('document', { revision: document.revision, reason });
}

function healthPayload(application) {
  const dataset = application.repository.metadata();
  return {
    status: dataset.status === 'ready' ? 'ok' : ['error', 'missing'].includes(dataset.status) ? 'degraded' : 'starting',
    uptimeSeconds: Math.round(process.uptime()),
    memory: process.memoryUsage(),
    dataset: {
      version: dataset.version,
      revision: dataset.revision,
      status: dataset.status,
      rowCount: dataset.rowCount,
      updatedAt: dataset.updatedAt,
      source: { mode: dataset.mode, activeSheet: dataset.activeSheet, labels: dataset.sheets?.length || 0 },
    },
    ingest: application.ingest.status(),
    sse: { clients: application.notifier.count() },
    document: {
      revision: application.documents.getCurrent().revision,
      components: application.documents.getCurrent().components.length,
      storage: application.documents.storageStats(),
    },
    ai: application.ai.status(),
    metrics: application.metrics.snapshot(),
  };
}

export function createHttpServer(application) {
  const { config, repository, documents, ai, ingest, worker, notifier, logger, metrics } = application;
  const server = http.createServer(async (req, res) => {
    setSecurityHeaders(res);
    try {
      validateHost(req, config);
      const url = new URL(req.url, 'http://localhost');
      const { pathname } = url;

      if (pathname === '/api/session' && req.method === 'POST') {
        validateMutation(req, metrics);
        const body = await readBody(req, config.MAX_BODY_BYTES);
        const payload = body ? JSON.parse(body) : {};
        verifyAccessToken(payload.token, config);
        sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(config) });
        return;
      }
      if (pathname.startsWith('/api/') && !isAuthenticated(req, config)) {
        sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '需要访问口令' });
        return;
      }

      if (pathname === '/api/meta' && req.method === 'GET') {
        sendJson(res, 200, { name: 'live-sheet-dashboard', designVersion: '1.2', features: { simulate: config.ENABLE_SIMULATE, document: true, ai: true }, requiresAuth: Boolean(config.ACCESS_TOKEN) });
      } else if (pathname === '/api/state' && req.method === 'GET') {
        sendJson(res, 200, repository.metadata());
      } else if (pathname === '/api/sheets' && req.method === 'GET') {
        const state = repository.metadata();
        sendJson(res, 200, {
          mode: state.mode,
          activeSheet: state.activeSheet,
          sheetColumn: state.sheetColumn,
          sheets: state.sheets,
          rowCount: state.rowCount,
        });
      } else if (pathname === '/api/dataset/source' && req.method === 'POST') {
        validateMutation(req, metrics);
        const body = await jsonBody(req, config);
        const source = repository.setSource({ mode: body.mode, sheetName: body.sheet ?? body.sheetName ?? null });
        ai.expirePendingSuggestions('数据源已切换');
        const generation = ingest.schedule('切换数据源', { immediate: true });
        logger.info('数据源已切换', { mode: source.mode, activeSheet: source.activeSheet });
        sendJson(res, 202, { ok: true, source, generation });
      } else if (pathname === '/api/projection' && req.method === 'GET') {
        sendJson(res, 200, { ...repository.metadata(), ...documents.project(repository.snapshot()) });
      } else if (pathname === '/api/document' && req.method === 'GET') {
        sendJson(res, 200, documents.view());
      } else if (pathname === '/api/document' && req.method === 'PUT') {
        validateMutation(req, metrics);
        const document = documents.replace(await jsonBody(req, config));
        notifyDocument(application, '替换画布');
        sendJson(res, 200, { ok: true, document });
      } else if (pathname === '/api/document/reset' && req.method === 'POST') {
        validateMutation(req, metrics);
        await readBody(req, config.MAX_BODY_BYTES);
        const document = documents.reset(repository.snapshot());
        notifyDocument(application, '恢复默认布局');
        sendJson(res, 200, { ok: true, document });
      } else if (pathname === '/api/document/patches/dry-run' && req.method === 'POST') {
        validateMutation(req, metrics);
        const result = documents.dryRun(await jsonBody(req, config));
        sendJson(res, 200, { ok: true, ...result });
      } else if (pathname === '/api/document/patches' && req.method === 'POST') {
        validateMutation(req, metrics);
        const payload = await jsonBody(req, config);
        const result = documents.submit(payload, { draft: payload.draft === true });
        if (result.applied) notifyDocument(application, result.patch.reason || `应用 ${result.patch.op}`);
        sendJson(res, result.applied ? 200 : 202, { ok: true, ...result });
      } else if (req.method === 'POST' && /^\/api\/document\/patches\/[^/]+\/revert$/.test(pathname)) {
        validateMutation(req, metrics);
        await readBody(req, config.MAX_BODY_BYTES);
        const id = decodeURIComponent(pathname.split('/')[4]);
        const result = documents.revert(id);
        notifyDocument(application, '撤销上一步');
        sendJson(res, 200, { ok: true, ...result });
      } else if (req.method === 'POST' && /^\/api\/document\/drafts\/[^/]+\/(accept|reject)$/.test(pathname)) {
        validateMutation(req, metrics);
        await readBody(req, config.MAX_BODY_BYTES);
        const parts = pathname.split('/');
        const id = decodeURIComponent(parts[4]);
        const action = parts[5];
        const result = action === 'accept' ? documents.acceptDraft(id) : documents.rejectDraft(id);
        if (action === 'accept') notifyDocument(application, '采纳 Patch 草稿');
        sendJson(res, 200, { ok: true, ...result });
      } else if (pathname === '/api/ai/capabilities' && req.method === 'GET') {
        sendJson(res, 200, ai.capabilities());
      } else if (pathname === '/api/ai/chart' && req.method === 'POST') {
        validateMutation(req, metrics);
        const payload = await jsonBody(req, config);
        const instruction = typeof payload.instruction === 'string' ? payload.instruction.trim() : '';
        if (!instruction) throw new AppError('请输入建图指令', { code: 'INVALID_INSTRUCTION', status: 400 });
        if (instruction.length > 300) throw new AppError('指令过长（最多 300 字）', { code: 'INVALID_INSTRUCTION', status: 400 });
        const result = await ai.chart(instruction);
        sendJson(res, 200, { ok: true, ...result });
      } else if (pathname === '/api/ai/insights/scan' && req.method === 'POST') {
        validateMutation(req, metrics);
        await readBody(req, config.MAX_BODY_BYTES);
        sendJson(res, 200, { ok: true, ...(await ai.insightScan({ auto: false })) });
      } else if (pathname === '/api/ai/maintenance/scan' && req.method === 'POST') {
        validateMutation(req, metrics);
        await readBody(req, config.MAX_BODY_BYTES);
        sendJson(res, 200, { ok: true, ...(await ai.maintenanceScan({ auto: false })) });
      } else if (pathname === '/api/ai/suggestions' && req.method === 'GET') {
        sendJson(res, 200, { suggestions: ai.suggestionsView() });
      } else if (pathname === '/api/ai/insights' && req.method === 'GET') {
        sendJson(res, 200, { insights: ai.insightsView() });
      } else if (req.method === 'POST' && /^\/api\/ai\/suggestions\/[^/]+\/(accept|reject)$/.test(pathname)) {
        validateMutation(req, metrics);
        await readBody(req, config.MAX_BODY_BYTES);
        const parts = pathname.split('/');
        const id = decodeURIComponent(parts[4]);
        const result = parts[5] === 'accept' ? ai.acceptSuggestion(id) : ai.rejectSuggestion(id);
        sendJson(res, 200, { ok: true, ...result });
      } else if (req.method === 'GET' && /^\/api\/ai\/tasks\/[^/]+$/.test(pathname)) {
        sendJson(res, 200, { task: ai.taskView(decodeURIComponent(pathname.split('/')[4])) });
      } else if (req.method === 'POST' && /^\/api\/ai\/tasks\/[^/]+\/cancel$/.test(pathname)) {
        validateMutation(req, metrics);
        await readBody(req, config.MAX_BODY_BYTES);
        sendJson(res, 200, { ok: true, ...ai.cancelTask(decodeURIComponent(pathname.split('/')[4])) });
      } else if (pathname === '/api/rows' && req.method === 'GET') {
        const offset = integerParam(url.searchParams.get('offset'), 0);
        const limit = integerParam(url.searchParams.get('limit'), 100, { min: 1, max: config.MAX_PAGE_SIZE });
        sendJson(res, 200, repository.getRows(offset, limit));
      } else if (pathname === '/api/health' && req.method === 'GET') {
        sendJson(res, 200, healthPayload(application));
      } else if (pathname === '/api/ready' && req.method === 'GET') {
        const health = healthPayload(application);
        sendJson(res, health.status === 'ok' ? 200 : 503, health);
      } else if (pathname === '/api/diagnostics' && req.method === 'GET') {
        sendJson(res, 200, { health: healthPayload(application), logs: logger.recent() });
      } else if (pathname === '/api/events' && req.method === 'GET') {
        if (notifier.clients.size >= config.MAX_SSE_CLIENTS) throw new AppError('实时连接数已满', { code: 'TOO_MANY_CLIENTS', status: 503 });
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const state = repository.metadata();
        notifier.add(req, res, { version: state.version, revision: state.revision, status: state.status });
      } else if (pathname === '/api/reload' && req.method === 'POST') {
        validateMutation(req, metrics);
        await readBody(req, config.MAX_BODY_BYTES);
        const generation = ingest.schedule('手动刷新', { immediate: true });
        sendJson(res, 202, { ok: true, generation });
      } else if (pathname === '/api/simulate' && req.method === 'POST' && config.ENABLE_SIMULATE) {
        validateMutation(req, metrics);
        await readBody(req, config.MAX_BODY_BYTES);
        try {
          const result = await worker.simulate(config.TARGET_FILE, repository.metadata().activeSheet);
          sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          if (error.code === 'ENOENT') throw new AppError('目标文件不存在，请先运行 npm run sample', { code: 'NOT_FOUND', status: 404 });
          throw error;
        }
      } else if (pathname.startsWith('/api/')) {
        throw new AppError('接口不存在或方法不允许', { code: 'NOT_FOUND', status: 404 });
      } else if (pathname.startsWith('/vendor/') && ['GET', 'HEAD'].includes(req.method)) {
        await sendFile(req, res, config.ECHARTS_DIST, pathname.slice('/vendor/'.length));
      } else if (['GET', 'HEAD'].includes(req.method)) {
        await sendFile(req, res, config.WEB_DIR, pathname === '/' ? 'index.html' : pathname.slice(1));
      } else {
        throw new AppError('方法不允许', { code: 'METHOD_NOT_ALLOWED', status: 405 });
      }
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const status = error.status || (error instanceof SyntaxError ? 400 : 500);
      if (status >= 500) logger.error('HTTP 请求失败', { method: req.method, url: req.url, code: error.code, message: error.message });
      if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
      if (!res.headersSent) {
        sendJson(res, status, {
          ok: false,
          code: error.code || 'INTERNAL_ERROR',
          message: status >= 500 ? '服务内部错误，请查看诊断日志' : error.message,
        });
      } else res.destroy();
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1000;
  server.on('clientError', (error, socket) => {
    logger.warn('HTTP 协议错误', { message: error.message });
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  return server;
}
