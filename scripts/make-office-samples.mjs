// 生成一组常见办公场景的 Excel 数据表，用于验证解析、默认布局与画布渲染。
// 覆盖：文本 ID、日期字符串、日期单元格、百分比列、标题行、合计行、小数工时、布尔式文本。
import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';

XLSX.set_fs(fs);

const OUT_DIR = path.resolve(process.argv[2] || 'data/samples');
fs.mkdirSync(OUT_DIR, { recursive: true });

// 确定性伪随机，保证每次生成的表一致，便于对比截图
let seed = 20261114;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];
const int = (min, max) => min + Math.floor(rnd() * (max - min + 1));
const round = (value, digits = 0) => Number(value.toFixed(digits));

const BASE = new Date(2026, 0, 6);
const dayString = (offset) => {
  const date = new Date(BASE);
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

const files = [];
function write(name, sheetName, rows, widths) {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = widths.map((wch) => ({ wch }));
  sheet['!freeze'] = { xSplit: 0, ySplit: 1 };
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  const file = path.join(OUT_DIR, name);
  XLSX.writeFile(workbook, file);
  files.push({ name, sheetName, file, rows: rows.length - 1 });
  return file;
}

// ---------------------------------------------------------------- 1. 销售订单
{
  const customers = ['上海远达贸易', '深圳恒信科技', '北京中启电子', '广州博晟实业', '成都云图信息', '杭州联恒智能', '南京华创机械', '武汉长江物联'];
  const regions = ['华东', '华南', '华北', '西南'];
  const products = ['智能网关', '工业传感器', '边缘计算盒', '无线采集器', '数据中继器', '控制主机'];
  const statuses = ['已完成', '已完成', '已发货', '待付款', '已取消'];
  const rows = [['订单号', '下单日期', '客户', '地区', '产品', '数量', '单价', '金额', '状态']];
  for (let i = 0; i < 120; i += 1) {
    const quantity = int(1, 60);
    const price = int(280, 4200);
    rows.push([
      `SO-2026-${String(i + 1).padStart(4, '0')}`,
      dayString(int(0, 150)),
      pick(customers),
      pick(regions),
      pick(products),
      quantity,
      price,
      quantity * price,
      pick(statuses),
    ]);
  }
  write('01-sales-orders.xlsx', '销售订单', rows, [15, 12, 16, 8, 14, 8, 9, 12, 10]);
}

// ---------------------------------------------------------------- 2. 员工花名册（真实日期单元格）
{
  const surnames = ['张', '王', '李', '赵', '陈', '刘', '杨', '黄', '周', '吴', '徐', '孙', '马', '朱'];
  const givenNames = ['伟', '芳', '娜', '敏', '静', '磊', '洋', '勇', '艳', '杰', '涛', '明', '超', '霞', '平', '刚'];
  const departments = ['销售部', '市场部', '技术部', '财务部', '人力资源部', '客服部'];
  const titles = ['总监', '经理', '主管', '高级专员', '专员', '工程师'];
  const rows = [['工号', '姓名', '部门', '职位', '入职日期', '月薪', '绩效评分']];
  for (let i = 0; i < 86; i += 1) {
    const join = new Date(BASE);
    join.setDate(join.getDate() - int(60, 2600));
    rows.push([
      `EMP${String(1001 + i)}`,
      `${pick(surnames)}${pick(givenNames)}`,
      pick(departments),
      pick(titles),
      join,
      int(16, 90) * 500,
      round(3 + rnd() * 2, 1),
    ]);
  }
  write('02-hr-roster.xlsx', '员工花名册', rows, [9, 10, 12, 11, 13, 10, 10]);
}

// ---------------------------------------------------------------- 3. 库存台账
{
  const warehouses = ['华东仓', '华南仓', '华北仓', '西南仓'];
  const goods = ['智能网关 G1', '工业传感器 S2', '边缘计算盒 E3', '无线采集器 W4', '数据中继器 R5', '控制主机 C6', '电源模块 P7', '通信天线 A8'];
  const rows = [['SKU', '商品名称', '仓库', '库存数量', '安全库存', '单价', '库存金额', '最近盘点日']];
  for (let i = 0; i < 96; i += 1) {
    const quantity = int(0, 900);
    const price = int(60, 3200);
    rows.push([
      `P-${1001 + i}`,
      pick(goods),
      pick(warehouses),
      quantity,
      int(50, 300),
      price,
      quantity * price,
      dayString(int(140, 160)),
    ]);
  }
  write('03-inventory.xlsx', '库存台账', rows, [10, 16, 10, 11, 11, 9, 12, 13]);
}

// ---------------------------------------------------------------- 4. 费用报销明细
{
  const departments = ['销售部', '市场部', '技术部', '财务部', '人力资源部', '客服部'];
  const subjects = ['差旅费', '办公费', '招待费', '培训费', '交通费', '通讯费'];
  const people = ['张伟', '王芳', '李娜', '赵敏', '陈静', '刘磊', '杨洋', '黄勇', '周艳', '吴杰'];
  const states = ['已通过', '已通过', '审批中', '已驳回', '待提交'];
  const rows = [['报销单号', '日期', '部门', '费用科目', '报销人', '金额', '审批状态']];
  for (let i = 0; i < 150; i += 1) {
    rows.push([
      `BX-${String(20260001 + i)}`,
      dayString(int(0, 180)),
      pick(departments),
      pick(subjects),
      pick(people),
      int(120, 15000),
      pick(states),
    ]);
  }
  write('04-expense-claims.xlsx', '费用报销', rows, [13, 12, 12, 11, 10, 10, 11]);
}

// ---------------------------------------------------------------- 5. 项目工时
{
  const projects = ['CRM 系统升级', '数据中台建设', '移动端重构', '官网改版', '客服机器人'];
  const members = ['张伟', '王芳', '李娜', '赵敏', '陈静', '刘磊', '杨洋', '黄勇'];
  const tasks = ['需求分析', '开发实现', '测试验证', '联调上线', '文档整理'];
  const rows = [['日期', '项目', '成员', '任务类型', '工时', '是否加班']];
  for (let i = 0; i < 140; i += 1) {
    const hours = round(0.5 + rnd() * 7.5, 1);
    rows.push([dayString(int(0, 90)), pick(projects), pick(members), pick(tasks), hours, hours > 8 ? '是' : (rnd() > 0.82 ? '是' : '否')]);
  }
  write('05-project-hours.xlsx', '项目工时', rows, [12, 16, 10, 12, 8, 10]);
}

// ---------------------------------------------------------------- 6. 客服工单（带时分的时间）
{
  const channels = ['电话', '邮件', '在线客服', '微信', '工单系统'];
  const priorities = ['紧急', '高', '中', '低'];
  const rows = [['工单号', '渠道', '创建时间', '优先级', '处理时长(小时)', '满意度']];
  for (let i = 0; i < 110; i += 1) {
    const offset = int(0, 120);
    const hour = String(int(8, 20)).padStart(2, '0');
    const minute = String(int(0, 59)).padStart(2, '0');
    rows.push([
      `TK-${String(88001 + i)}`,
      pick(channels),
      `${dayString(offset)} ${hour}:${minute}`,
      pick(priorities),
      round(0.3 + rnd() * 12, 1),
      int(1, 5),
    ]);
  }
  write('06-cs-tickets.xlsx', '客服工单', rows, [12, 12, 18, 9, 15, 9]);
}

// ---------------------------------------------------------------- 7. 月度经营报表（标题行 + 百分比 + 合计行）
{
  const departments = ['销售部', '市场部', '技术部', '财务部', '客服部', '运营部'];
  const rows = [
    ['2026 年上半年部门经营报表'],
    ['部门', '月份', '收入', '成本', '毛利', '毛利率'],
  ];
  let income = 0;
  let cost = 0;
  let profit = 0;
  for (let month = 1; month <= 6; month += 1) {
    for (const department of departments) {
      const monthIncome = int(40, 260) * 10000;
      const monthCost = Math.round(monthIncome * (0.55 + rnd() * 0.25));
      const monthProfit = monthIncome - monthCost;
      income += monthIncome;
      cost += monthCost;
      profit += monthProfit;
      rows.push([
        department,
        `${month}月`,
        monthIncome,
        monthCost,
        monthProfit,
        `${round((monthProfit / monthIncome) * 100, 1)}%`,
      ]);
    }
  }
  rows.push(['合计', '', income, cost, profit, `${round((profit / income) * 100, 1)}%`]);
  write('07-monthly-report.xlsx', '月度经营报表', rows, [12, 8, 14, 14, 14, 10]);
}

console.log(`输出目录：${OUT_DIR}`);
for (const item of files) {
  console.log(` - ${item.name} · 工作表「${item.sheetName}」· ${item.rows} 行数据`);
}
