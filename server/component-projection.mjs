const AGGREGATIONS = new Set(['sum', 'count', 'avg', 'max']);

function hasColumn(snapshot, name) {
  return snapshot.headers?.includes(name);
}

function column(snapshot, name) {
  return snapshot.schema?.find((item) => item.name === name) || null;
}

function filteredRows(snapshot, encoding) {
  const filter = encoding.filter;
  if (!filter) return snapshot.rows || [];
  if (!hasColumn(snapshot, filter.field)) return null;
  const expected = filter.value;
  const values = Array.isArray(expected) ? expected : [expected];
  return (snapshot.rows || []).filter((row) => {
    const actual = row[filter.field];
    const numericActual = Number(actual);
    const numericExpected = Number(expected);
    const bothNumeric = actual !== null && actual !== '' && expected !== null && expected !== '' && Number.isFinite(numericActual) && Number.isFinite(numericExpected);
    const left = bothNumeric ? numericActual : actual;
    const right = bothNumeric ? numericExpected : expected;
    switch (filter.op) {
      case 'eq': return actual === expected || String(actual) === String(expected);
      case 'neq': return actual !== expected && String(actual) !== String(expected);
      case 'gt': return left > right;
      case 'gte': return left >= right;
      case 'lt': return left < right;
      case 'lte': return left <= right;
      case 'in': return values.some((value) => String(value) === String(actual));
      case 'notin': return values.every((value) => String(value) !== String(actual));
      default: return true;
    }
  });
}

function checkComponent(snapshot, spec) {
  if (spec.type === 'table' || spec.type === 'text') return { status: 'ok', reason: null };
  const encoding = spec.encoding || {};
  if (!AGGREGATIONS.has(encoding.agg)) return { status: 'invalid', reason: '聚合方式无效' };
  if (spec.type !== 'kpi' && (!encoding.x || !hasColumn(snapshot, encoding.x))) {
    return { status: 'invalid', reason: `维度列不存在：${encoding.x || '未配置'}` };
  }
  if (spec.type !== 'kpi' && column(snapshot, encoding.x)?.type === 'number') {
    return { status: 'invalid', reason: '维度列不能使用数值类型' };
  }
  if (encoding.y && !hasColumn(snapshot, encoding.y)) return { status: 'invalid', reason: `数值列不存在：${encoding.y}` };
  if (spec.type !== 'kpi' && !encoding.y) return { status: 'invalid', reason: '请配置数值列' };
  if (encoding.y && column(snapshot, encoding.y)?.type !== 'number') return { status: 'invalid', reason: `列 ${encoding.y} 不是数值类型` };
  if (spec.type === 'kpi' && encoding.agg !== 'count' && !encoding.y) return { status: 'invalid', reason: '该聚合方式需要数值列' };
  if (encoding.series && !hasColumn(snapshot, encoding.series)) {
    return { status: 'degraded', reason: `系列列 ${encoding.series} 不存在，已按单系列展示`, ignoreSeries: true };
  }
  if (spec.type === 'pie' && (column(snapshot, encoding.x)?.distinct || 0) > 30) {
    return { status: 'degraded', reason: '分类较多，仅展示主要分类；建议改用条形图' };
  }
  return { status: 'ok', reason: null };
}

function accumulator() {
  return { sum: 0, count: 0, max: -Infinity };
}

