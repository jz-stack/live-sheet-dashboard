// 办公表冒烟检查：逐份解析 -> 生成默认布局 -> 投影，确认每张表都能出 7 个可用组件。
// 不依赖浏览器与独立端口，几秒内跑完，用于换表后快速自查。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkbookSource } from '../server/parser.mjs';
import { createEmptyDocument, generateDefaultDocument } from '../server/document.mjs';
import { projectDocument } from '../server/component-projection.mjs';
import { config } from '../server/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.resolve(process.argv[2] || path.join(ROOT, 'data/samples'));

if (!fs.existsSync(DIR)) {
  console.error(`目录不存在：${DIR}\n先执行 npm run sample:office 生成示例表。`);
  process.exit(1);
}

const files = fs.readdirSync(DIR).filter((name) => /\.(xlsx|xls|csv)$/i.test(name)).sort();
if (!files.length) {
  console.error(`目录里没有可用的表格：${DIR}`);
  process.exit(1);
}

let failed = 0;
const rows = [];

for (const file of files) {
  const target = path.join(DIR, file);
  try {
    const snapshot = parseWorkbookSource(target, config.LIMITS, { mode: 'sheet' });
    const document = generateDefaultDocument(snapshot, createEmptyDocument());
    const projection = projectDocument(document, snapshot);
    const bad = projection.components.filter((component) => component.status !== 'ok');
    const summary = {
      file,
      rows: snapshot.rowCount,
      columns: snapshot.headers.length,
      components: projection.components.length,
      ok: projection.components.length - bad.length,
      bad: bad.map((component) => `${component.spec.title}(${component.status}: ${component.reason || ''})`),
      warnings: snapshot.warnings.map((warning) => warning.code),
      measure: document.components.find((component) => component.id === 'kpi-sum')?.encoding?.y || null,
    };
    rows.push(summary);
    if (bad.length) failed += 1;
  } catch (error) {
    failed += 1;
    rows.push({ file, error: error.message });
  }
}

const width = Math.max(...rows.map((row) => row.file.length), 6);
console.log(`${'表格'.padEnd(width)}  ${'行数'.padStart(6)}  ${'列'.padStart(3)}  ${'组件'.padStart(6)}  主指标      结论`);
console.log('─'.repeat(width + 46));
for (const row of rows) {
  if (row.error) {
    console.log(`${row.file.padEnd(width)}  ${'—'.padStart(6)}  ${'—'.padStart(3)}  ${'—'.padStart(6)}  ${''.padEnd(10)}  ✗ ${row.error}`);
    continue;
  }
  const verdict = row.bad.length ? `✗ ${row.bad.join('；')}` : '✓ 正常';
  console.log(
    `${row.file.padEnd(width)}  ${String(row.rows).padStart(6)}  ${String(row.columns).padStart(3)}  `
    + `${`${row.ok}/${row.components}`.padStart(6)}  ${String(row.measure || '—').padEnd(10)}  ${verdict}`,
  );
  if (row.warnings.length) console.log(`${''.padEnd(width)}  ↳ 警告：${[...new Set(row.warnings)].join(', ')}`);
}

console.log(`\n共 ${rows.length} 份表，${rows.length - failed} 份正常，${failed} 份异常。`);
process.exit(failed ? 1 : 0);
