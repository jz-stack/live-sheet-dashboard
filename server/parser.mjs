import fs from 'node:fs';
import XLSX from 'xlsx';
import { AppError } from './errors.mjs';

XLSX.set_fs(fs);

/**
 * 合并视图里用来承载工作表来源的虚拟列名。
 * Excel 允许用户自己也叫「工作表」，因此实际列名由 reserveSheetColumn 避让决定。
 */
export const SHEET_COLUMN = '工作表';

const TOTAL_ROW = /^(合\s*计|总\s*计|小\s*计|total|sum)$/i;
const DEFAULT_MAX_SHEETS = 50;
const DEFAULT_MAX_WORKBOOK_ROWS = 200_000;

function isBlank(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function actualWidth(row) {
  let width = 0;
  for (let index = 0; index < row.length; index += 1) {
    if (!isBlank(row[index])) width = index + 1;
  }
  return width;
}

export function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date || typeof value !== 'string') return NaN;
  const source = value.trim();
  const percent = source.includes('%');
  const negative = /^\(.*\)$/.test(source);
  const cleaned = source.replace(/[(),\s¥$€£%]/g, '');
  if (cleaned === '' || cleaned === '-') return NaN;
  let number = Number(cleaned);
  if (negative) number = -number;
  if (percent) number /= 100;
  return Number.isFinite(number) ? number : NaN;
}