function accumulate(bucket, value, agg) {
  if (agg === 'count') {
    bucket.count += 1;
    return;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return;
  bucket.sum += numeric;
  bucket.count += 1;
  if (numeric > bucket.max) bucket.max = numeric;
}

function aggregateValue(bucket, agg) {
  if (!bucket || bucket.count === 0) return agg === 'sum' || agg === 'count' ? 0 : null;
  if (agg === 'sum') return bucket.sum;
  if (agg === 'count') return bucket.count;
  if (agg === 'avg') return bucket.sum / bucket.count;
  return Number.isFinite(bucket.max) ? bucket.max : null;
}

function aggregateChart(rows, spec, ignoreSeries = false) {
  const { x, y, agg } = spec.encoding;
  const seriesField = ignoreSeries ? null : spec.encoding.series;
  const xType = columnType(rows.snapshot, x);
  const groups = new Map();
  const seriesTotals = new Map();
  for (const row of rows) {
    const rawKey = row[x];
    if (rawKey === null || rawKey === undefined || rawKey === '') continue;
    const key = String(rawKey);
    if (!groups.has(key)) groups.set(key, new Map());
    const seriesKey = seriesField ? String(row[seriesField] ?? '未分类') : y;
    if (!groups.get(key).has(seriesKey)) groups.get(key).set(seriesKey, accumulator());
    accumulate(groups.get(key).get(seriesKey), row[y], agg);
    if (seriesField) {
      const total = seriesTotals.get(seriesKey) || accumulator();
      accumulate(total, row[y], agg);
      seriesTotals.set(seriesKey, total);
    }
  }
  let labels = [...groups.keys()];
  if (xType === 'date') labels.sort((a, b) => a.localeCompare(b));
  else labels.sort((a, b) => {
    const totalA = [...groups.get(a).values()].reduce((sum, bucket) => sum + Math.abs(aggregateValue(bucket, agg) || 0), 0);
    const totalB = [...groups.get(b).values()].reduce((sum, bucket) => sum + Math.abs(aggregateValue(bucket, agg) || 0), 0);
    return totalB - totalA;
  });
  labels = labels.slice(0, xType === 'date' ? 200 : 20);
  let seriesNames = seriesField ? [...seriesTotals.keys()] : [y];
  seriesNames.sort((a, b) => Math.abs(aggregateValue(seriesTotals.get(b), agg) || 0) - Math.abs(aggregateValue(seriesTotals.get(a), agg) || 0));
  seriesNames = seriesNames.slice(0, 6);
  const series = seriesNames.map((name) => ({
    name,
    values: labels.map((label) => aggregateValue(groups.get(label)?.get(name), agg)),
  }));
  return { labels, series };
}

function columnType(snapshot, name) {
  return snapshot.schema?.find((item) => item.name === name)?.type || 'string';
}

function aggregateKpi(rows, spec) {
  const { y, agg } = spec.encoding;
  if (agg === 'count') return rows.length;
  const bucket = accumulator();
  for (const row of rows) accumulate(bucket, row[y], agg);
  return aggregateValue(bucket, agg) ?? 0;
}

function aggregatePie(rows, spec) {
  const chart = aggregateChart(rows, spec, true);
  return chart.labels.map((label, index) => ({ name: label, value: chart.series[0]?.values[index] ?? 0 }));
}

function previewTable(snapshot) {
  const headers = (snapshot.headers || []).slice(0, 7);
  return {
    headers,
    rows: (snapshot.rows || []).slice(0, 12).map((row, index) => ({
      id: snapshot.rowNumbers?.[index] ?? index + 1,
      values: headers.map((header) => row[header]),
    })),
  };
}

function projectComponent(snapshot, spec) {
  const checked = checkComponent(snapshot, spec);
  const base = { id: spec.id, type: spec.type, title: spec.title, status: checked.status, reason: checked.reason, data: null };
  if (checked.status === 'invalid') return base;
  if (spec.type === 'text') return { ...base, data: { text: spec.text || spec.title } };
  if (spec.type === 'table') {
    const data = previewTable(snapshot);
    return { ...base, status: data.rows.length ? checked.status : 'empty', data };
  }
  const rows = filteredRows(snapshot, spec.encoding || {});
  if (!rows) return { ...base, status: 'invalid', reason: `过滤字段不存在：${spec.encoding.filter.field}` };
  rows.snapshot = snapshot;
  if (!rows.length) return { ...base, status: 'empty', reason: '当前编码与过滤条件下没有数据' };
  let data;
  if (spec.type === 'kpi') data = { raw: aggregateKpi(rows, spec), agg: spec.encoding.agg, field: spec.encoding.y || null };
  else if (spec.type === 'pie') data = { points: aggregatePie(rows, spec) };
  else data = aggregateChart(rows, spec, checked.ignoreSeries);
  const empty = spec.type === 'kpi' ? false : spec.type === 'pie' ? !data.points.length : !data.labels.length;
  return { ...base, status: empty ? 'empty' : checked.status, data };
}

function legacyProjection(snapshot, components) {
  const kpis = components.filter((item) => item.type === 'kpi' && item.data).map((item) => ({
    key: item.id, label: item.title, raw: item.data.raw, delta: item.data.agg !== 'count',
  }));
  const table = components.find((item) => item.type === 'table' && item.data);
  const charts = components.filter((item) => ['line', 'bar'].includes(item.type) && item.data?.labels?.length);
  const toLegacy = (item) => {
    const spec = item.spec;
    return {
      x: column(snapshot, spec.encoding.x), y: column(snapshot, spec.encoding.y),
      points: item.data.labels.map((key, index) => ({ key, value: item.data.series[0]?.values[index] ?? 0 })),
      kind: item.type,
    };
  };
  const main = charts[0] ? toLegacy(charts[0]) : null;
  const pie = components.find((item) => item.type === 'pie' && item.data?.points?.length);
  const subChart = charts[1] ? toLegacy(charts[1]) : null;
  const sub = pie ? {
    dimension: column(snapshot, pie.spec.encoding.x), y: column(snapshot, pie.spec.encoding.y),
    points: pie.data.points.map((point) => ({ key: point.name, value: point.value })), kind: 'pie',
  } : subChart ? { dimension: subChart.x, y: subChart.y, points: subChart.points, kind: 'bar' } : null;
  return { main, sub, kpis, preview: table?.data || { headers: [], rows: [] } };
}

export function emptyDocumentProjection() {
  return { components: [], main: null, sub: null, kpis: [], preview: { headers: [], rows: [] } };
}

/**
 * 投影单个组件规格。与 Document 无关，因此可以用于“假设套用某个 Patch 之后
 * 画面长什么样”的预览计算，而不必真的修改 Document。
 */
export function projectSpec(snapshot, spec) {
  return { ...projectComponent(snapshot, spec), spec };
}

export function projectDocument(document, snapshot) {
  if (!document || !snapshot) return emptyDocumentProjection();
  const components = document.components.map((spec) => projectSpec(snapshot, spec));
  return { components, ...legacyProjection(snapshot, components) };
}
