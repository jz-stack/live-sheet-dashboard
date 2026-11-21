import { createApplication } from './app.mjs';

const application = createApplication();
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  application.logger.info('收到退出信号', { signal });
  const forced = setTimeout(() => process.exit(1), 8000);
  forced.unref();
  try {
    await application.close();
    process.exit(0);
  } catch (error) {
    application.logger.error('安全关闭失败', { message: error.message });
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => {
  application.logger.error('未处理的 Promise 拒绝', { message: error?.message, stack: error?.stack });
  shutdown('unhandledRejection');
});
process.on('uncaughtException', (error) => {
  application.logger.error('未捕获异常', { message: error?.message, stack: error?.stack });
  shutdown('uncaughtException');
});

application.start().catch((error) => {
  const hint = error.code === 'EADDRINUSE' ? '；可执行 PORT=3001 npm start 更换端口' : '';
  application.logger.error('服务启动失败', { code: error.code, message: `${error.message}${hint}` });
  process.exit(1);
});
