import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';
import { config, DATA_DIR } from '../server/config.mjs';
import { WorkbookWorker } from '../server/worker-client.mjs';
import { LocalLogger } from '../server/logger.mjs';
import { LocalMetrics } from '../server/metrics.mjs';

XLSX.set_fs(fs);
const rowCount = Number(process.env.BENCH_ROWS || 10_000);
if (!Number.isInteger(rowCount) || rowCount < 1 || rowCount > config.LIMITS.maxRows) throw new Error('BENCH_ROWS 超出允许范围');
fs.mkdirSync(DATA_DIR, { recursive: true });
const file = path.join(DATA_DIR, `.benchmark-${process.pid}.xlsx`);
const rows = [['日期', '地区', '品类', '销售额', '数量', '毛利']];
for (let index = 0; index < rowCount; index += 1) {
  const amount = index % 10_000;
  rows.push([`2026-01-${String(index % 30 + 1).padStart(2, '0')}`, `地区${index % 8}`, `品类${index % 5}`, amount, index % 100, amount * 0.2]);
}
const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), '基准');
XLSX.writeFile(workbook, file);
const logger = new LocalLogger({ sink: { log() {}, warn() {}, error() {} } });
const metrics = new LocalMetrics();
const worker = new WorkbookWorker({ config, logger, metrics });
try {
  const before = process.memoryUsage();
  const startedAt = performance.now();
  const { parsed, projection } = await worker.parse(file);
  const totalMs = performance.now() - startedAt;
  const after = process.memoryUsage();
  console.log(JSON.stringify({ rows: parsed.rowCount, columns: parsed.headers.length, parseMs: parsed.parseMs, workerRoundTripMs: Number(totalMs.toFixed(1)), mainPoints: projection.main?.points.length, subPoints: projection.sub?.points.length, heapDeltaMb: Number(((after.heapUsed - before.heapUsed) / 1024 / 1024).toFixed(1)), rssMb: Number((after.rss / 1024 / 1024).toFixed(1)) }, null, 2));
} finally {
  await worker.close();
  fs.rmSync(file, { force: true });
}
