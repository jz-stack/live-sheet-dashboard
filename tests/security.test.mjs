import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { loadConfig } from '../server/config.mjs';
import { readBody, resolvePublicFile, validateMutation } from '../server/security.mjs';

const metrics = { increment() {} };

test('非回环监听必须同时配置口令与 Host 白名单', () => {
  assert.throws(() => loadConfig({ HOST: '0.0.0.0', ACCESS_TOKEN: '', ALLOWED_HOSTS: '' }), /ACCESS_TOKEN/);
  assert.throws(() => loadConfig({ HOST: '0.0.0.0', ACCESS_TOKEN: 'secret', ALLOWED_HOSTS: '' }), /ALLOWED_HOSTS/);
  const config = loadConfig({ HOST: '0.0.0.0', ACCESS_TOKEN: 'secret', ALLOWED_HOSTS: 'screen.local:3000' });
  assert.deepEqual(config.ALLOWED_HOSTS, ['screen.local:3000']);
});

test('请求体按声明大小和实际大小双重限制', async () => {
  const request = Readable.from([Buffer.from('12345')]);
  request.headers = {};
  await assert.rejects(() => readBody(request, 4), (error) => error.status === 413);
  const declared = Readable.from([]);
  declared.headers = { 'content-length': '100' };
  await assert.rejects(() => readBody(declared, 4), (error) => error.status === 413);
});

test('跨站写操作被拒绝，同源写操作允许', () => {
  assert.throws(() => validateMutation({ headers: { origin: 'https://evil.example', host: '127.0.0.1:3000' } }, metrics), (error) => error.code === 'CSRF_REJECTED');
  assert.doesNotThrow(() => validateMutation({ headers: { origin: 'http://127.0.0.1:3000', host: '127.0.0.1:3000' } }, metrics));
});

test('静态资源路径不能越出根目录', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'live-sheet-security-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  await fsp.writeFile(path.join(directory, 'ok.txt'), 'ok');
  assert.equal(await resolvePublicFile(directory, 'ok.txt'), path.join(directory, 'ok.txt'));
  await assert.rejects(() => resolvePublicFile(directory, '..%2Fsecret.txt'), (error) => error.status === 403);
  await assert.rejects(() => resolvePublicFile(directory, '%'), (error) => error.status === 400);
});
