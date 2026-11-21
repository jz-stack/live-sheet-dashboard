import crypto from 'node:crypto';

/**
 * 最小上下文：只发送列名、类型、基数、空值率和受控样例，不发送数据行。
 */
export function buildSchemaCard(snapshot, { includeSamples = true, sampleCount = 3 } = {}) {
  if (!snapshot) return null;
  const columns = (snapshot.schema || []).map((column) => {
    const entry = {
      name: column.name,
      type: column.type,
      nullRate: round2(column.nullRate ?? 0),
      distinct: column.distinct ?? 0,
    };
    if (includeSamples && Array.isArray(column.samples)) {
      entry.samples = column.samples.slice(0, sampleCount);
    }
    return entry;
  });
  const warnings = (snapshot.warnings || []).slice(0, 8).map((warning) => ({
    code: warning.code || 'unknown',
    message: warning.message,
  }));
  return {
    datasetVersion: snapshot.version,
    schemaHash: schemaHash(columns),
    sheetName: snapshot.sheetName,
    rowCount: snapshot.rowCount,
    columns,
    warnings,
  };
}

export function schemaHash(columns) {
  const normalized = (columns || []).map((column) => ({
    name: String(column.name), type: column.type,
    nullRate: round2(column.nullRate ?? 0), distinct: column.distinct ?? 0,
  }));
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16);
}

/** 摘要化 Document：不带 patch 历史，只带当前布局与组件状态。 */
export function buildDocumentDigest(document, projection) {
  if (!document) return null;
  const statusMap = new Map((projection?.components || []).map((component) => [component.spec.id, component]));
  return {
    documentRevision: document.revision,
    grid: document.grid,
    components: (document.components || []).map((component) => {
      const projected = statusMap.get(component.id);
      return {
        id: component.id,
        type: component.type,
        title: component.title,
        span: component.span,
        encoding: component.encoding,
        status: projected?.status || 'empty',
        statusReason: projected?.reason || null,
      };
    }),
  };
}

function round2(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) / 100 : 0;
}
