import fs from 'node:fs';
import { parentPort } from 'node:worker_threads';
import XLSX from 'xlsx';
import { parseWorkbookSource } from './parser.mjs';
import { buildProjection } from './projection.mjs';
import { AppError } from './errors.mjs';

XLSX.set_fs(fs);

function simulateChange(file, limits, sheetName = null) {
  const stat = fs.statSync(file);
  if (stat.size > limits.maxFileBytes) throw new AppError('文件超过模拟操作允许的大小', { code: 'LIMIT_EXCEEDED', stage: 'simulate' });
  const workbook = XLSX.readFile(file, { cellDates: true });
  const name = sheetName && workbook.SheetNames.includes(sheetName)
    ? sheetName
    : workbook.SheetNames[Math.floor(Math.random() * workbook.SheetNames.length)];
  const worksheet = workbook.Sheets[name];
  if (!worksheet) throw new AppError('没有可修改的工作表', { code: 'EMPTY_WORKBOOK', stage: 'simulate' });
  const sheetNameUsed = name;
  const matrix = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: null, blankrows: false, raw: true });
  const headerIndex = matrix.findIndex((row) => row.filter((cell) => cell !== null && cell !== '').length >= 2);
  if (headerIndex < 0) throw new AppError('表结构异常，无法模拟变更', { code: 'INVALID_HEADER', stage: 'simulate' });

  let selected = null;
  let candidates = 0;
  for (let row = headerIndex + 1; row < matrix.length; row += 1) {
    const first = String(matrix[row][0] ?? '').trim();
    if (/^(合\s*计|总\s*计|小\s*计|total|sum)$/i.test(first)) continue;
    for (let column = 0; column < matrix[row].length; column += 1) {
      if (typeof matrix[row][column] !== 'number' || !Number.isFinite(matrix[row][column])) continue;
      candidates += 1;
      if (Math.random() < 1 / candidates) selected = { row, column };
    }
  }
  if (!selected) throw new AppError('表里没有可模拟修改的数字单元格', { code: 'NO_NUMERIC_CELL', stage: 'simulate' });

  const cellRef = XLSX.utils.encode_cell({ r: selected.row, c: selected.column });
  const cell = worksheet[cellRef];
  const previous = cell.v;
  const next = Math.max(0, Math.round(previous * (0.55 + Math.random() * 0.9)));
  worksheet[cellRef] = { ...cell, t: 'n', v: next };
  XLSX.writeFile(workbook, file);
  return {
    cell: cellRef,
    sheet: sheetNameUsed,
    column: String(matrix[headerIndex][selected.column] ?? `列${selected.column + 1}`),
    row: selected.row + 1,
    previous,
    next,
  };
}

parentPort.on('message', ({ id, type, file, limits, source, sheetName }) => {
  try {
    let result;
    if (type === 'parse') {
      const parsed = parseWorkbookSource(file, limits, source || {});
      result = { parsed, projection: buildProjection(parsed) };
    } else if (type === 'simulate') result = simulateChange(file, limits, sheetName);
    else throw new AppError('未知 worker 任务', { code: 'UNKNOWN_WORKER_TASK', stage: 'worker' });
    parentPort.postMessage({ id, ok: true, result });
  } catch (error) {
    parentPort.postMessage({
      id,
      ok: false,
      error: {
        message: error?.message || String(error),
        code: error?.code || 'WORKER_TASK_FAILED',
        stage: error?.stage || 'unknown',
        status: error?.status || 500,
        retryable: Boolean(error?.retryable),
      },
    });
  }
});
