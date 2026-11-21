import crypto from 'node:crypto';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { AppError } from './errors.mjs';

export const SESSION_COOKIE = 'live_sheet_session';

export function setSecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

export function validateHost(req, config) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!config.ALLOWED_HOSTS.map((item) => item.toLowerCase()).includes(host)) {
    throw new AppError('Host 不在允许列表中', { code: 'INVALID_HOST', status: 403 });
  }
}

export function validateMutation(req, metrics) {
  const fetchSite = String(req.headers['sec-fetch-site'] || '');
  const origin = req.headers.origin;
  if (fetchSite === 'cross-site' || (origin && new URL(origin).host !== req.headers.host)) {
    metrics.increment('rejectedRequests');
    throw new AppError('拒绝跨站写操作', { code: 'CSRF_REJECTED', status: 403 });
  }
}

function sessionValue(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function isAuthenticated(req, config) {
  if (!config.ACCESS_TOKEN) return true;
  const authorization = String(req.headers.authorization || '');
  if (authorization.startsWith('Bearer ') && safeEqual(authorization.slice(7), config.ACCESS_TOKEN)) return true;
  const cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter(([key]) => key));
  return Boolean(cookies[SESSION_COOKIE] && safeEqual(cookies[SESSION_COOKIE], sessionValue(config.ACCESS_TOKEN)));
}

export function sessionCookie(config) {
  return `${SESSION_COOKIE}=${sessionValue(config.ACCESS_TOKEN)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`;
}

export function verifyAccessToken(token, config) {
  if (!config.ACCESS_TOKEN || !safeEqual(String(token || ''), config.ACCESS_TOKEN)) {
    throw new AppError('访问口令错误', { code: 'UNAUTHORIZED', status: 401 });
  }
}

export async function readBody(req, limit) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > limit) throw new AppError('请求体过大', { code: 'BODY_TOO_LARGE', status: 413 });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new AppError('请求体过大', { code: 'BODY_TOO_LARGE', status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function ensureInside(root, target) {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new AppError('禁止访问该路径', { code: 'PATH_FORBIDDEN', status: 403 });
  }
}

export async function resolvePublicFile(root, relativeName) {
  let decoded;
  try {
    decoded = decodeURIComponent(relativeName);
  } catch {
    throw new AppError('URL 编码无效', { code: 'INVALID_URL', status: 400 });
  }
  if (decoded.includes('\0')) throw new AppError('路径无效', { code: 'INVALID_URL', status: 400 });
  const realRoot = await fsp.realpath(root);
  const candidate = path.resolve(realRoot, decoded);
  ensureInside(realRoot, candidate);
  let realTarget;
  try {
    realTarget = await fsp.realpath(candidate);
  } catch {
    throw new AppError('资源不存在', { code: 'NOT_FOUND', status: 404 });
  }
  ensureInside(realRoot, realTarget);
  return realTarget;
}
