import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';
import { DATA_DIR } from '../server/config.mjs';

XLSX.set_fs(fs);

/**
 * 生成一个多工作表示例，用来验证「合并视图」与分表对比。
 * 6 张同构月表（结构一致，合并后靠虚拟列「工作表」区分）+ 1 张隐藏说明页。
 * 不动 TARGET_FILE，只额外产出 demo-multi.xlsx，可安全重复执行。
 */
fs.mkdirSync(DATA_DIR, { recursive: true });
const output = path.join(DATA_DIR, 'demo-multi.xlsx');

const REGIONS = ['华东', '华南', '华北', '西南'];
const CATEGORIES = ['标准版', '专业版', '定制版'];
// factor 控制每月体量，形成明显趋势（Q1 爬坡、6 月冲高），折线/柱状才有看头
const MONTHS = [
  { name: '1月', days: 8, factor: 0.82 },
  { name: '2月', days: 8, factor: 0.68 },
  { name: '3月', days: 8, factor: 1.05 },
  { name: '4月', days: 8, factor: 0.96 },
  { name: '5月', days: 8, factor: 1.18 },
  { name: '6月', days: 8, factor: 1.42 },
];

const dayKey = (month, offset) => `2026-${String(month).padStart(2, '0')}-${String(offset + 1).padStart(2, '0')}`;

const workbook = XLSX.utils.book_new();
let totalRows = 0;

MONTHS.forEach((month, monthIndex) => {
  const rows = [['日期', '地区', '品类', '销售额', '数量', '毛利']];
  for (let day = 0; day < month.days; day += 1) {
    for (const region of REGIONS) {
      const category = CATEGORIES[(day + monthIndex) % CATEGORIES.length];
      const qty = Math.round((20 + Math.random() * 90) * month.factor);
      const amount = Math.round(qty * (280 + Math.random() * 220));
      const profit = Math.round(amount * (0.16 + Math.random() * 0.19));
      rows.push([dayKey(monthIndex + 1, day), region, category, amount, qty, profit]);
    }
  }
  totalRows += rows.length - 1;
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = [{ wch: 12 }, { wch: 8 }, { wch: 10 }, { wch: 12 }, { wch: 8 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(workbook, sheet, month.name);
});

// 隐藏的说明页：合并视图会自动跳过，用来验证「隐藏表不参与合并」
const notes = XLSX.utils.aoa_to_sheet([
  ['说明', '本页仅用于演示隐藏表被跳过'],
  ['数据', '1月–6月 为结构完全一致的同构表，合并后由虚拟列「工作表」区分来源'],
]);
notes['!cols'] = [{ wch: 8 }, { wch: 60 }];
XLSX.utils.book_append_sheet(workbook, notes, '说明');
workbook.Workbook = { Sheets: MONTHS.map(() => ({})).concat([{ Hidden: 1 }]) };

XLSX.writeFile(workbook, output);
console.log(`已生成多表示例 ${path.relative(process.cwd(), output)}`);
console.log(`  ${MONTHS.length} 张数据表 / ${totalRows} 行 + 1 张隐藏说明页`);
console.log(`  工作表：${MONTHS.map((month) => month.name).join('、')}`);
console.log('切换方式：把 .env 的 TARGET_FILE 指向它，或在页面顶部「数据源」下拉里切换');
