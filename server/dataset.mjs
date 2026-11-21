import path from 'node:path';
import crypto from 'node:crypto';
import { emptyProjection } from './projection.mjs';
import { normalizeError, AppError } from './errors.mjs';

export const SOURCE_MODES = new Set(['merged', 'sheet']);

function initialState(mode = 'merged') {
  return {
    instanceId: null,
    version: 0,
    revision: 0,
    status: 'idle',
    sourcePath: null,
    updatedAt: null,
    reason: null,
    mode,
    activeSheet: null,
    sheetColumn: null,
    sheets: [],
    sheetName: null,
    sheetNames: [],
    headers: [],
    schema: [],
    rows: [],
    rowNumbers: [],
    rowCount: 0,
    warnings: [],
    parseMs: 0,
    error: null,
    projection: emptyProjection(),
  };
}

export class SnapshotRepository {
  constructor({ mode = 'merged' } = {}) {
    this.instanceId = crypto.randomUUID();
    this.state = { ...initialState(mode), instanceId: this.instanceId };
  }

  metadata() {
    const state = this.state;
    return {
      instanceId: this.instanceId,
      version: state.version,
      revision: state.revision,
      status: state.status,
      fileName: state.sourcePath ? path.basename(state.sourcePath) : null,
      updatedAt: state.updatedAt,
      reason: state.reason,
      mode: state.mode,
      activeSheet: state.activeSheet,
      sheetColumn: state.sheetColumn,
      sheets: state.sheets,
      source: {
        mode: state.mode,
        activeSheet: state.activeSheet,
        sheetColumn: state.sheetColumn,
        label: state.sheetName,
        sheets: state.sheets,
      },
      sheetName: state.sheetName,
      sheetNames: state.sheetNames,
      headers: state.headers,
      schema: state.schema,
      rowCount: state.rowCount,
      warnings: state.warnings,
      parseMs: state.parseMs,
      error: state.error,
    };
  }

  /** 当前希望采用的数据源，交给 worker 解析。 */
  sourceSpec() {
    return { mode: this.state.mode, sheetName: this.state.activeSheet };
  }

  /**
   * 切换数据源（合并视图 / 指定工作表）。只改意图，不解析；
   * 真正重新解析由 ingest.refresh 完成，避免 HTTP 线程里做重活。
   */
  setSource({ mode, sheetName = null }) {
    if (!SOURCE_MODES.has(mode)) {
      throw new AppError(`不支持的数据源模式：${mode}`, { code: 'INVALID_SOURCE', status: 400, stage: 'dataset' });
    }
    if (mode === 'sheet') {
      const names = this.state.sheetNames || [];
      if (!sheetName) throw new AppError('切换到单表模式必须指定工作表名称', { code: 'INVALID_SOURCE', status: 400, stage: 'dataset' });
      if (names.length && !names.includes(sheetName)) {
        throw new AppError(`工作表「${sheetName}」不存在`, { code: 'SHEET_NOT_FOUND', status: 404, stage: 'dataset' });
      }
    }
    this.state = {
      ...this.state,
      mode,
      activeSheet: mode === 'sheet' ? sheetName : null,
      revision: this.state.revision + 1,
      reason: mode === 'sheet' ? `切换到工作表 ${sheetName}` : '切换到合并视图',
    };
    return this.metadata();
  }


  getProjection() {
    return { ...this.metadata(), ...this.state.projection };
  }

  snapshot() {
    return this.state;
  }

  getRows(offset = 0, limit = 100) {
    const start = Math.max(0, offset);
    const end = Math.min(this.state.rows.length, start + limit);
    return {
      version: this.state.version,
      revision: this.state.revision,
      total: this.state.rows.length,
      offset: start,
      limit: end - start,
      rows: this.state.rows.slice(start, end).map((row, index) => ({
        id: this.state.rowNumbers[start + index] ?? start + index + 1,
        values: row,
      })),
    };
  }

  commit(parsed, projection, { file, reason }) {
    this.state = {
      ...this.state,
      ...parsed,
      version: this.state.version + 1,
      revision: this.state.revision + 1,
      status: 'ready',
      sourcePath: file,
      updatedAt: new Date().toISOString(),
      reason,
      error: null,
      projection,
    };
    return this.metadata();
  }

  markStatus(status, reason) {
    this.state = { ...this.state, status, reason, revision: this.state.revision + 1 };
    return this.metadata();
  }

  applyError(error, { file, reason }) {
    this.state = {
      ...this.state,
      status: 'error',
      sourcePath: file,
      updatedAt: new Date().toISOString(),
      reason,
      revision: this.state.revision + 1,
      error: normalizeError(error),
    };
    return this.metadata();
  }
}
