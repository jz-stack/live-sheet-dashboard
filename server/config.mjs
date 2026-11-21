import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(here, '..');

// 项目根目录的 .env 会自动加载；已存在的系统环境变量优先级更高，不会被覆盖。
const ENV_FILE = path.join(PROJECT_ROOT, '.env');
if (typeof process.loadEnvFile === 'function' && fs.existsSync(ENV_FILE)) {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch (error) {
    console.warn(`[config] .env 解析失败，已忽略：${error.message}`);
  }
}

function integer(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`配置值 ${value} 无效，应在 ${min}~${max} 之间`);
  }
  return parsed;
}

function list(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

export function loadConfig(overrides = {}) {
  const env = { ...process.env, ...overrides };
  const port = integer(env.PORT, 3000, { min: 1, max: 65535 });
  const host = env.HOST || '127.0.0.1';
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  const accessToken = env.ACCESS_TOKEN || '';
  const configuredHosts = list(env.ALLOWED_HOSTS);

  if (!loopback && !accessToken) {
    throw new Error('绑定非回环地址时必须设置 ACCESS_TOKEN');
  }
  if (!loopback && configuredHosts.length === 0) {
    throw new Error('绑定非回环地址时必须设置 ALLOWED_HOSTS（逗号分隔的 host:port）');
  }

  const dataDir = path.resolve(env.DATA_DIR || path.join(PROJECT_ROOT, 'data'));
  const targetFile = path.resolve(env.TARGET_FILE || path.join(dataDir, 'sales.xlsx'));
  // 画布配置默认与数据同目录，便于整体备份；可用 DOCUMENT_FILE 指向别处
  const documentFile = path.resolve(env.DOCUMENT_FILE || path.join(dataDir, 'document.json'));
  const allowedHosts = configuredHosts.length
    ? configuredHosts
    : [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];

  const aiProvider = ['rule', 'openai'].includes(env.AI_PROVIDER) ? env.AI_PROVIDER : 'rule';
  const aiApiKey = env.AI_API_KEY || '';
  const effectiveProvider = aiProvider === 'openai' && !aiApiKey ? 'rule' : aiProvider;
  const allowedAiHosts = list(env.AI_ALLOWED_HOSTS).length
    ? list(env.AI_ALLOWED_HOSTS)
    : ['api.deepseek.com', 'api.openai.com', 'dashscope.aliyuncs.com', 'open.bigmodel.cn'];

  return Object.freeze({
    ROOT: PROJECT_ROOT,
    WEB_DIR: path.join(PROJECT_ROOT, 'web'),
    DATA_DIR: dataDir,
    ECHARTS_DIST: path.join(PROJECT_ROOT, 'node_modules', 'echarts', 'dist'),
    HOST: host,
    PORT: port,
    LOOPBACK: loopback,
    TARGET_FILE: targetFile,
    DOCUMENT_FILE: documentFile,
    ACCESS_TOKEN: accessToken,
    ALLOWED_HOSTS: allowedHosts,
    ENABLE_SIMULATE: env.ENABLE_SIMULATE === '1' || process.argv.includes('--dev'),
    MAX_BODY_BYTES: integer(env.MAX_BODY_BYTES, 16 * 1024, { min: 128, max: 1024 * 1024 }),
    MAX_SSE_CLIENTS: integer(env.MAX_SSE_CLIENTS, 32, { min: 1, max: 1000 }),
    MAX_SSE_BUFFER_BYTES: integer(env.MAX_SSE_BUFFER_BYTES, 64 * 1024, { min: 4096 }),
    MAX_PAGE_SIZE: integer(env.MAX_PAGE_SIZE, 500, { min: 1, max: 5000 }),
    WORKER_TIMEOUT_MS: integer(env.WORKER_TIMEOUT_MS, 30_000, { min: 1000 }),
    WORKER_MEMORY_MB: integer(env.WORKER_MEMORY_MB, 512, { min: 64, max: 4096 }),
    RETRY_ATTEMPTS: integer(env.RETRY_ATTEMPTS, 6, { min: 1, max: 20 }),
    DEBOUNCE_MS: integer(env.DEBOUNCE_MS, 220, { min: 0, max: 10_000 }),
    LIMITS: Object.freeze({
      maxFileBytes: integer(env.MAX_FILE_BYTES, 25 * 1024 * 1024, { min: 1024 }),
      maxRows: integer(env.MAX_ROWS, 100_000, { min: 1 }),
      maxColumns: integer(env.MAX_COLUMNS, 100, { min: 1 }),
      maxCells: integer(env.MAX_CELLS, 2_000_000, { min: 1 }),
      // 合并视图：单表行数仍受 maxRows 限制，这里约束整本工作簿的张数与总行数
      maxSheets: integer(env.MAX_SHEETS, 50, { min: 1, max: 500 }),
      maxWorkbookRows: integer(env.MAX_WORKBOOK_ROWS, 200_000, { min: 1 }),
      skipTotalRows: env.SKIP_TOTAL_ROWS !== '0',
    }),
    // 默认合并所有工作表，把 sheet 当成可对比的系列维度
    SOURCE_MODE: env.SOURCE_MODE === 'sheet' ? 'sheet' : 'merged',
    AI: Object.freeze({
      PROVIDER: effectiveProvider,
      CONFIGURED_PROVIDER: aiProvider,
      BASE_URL: env.AI_BASE_URL || 'https://api.deepseek.com',
      API_KEY: aiApiKey,
      MODEL: env.AI_MODEL || 'deepseek-chat',
      ALLOWED_HOSTS: Object.freeze(allowedAiHosts),
      TIMEOUT_MS: integer(env.AI_TIMEOUT_MS, 20_000, { min: 1_000 }),
      CONCURRENCY: integer(env.AI_CONCURRENCY, 2, { min: 1, max: 10 }),
      MAX_DAILY_TASKS: integer(env.AI_MAX_DAILY_TASKS, 200, { min: 1 }),
      INCLUDE_SAMPLES: env.AI_SAMPLES !== '0',
      AUTO_INSIGHT: env.AI_AUTO_INSIGHT !== '0',
      INSIGHT_COOLDOWN_MS: integer(env.AI_INSIGHT_COOLDOWN_MS, 30_000, { min: 0 }),
      MAINTENANCE_COOLDOWN_MS: integer(env.AI_MAINTENANCE_COOLDOWN_MS, 60_000, { min: 0 }),
    }),
  });
}

export const config = loadConfig();
export const {
  ROOT,
  WEB_DIR,
  DATA_DIR,
  ECHARTS_DIST,
  HOST,
  PORT,
  TARGET_FILE,
} = config;
