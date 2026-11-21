import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';
import { DATA_DIR, TARGET_FILE } from '../server/config.mjs';

XLSX.set_fs(fs);

fs.mkdirSync(DATA_DIR, { recursive: true });

const REGIONS = ['华东', '华南', '华北', '西南'];
const CATEGORIES = ['标准版', '专业版', '定制版'];
const DAYS = 30;

const dayKey = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() - (DAYS - 1 - offset));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const rows = [['日期', '地区', '品类', '销售额', '数量', '毛利']];
let total = 0;
let totalQty = 0;
let totalProfit = 0;

for (let d = 0; d < DAYS; d += 1) {
  for (const region of REGIONS) {
    const category = CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
    const qty = 20 + Math.floor(Math.random() * 90);
    const amount = Math.round(qty * (280 + Math.random() * 220));
    const profit = Math.round(amount * (0.16 + Math.random() * 0.18));
    total += amount;
    totalQty += qty;
    totalProfit += profit;
    rows.push([dayKey(d), region, category, amount, qty, profit]);
  }
}

rows.push(['合计', '', '', total, totalQty, totalProfit]);

const sheet = XLSX.utils.aoa_to_sheet(rows);
sheet['!cols'] = [{ wch: 12 }, { wch: 8 }, { wch: 10 }, { wch: 12 }, { wch: 8 }, { wch: 12 }];

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, sheet, '销售明细');
XLSX.writeFile(wb, TARGET_FILE);

console.log(`已生成示例数据 ${path.relative(process.cwd(), TARGET_FILE)} · ${rows.length - 2} 行明细 + 1 行合计`);
