// 用 CDP 截图：SSE 长连接会让 --virtual-time-budget 永远等不到网络空闲，
// 所以必须走 DevTools 协议，自己控制导航与等待。
// 用法：node scripts/screenshot.mjs --url http://127.0.0.1:3000/ --out shot.png [--w 1600] [--h 1000] [--wait 2500] [--eval "js"]

import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = new Map();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  if (argv[i]?.startsWith('--')) args.set(argv[i].slice(2), argv[i + 1]);
}

const url = args.get('url') || 'http://127.0.0.1:3000/';
const out = args.get('out') || 'shot.png';
const width = Number(args.get('w') || 1600);
const height = Number(args.get('h') || 1000);
const waitMs = Number(args.get('wait') || 2500);
const evalScript = args.get('eval');
const clip = args.get('clip'); // "x,y,w,h[,scale]" 用于放大局部细节

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const PORT = 9333 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(join(tmpdir(), 'cdp-shot-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(CHROME[0], [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--hide-scrollbars', '--force-device-scale-factor=1',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  `--window-size=${width},${height}`, 'about:blank',
], { stdio: 'ignore', detached: false });

let exitCode = 0;

async function waitForDevtools() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return await res.json();
    } catch { /* 还没起来 */ }
    await sleep(150);
  }
  throw new Error('DevTools 端口未就绪');
}

function createClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      for (const fn of listeners) fn(msg);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
  });
  return {
    ready,
    on: (fn) => listeners.push(fn),
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    }),
    close: () => ws.close(),
  };
}

try {
  await waitForDevtools();
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' });
  const target = await res.json();

  const client = createClient(target.webSocketDebuggerUrl);
  await client.ready;

  const consoleErrors = [];
  client.on((msg) => {
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(msg.params.exceptionDetails.text + ' ' + (msg.params.exceptionDetails.exception?.description || ''));
    }
  });

  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  });

  await client.send('Page.navigate', { url });
  await sleep(waitMs);

  if (evalScript) {
    const result = await client.send('Runtime.evaluate', {
      expression: evalScript, awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error('eval 失败：' + result.exceptionDetails.text);
    if (result.result?.value !== undefined) console.log('EVAL:', JSON.stringify(result.result.value));
    await sleep(800);
  }

  const shotParams = { format: 'png', captureBeyondViewport: false };
  if (clip) {
    const [x, y, w, h, scale = 2] = clip.split(',').map(Number);
    shotParams.clip = { x, y, width: w, height: h, scale };
  }
  const shot = await client.send('Page.captureScreenshot', shotParams);
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('saved:', out, `${width}x${height}`);
  if (consoleErrors.length) {
    console.log('console errors:', consoleErrors.length);
    for (const line of consoleErrors.slice(0, 10)) console.log('  -', line);
  } else {
    console.log('console errors: 0');
  }

  client.close();
} catch (error) {
  console.error('FAILED:', error.message);
  exitCode = 1;
} finally {
  child.kill();
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
  process.exit(exitCode);
}
