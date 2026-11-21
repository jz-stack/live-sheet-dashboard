import { config as defaultConfig } from './config.mjs';
import { SnapshotRepository } from './dataset.mjs';
import { DocumentRepository } from './document-repository.mjs';
import { DocumentStore } from './document-store.mjs';
import { LocalLogger } from './logger.mjs';
import { LocalMetrics } from './metrics.mjs';
import { WorkbookWorker } from './worker-client.mjs';
import { SseNotifier } from './sse.mjs';
import { IngestService } from './ingest.mjs';
import { createHttpServer } from './http.mjs';
import { startWatcher } from './watcher.mjs';
import { AiOrchestrator } from './ai/orchestrator.mjs';

export function createApplication({ config = defaultConfig, logger = new LocalLogger(), metrics = new LocalMetrics() } = {}) {
  const repository = new SnapshotRepository({ mode: config.SOURCE_MODE });
  const documentStore = new DocumentStore({ file: config.DOCUMENT_FILE, logger });
  const documents = new DocumentRepository({ store: documentStore, logger });
  const worker = new WorkbookWorker({ config, logger, metrics });
  const notifier = new SseNotifier({ config, logger, metrics });
  const ai = new AiOrchestrator({ config, logger, metrics, repository, documents, notifier });
  const ingest = new IngestService({
    config, repository, worker, notifier, logger, metrics,
    // 切换数据源只是换视图，不触发 AI 自动任务，避免生成“把分表图改成日期图”这类无意义建议
    onCommit: (state) => (state?.reason === '切换数据源' ? undefined : ai.onDatasetUpdated()),
  });
  const application = { config, logger, metrics, repository, documents, ai, worker, notifier, ingest, watcher: null, server: null, closing: false };
  application.server = createHttpServer(application);

  application.start = async () => {
    await new Promise((resolve, reject) => {
      application.server.once('error', reject);
      application.server.listen(config.PORT, config.HOST, resolve);
    });
    application.watcher = startWatcher({ config, ingest, logger });
    logger.info('实时数据大屏已启动', { host: config.HOST, port: config.PORT, simulate: config.ENABLE_SIMULATE, ai: ai.status() });
  };

  application.close = async () => {
    if (application.closing) return;
    application.closing = true;
    ai.close();
    if (application.watcher) await application.watcher.close();
    await ingest.close();
    await documents.flush();
    notifier.close();
    if (application.server.listening) {
      await new Promise((resolve) => application.server.close(resolve));
      application.server.closeAllConnections?.();
    }
    logger.info('服务已安全关闭');
  };
  return application;
}
