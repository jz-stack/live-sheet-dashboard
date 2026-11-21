import path from 'node:path';
import chokidar from 'chokidar';

function comparable(file) {
  const normalized = path.normalize(path.resolve(file));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function startWatcher({ config, ingest, logger }) {
  const target = comparable(config.TARGET_FILE);
  const directory = path.dirname(config.TARGET_FILE);
  const isTarget = (file) => comparable(file) === target;
  logger.info('启动文件监听', { directory });

  const watcher = chokidar.watch(directory, {
    depth: 0,
    ignoreInitial: true,
    atomic: true,
    awaitWriteFinish: { stabilityThreshold: 350, pollInterval: 60 },
  });
  watcher
    .on('add', (file) => { if (isTarget(file)) ingest.schedule('文件创建'); })
    .on('change', (file) => { if (isTarget(file)) ingest.schedule('文件保存'); })
    .on('unlink', (file) => { if (isTarget(file)) ingest.markMissing(); })
    .on('error', (error) => logger.error('文件监听错误', { message: error.message, code: error.code }))
    .on('ready', () => ingest.schedule('启动加载'));
  return watcher;
}