function makeDateKey(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day || 1);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function toDateKey(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return makeDateKey(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }
  if (typeof value !== 'string') return null;
  const source = value.trim();
  let match = source.match(/^(\d{4})年(\d{1,2})月(?:(\d{1,2})日?)?$/);
  if (match) return makeDateKey(match[1], match[2], match[3]);
  // 兼容办公表常见的带时间写法：2026-01-06 14:23、2026/1/6 9:05:30、ISO 的 T/Z 形式。
  // 时间部分只用于判定「这是日期列」，聚合粒度仍是天，因此直接丢弃时分秒。
  match = source.match(
    /^(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?(?:[ T](?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/,
  );
  if (match) return makeDateKey(match[1], match[2], match[3]);
  return null;
}

function uniqueHeaders(raw, width) {
  const seen = new Map();
  const output = [];
  let duplicates = 0;
  let blanks = 0;
  for (let index = 0; index < width; index += 1) {
    const blank = isBlank(raw[index]);
    const base = blank ? `列${index + 1}` : String(raw[index]).trim();
    if (blank) blanks += 1;
    const hit = seen.get(base) || 0;
    seen.set(base, hit + 1);
    if (hit) duplicates += 1;
    output.push(hit ? `${base}_${hit + 1}` : base);
  }
  return { headers: output, duplicates, blanks };
}

function inferColumn(name, bodyRows, columnIndex) {
  const distinct = new Set();
  const sample = [];
  let present = 0;
  let numericHits = 0;
  let dateHits = 0;
  let percentHits = 0;

  for (const { cells } of bodyRows) {
    const value = cells[columnIndex];
    if (isBlank(value)) continue;
    present += 1;
    if (!Number.isNaN(toNumber(value))) numericHits += 1;
    if (toDateKey(value)) dateHits += 1;
    if (typeof value === 'string' && value.includes('%') && !Number.isNaN(toNumber(value))) percentHits += 1;
    distinct.add(String(value instanceof Date ? toDateKey(value) : value));
    if (sample.length < 3) sample.push(value instanceof Date ? toDateKey(value) : value);
  }

  let type = 'string';
  if (present > 0 && numericHits / present >= 0.8) type = 'number';
  else if (present > 0 && dateHits / present >= 0.8) type = 'date';
  const nullCount = bodyRows.length - present;
  return {
    name,
    type,
    present,
    numericHits,
    dateHits,
    percentHits,
    nullCount,
    nullRate: bodyRows.length ? Number((nullCount / bodyRows.length).toFixed(3)) : 0,
    distinct: distinct.size,
    sample,
  };
}

function checkWorksheetLimits(worksheet, limits) {
  if (!worksheet['!ref']) return;
  const range = XLSX.utils.decode_range(worksheet['!ref']);
  const rows = range.e.r - range.s.r + 1;
  const columns = range.e.c - range.s.c + 1;
  if (rows > limits.maxRows + 1 || columns > limits.maxColumns || rows * columns > limits.maxCells) {
    throw new AppError(
      `工作表范围 ${rows} 行 × ${columns} 列，超过当前上限（${limits.maxRows} 行、${limits.maxColumns} 列、${limits.maxCells} 单元格）`,
      { code: 'LIMIT_EXCEEDED', status: 413, stage: 'read' },
    );
  }
}

function isTotalRow(row, skipTotalRows) {
  if (!skipTotalRows || typeof row[0] !== 'string' || !TOTAL_ROW.test(row[0].trim())) return false;
  return row.slice(1).some((value) => !isBlank(value) && !Number.isNaN(toNumber(value)));
}

function readWorkbook(file, limits) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new AppError('目标路径不是文件', { code: 'NOT_A_FILE', stage: 'read' });
  if (stat.size > limits.maxFileBytes) {
    throw new AppError(`文件 ${stat.size} 字节，超过 ${limits.maxFileBytes} 字节上限`, {
      code: 'LIMIT_EXCEEDED', status: 413, stage: 'read',
    });
  }
  try {
    return XLSX.readFile(file, { cellDates: true, dense: false });
  } catch (error) {
    throw new AppError(`无法读取工作簿：${error.message}`, {
      code: error.code || 'WORKBOOK_READ_FAILED', stage: 'read', retryable: ['EBUSY', 'EPERM', 'ENOENT'].includes(error.code),
    });
  }
}

/** 解析单张工作表：表头探测、类型推断、脏数据体检。 */
export function parseWorksheet(worksheet, sheetName, limits) {
  checkWorksheetLimits(worksheet, limits);

  let formulaCells = 0;
  for (const key of Object.keys(worksheet)) {
    if (!key.startsWith('!') && worksheet[key]?.f) formulaCells += 1;
  }

  const matrix = XLSX.utils.sheet_to_json(worksheet, {
    header: 1, defval: null, blankrows: false, raw: true,
  });
  if (!matrix.length) throw new AppError('工作表是空的', { code: 'EMPTY_SHEET', stage: 'normalize' });
  if (matrix.length > limits.maxRows + 1) {
    throw new AppError(`有效行数超过 ${limits.maxRows} 行上限`, { code: 'LIMIT_EXCEEDED', status: 413, stage: 'normalize' });
  }

  const headerIndex = matrix.findIndex((row) => row.filter((cell) => !isBlank(cell)).length >= 2);
  if (headerIndex < 0) throw new AppError('认不出一行有效的表头', { code: 'INVALID_HEADER', stage: 'normalize' });
  const width = Math.max(...matrix.slice(headerIndex).map(actualWidth));
  if (width > limits.maxColumns) {
    throw new AppError(`实际列数 ${width} 超过 ${limits.maxColumns} 列上限`, { code: 'LIMIT_EXCEEDED', status: 413, stage: 'normalize' });
  }

  const { headers, duplicates, blanks } = uniqueHeaders(matrix[headerIndex], width);
  const warnings = [];
  if (blanks) warnings.push({ level: 'warn', code: 'blank-header', message: `有 ${blanks} 列没有表头，已用「列N」占位` });
  if (duplicates) warnings.push({ level: 'warn', code: 'duplicate-header', message: `有 ${duplicates} 个重复表头，已添加序号区分` });
  if (formulaCells) warnings.push({ level: 'info', code: 'formula-cache', message: `检测到 ${formulaCells} 个公式单元格；使用 Excel 保存的缓存结果，本工具不重新计算公式` });

  const bodyRows = [];
  let totalRowCount = 0;
  let missingCellRows = 0;
  let expandedRows = 0;
  const headerWidth = actualWidth(matrix[headerIndex]);
  for (let index = headerIndex + 1; index < matrix.length; index += 1) {
    const cells = matrix[index];
    if (!cells || cells.every(isBlank)) continue;
    if (isTotalRow(cells, limits.skipTotalRows)) {
      totalRowCount += 1;
      continue;
    }
    const rowWidth = actualWidth(cells);
    if (rowWidth < width) missingCellRows += 1;
    if (rowWidth > headerWidth) expandedRows += 1;
    bodyRows.push({ cells, sourceRow: index + 1 });
  }
  if (bodyRows.length > limits.maxRows) {
    throw new AppError(`明细行数超过 ${limits.maxRows} 行上限`, { code: 'LIMIT_EXCEEDED', status: 413, stage: 'normalize' });
  }
  if (totalRowCount) warnings.push({ level: 'warn', code: 'total-row-skipped', message: `按当前规则忽略了 ${totalRowCount} 行首列合计/总计行；可用 SKIP_TOTAL_ROWS=0 关闭` });
  if (missingCellRows) warnings.push({ level: 'info', code: 'ragged-row', message: `有 ${missingCellRows} 行缺少部分单元格，按空值处理` });
  if (expandedRows) warnings.push({ level: 'warn', code: 'extra-columns-recovered', message: `有 ${expandedRows} 行比表头更宽，已补充列名，未丢弃额外单元格` });

  const schema = headers.map((name, index) => inferColumn(name, bodyRows, index));
  const rows = [];
  const rowNumbers = [];
  for (const { cells, sourceRow } of bodyRows) {
    const output = Object.create(null);
    headers.forEach((name, index) => {
      const column = schema[index];
      const raw = cells[index];
      if (isBlank(raw)) output[name] = null;
      else if (column.type === 'number') {
        const number = toNumber(raw);
        output[name] = Number.isNaN(number) ? null : number;
      } else if (column.type === 'date') output[name] = toDateKey(raw);
      else output[name] = String(raw).trim();
    });
    rows.push(output);
    rowNumbers.push(sourceRow);
  }

  for (const column of schema) {
    const invalid = column.type === 'number'
      ? column.present - column.numericHits
      : column.type === 'date' ? column.present - column.dateHits : 0;
    if (invalid > 0) warnings.push({ level: 'warn', code: 'value-coerced-null', message: `「${column.name}」有 ${invalid} 个值不符合推断类型，已置空；请检查原始单元格` });
    if (column.percentHits > 0) warnings.push({ level: 'info', code: 'percentage-normalized', message: `「${column.name}」的百分比文本已除以 100 转为数值` });
    if (column.nullRate >= 0.5 && column.nullRate < 1) warnings.push({ level: 'warn', code: 'high-null', message: `「${column.name}」有 ${Math.round(column.nullRate * 100)}% 是空值，图表可能失真` });
    if (column.type === 'string' && column.distinct > 50) warnings.push({ level: 'info', code: 'high-cardinality', message: `「${column.name}」有 ${column.distinct} 个不同取值，不适合直接当分类轴` });
  }

  return {
    sheetName,
    headers,
    schema: schema.map(({ present, numericHits, dateHits, percentHits, ...column }) => column),
    rows,
    rowNumbers,
    rowCount: rows.length,
    warnings,
  };
}

/** 兼容入口：只解析第一张工作表（旧行为）。 */
export function parseWorkbook(file, limits) {
  const startedAt = Date.now();
  const workbook = readWorkbook(file, limits);
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new AppError('工作簿里没有工作表', { code: 'EMPTY_WORKBOOK', stage: 'read' });
  const worksheet = workbook.Sheets[sheetName];
  if (!worksheet || !worksheet['!ref']) throw new AppError('工作表是空的', { code: 'EMPTY_SHEET', stage: 'normalize' });
  const parsed = parseWorksheet(worksheet, sheetName, limits);
  return {
    ...parsed,
    sheetNames: workbook.SheetNames,
    mode: 'sheet',
    activeSheet: sheetName,
    sheets: [{ name: sheetName, rowCount: parsed.rowCount, headers: parsed.headers, status: 'ok' }],
    parseMs: Date.now() - startedAt,
  };
}

function hiddenSheetNames(workbook) {
  const meta = workbook.Workbook?.Sheets || [];
  const hidden = new Set();
  workbook.SheetNames.forEach((name, index) => {
    if (meta[index]?.Hidden) hidden.add(name);
  });
  return hidden;
}

function estimateRows(worksheet) {
  if (!worksheet?.['!ref']) return 0;
  const range = XLSX.utils.decode_range(worksheet['!ref']);
  return Math.max(0, range.e.r - range.s.r);
}

function reserveSheetColumn(headers, sheetNames) {
  const taken = new Set([...headers, ...sheetNames]);
  if (!taken.has(SHEET_COLUMN)) return { column: SHEET_COLUMN, renamed: false };
  let candidate = `${SHEET_COLUMN}(分表)`;
  let index = 2;
  while (taken.has(candidate)) {
    candidate = `${SHEET_COLUMN}(分表${index})`;
    index += 1;
  }
  return { column: candidate, renamed: true };
}

function inferFromValues(name, rows) {
  const distinct = new Set();
  const sample = [];
  let present = 0;
  let numericHits = 0;
  let dateHits = 0;
  for (const row of rows) {
    const value = row[name];
    if (isBlank(value)) continue;
    present += 1;
    if (typeof value === 'number' && Number.isFinite(value)) numericHits += 1;
    if (toDateKey(value)) dateHits += 1;
    distinct.add(String(value));
    if (sample.length < 3) sample.push(value);
  }
  let type = 'string';
  if (present > 0 && numericHits / present >= 0.8) type = 'number';
  else if (present > 0 && dateHits / present >= 0.8) type = 'date';
  const nullCount = rows.length - present;
  return {
    name, type, nullCount,
    nullRate: rows.length ? Number((nullCount / rows.length).toFixed(3)) : 0,
    distinct: distinct.size, sample,
  };
}

/**
 * 把多张表拼成一份数据集，并追加一列记录来源工作表。
 * 列名取并集：某张表没有的列补 null；类型冲突时降级为字符串并给出警告。
 */
function mergeSheets(parsedSheets, { sheetNames, failures, limits, startedAt, hidden = new Set() }) {
  const headers = [];
  const seen = new Set();
  const typeMap = new Map();
  const presence = new Map();
  for (const sheet of parsedSheets) {
    for (const column of sheet.schema) {
      if (!seen.has(column.name)) {
        seen.add(column.name);
        headers.push(column.name);
      }
      presence.set(column.name, (presence.get(column.name) || 0) + 1);
      if (!typeMap.has(column.name)) typeMap.set(column.name, new Set());
      typeMap.get(column.name).add(column.type);
    }
  }

  const { column: sheetColumn, renamed } = reserveSheetColumn(headers, sheetNames);
  const totalRows = parsedSheets.reduce((sum, sheet) => sum + sheet.rowCount, 0);
  const maxWorkbookRows = limits.maxWorkbookRows ?? DEFAULT_MAX_WORKBOOK_ROWS;
  if (totalRows > maxWorkbookRows) {
    throw new AppError(`合并后共 ${totalRows} 行，超过 ${maxWorkbookRows} 行上限（MAX_WORKBOOK_ROWS）；请在配置中关闭合并或拆分文件`, {
      code: 'LIMIT_EXCEEDED', status: 413, stage: 'merge',
    });
  }

  const rows = [];
  const rowNumbers = [];
  let index = 0;
  for (const sheet of parsedSheets) {
    for (const row of sheet.rows) {
      const output = Object.create(null);
      for (const header of headers) output[header] = row[header] ?? null;
      output[sheetColumn] = sheet.sheetName;
      rows.push(output);
      index += 1;
      rowNumbers.push(index);
    }
  }

  const schema = [...headers, sheetColumn].map((name) => (
    name === sheetColumn
      ? { name, type: 'string', nullCount: 0, nullRate: 0, distinct: parsedSheets.length, sample: parsedSheets.slice(0, 3).map((sheet) => sheet.sheetName) }
      : inferFromValues(name, rows)
  ));

  const warnings = [];
  if (renamed) {
    warnings.push({ level: 'warn', code: 'sheet-column-renamed', message: `表里已有名为「${SHEET_COLUMN}」的列，来源列改用「${sheetColumn}」` });
  }
  for (const sheet of parsedSheets) {
    for (const warning of sheet.warnings) {
      warnings.push({ ...warning, message: `[${sheet.sheetName}] ${warning.message}` });
    }
  }
  for (const failure of failures) {
    warnings.push({ level: 'warn', code: 'sheet-skipped', message: `工作表「${failure.name}」已跳过：${failure.message}` });
  }
  for (const header of headers) {
    const missing = parsedSheets.length - (presence.get(header) || 0);
    if (missing > 0) {
      warnings.push({ level: 'warn', code: 'sheet-column-missing', message: `「${header}」在 ${missing} 张表里不存在，合并后该列为空` });
    }
    const types = typeMap.get(header);
    if (types && types.size > 1) {
      warnings.push({ level: 'warn', code: 'sheet-type-conflict', message: `「${header}」在不同表里类型不一致（${[...types].join(' / ')}），已按原值合并` });
    }
  }
  warnings.unshift({ level: 'info', code: 'sheet-merged', message: `已合并 ${parsedSheets.length} 张工作表、${rows.length} 行数据；「${sheetColumn}」列可用于分表对比` });

  const parsedNames = new Set(parsedSheets.map((sheet) => sheet.sheetName));
  const sheets = sheetNames
    .filter((name) => parsedNames.has(name) || failures.some((failure) => failure.name === name))
    .map((name) => {
      const sheet = parsedSheets.find((item) => item.sheetName === name);
      const isHidden = hidden.has(name);
      return sheet
        ? { name, hidden: isHidden, rowCount: sheet.rowCount, headers: sheet.headers, status: 'ok' }
        : {
          name,
          hidden: isHidden,
          rowCount: 0,
          headers: [],
          status: 'skipped',
          reason: isHidden ? '隐藏工作表' : (failures.find((failure) => failure.name === name)?.message || '解析失败'),
        };
    });

  return {
    mode: 'merged',
    sheetName: `合并 ${parsedSheets.length} 张表`,
    activeSheet: null,
    sheetColumn,
    sheetNames,
    sheets,
    headers: [...headers, sheetColumn],
    schema,
    rows,
    rowNumbers,
    rowCount: rows.length,
    warnings,
    parseMs: Date.now() - startedAt,
  };
}

/**
 * 按数据源模式解析：mode=merged 合并所有（可见）工作表，mode=sheet 只解析指定表。
 * 合并模式下单张表失败只跳过该表，避免一个脏 sheet 拖垮整本书。
 */
export function parseWorkbookSource(file, limits, { mode = 'merged', sheetName = null } = {}) {
  const startedAt = Date.now();
  const workbook = readWorkbook(file, limits);
  const sheetNames = workbook.SheetNames;
  if (!sheetNames.length) throw new AppError('工作簿里没有工作表', { code: 'EMPTY_WORKBOOK', stage: 'read' });
  const maxSheets = limits.maxSheets ?? DEFAULT_MAX_SHEETS;
  if (sheetNames.length > maxSheets) {
    throw new AppError(`工作簿含 ${sheetNames.length} 张工作表，超过 ${maxSheets} 张上限（MAX_SHEETS）`, {
      code: 'LIMIT_EXCEEDED', status: 413, stage: 'read',
    });
  }

  if (mode === 'sheet') {
    const target = sheetName && sheetNames.includes(sheetName) ? sheetName : sheetNames[0];
    const worksheet = workbook.Sheets[target];
    if (!worksheet || !worksheet['!ref']) {
      throw new AppError(`工作表「${target}」是空的`, { code: 'EMPTY_SHEET', stage: 'normalize' });
    }
    const parsed = parseWorksheet(worksheet, target, limits);
    const hidden = hiddenSheetNames(workbook);
    return {
      ...parsed,
      mode: 'sheet',
      activeSheet: target,
      sheetNames,
      sheets: sheetNames.map((name) => ({
        name,
        hidden: hidden.has(name),
        rowCount: name === target ? parsed.rowCount : estimateRows(workbook.Sheets[name]),
        headers: name === target ? parsed.headers : [],
        status: name === target ? 'ok' : 'idle',
      })),
      parseMs: Date.now() - startedAt,
    };
  }

  const hidden = hiddenSheetNames(workbook);
  const parsedSheets = [];
  const failures = [];
  for (const name of sheetNames) {
    if (hidden.has(name)) {
      failures.push({ name, message: '隐藏工作表，未参与合并' });
      continue;
    }
    const worksheet = workbook.Sheets[name];
    try {
      parsedSheets.push(parseWorksheet(worksheet, name, limits));
    } catch (error) {
      failures.push({ name, message: error?.message || String(error) });
    }
  }
  if (!parsedSheets.length) {
    const first = failures[0];
    throw new AppError(first ? `没有可用的工作表：${first.message}` : '工作簿里没有可用的工作表', {
      code: 'EMPTY_WORKBOOK', stage: 'normalize',
    });
  }
  if (parsedSheets.length === 1) {
    // 只有一张有效表时不必造虚拟列，保持与单表模式完全一致的数据形状
    const only = parsedSheets[0];
    const hidden = hiddenSheetNames(workbook);
    return {
      ...only,
      mode: 'merged',
      activeSheet: null,
      sheetNames,
      sheets: sheetNames.map((name) => ({
        name,
        hidden: hidden.has(name),
        rowCount: name === only.sheetName ? only.rowCount : estimateRows(workbook.Sheets[name]),
        headers: name === only.sheetName ? only.headers : [],
        status: name === only.sheetName ? 'ok' : 'idle',
      })),
      parseMs: Date.now() - startedAt,
    };
  }
  return mergeSheets(parsedSheets, { sheetNames, failures, limits, startedAt, hidden });
}
