import crypto from 'node:crypto';

/**
 * 确定性分析引擎：所有数值（环比、连续期、离群点、贡献度）都由这里计算，
 * 模型只负责把这些证据翻译成文字，不允许自行计算。
 */
export function analyzeSnapshot(snapshot) {
  const evidence = {
    evidenceId: crypto.randomUUID(),
    datasetVersion: snapshot?.version ?? 0,
    metric: null,
    observations: [],
  };
  if (!snapshot?.rows?.length || !snapshot.schema?.length) return evidence;

  const schema = snapshot.schema;
  const dateColumn = schema.find((column) => column.type === 'date');
  const measureColumn = schema.find((column) => column.type === 'number' && (column.distinct || 0) > 1);
  if (!measureColumn) return evidence;
  evidence.metric = { name: measureColumn.name, agg: 'sum' };

  const rows = snapshot.rows;
  let sequence = null;
  if (dateColumn) {
    const totals = new Map();
    for (const row of rows) {
      const key = String(row[dateColumn.name] ?? '');
      if (!key) continue;
      const value = Number(row[measureColumn.name]);
      totals.set(key, (totals.get(key) || 0) + (Number.isFinite(value) ? value : 0));
    }
    sequence = [...totals.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  }

  let index = 0;
  const nextId = () => `obs-${++index}`;

  if (sequence && sequence.length >= 2) {
    const last = sequence.at(-1);
    const previous = sequence.at(-2);
    const current = round2(last[1]);
    const before = round2(previous[1]);
    const delta = round2(current - before);
    const pct = before !== 0 ? round2((delta / Math.abs(before)) * 100) : null;
    evidence.observations.push({
      id: nextId(),
      type: 'period-change',
      values: { metric: measureColumn.name, period: last[0], previousPeriod: previous[0], current, previous: before },
      comparisons: { delta, pct },
    });
    evidence.observations.push(...streakObservation(nextId, sequence, measureColumn.name));
    evidence.observations.push(...outlierObservation(nextId, sequence, measureColumn.name));
    evidence.observations.push(...contributionObservation(nextId, rows, dateColumn.name, measureColumn.name, last[0], previous[0]));
  } else {
    evidence.observations.push(...rowOutlierObservation(nextId, rows, measureColumn.name));
  }

  const nullRate = measureColumn.nullRate ?? 0;
  if (nullRate >= 0.2) {
    evidence.observations.push({
      id: nextId(),
      type: 'data-quality',
      values: { message: `数值列「${measureColumn.name}」空值率 ${(nullRate * 100).toFixed(1)}%，图表数值可能偏低`, column: measureColumn.name, nullRate: round2(nullRate * 100) },
    });
  }
  return evidence;
}

function streakObservation(nextId, sequence, metric) {
  let direction = Math.sign(sequence.at(-1)[1] - sequence.at(-2)[1]);
  if (direction === 0) return [];
  let length = 1;
  for (let i = sequence.length - 2; i >= 0; i -= 1) {
    const step = Math.sign(sequence[i + 1][1] - sequence[i][1]);
    if (step !== direction) break;
    length += 1;
  }
  if (length < 3) return [];
  return [{
    id: nextId(),
    type: 'streak',
    values: { metric, length, direction, from: sequence.at(-length)[0], to: sequence.at(-1)[0] },
  }];
}

function outlierObservation(nextId, sequence, metric) {
  const values = sequence.map((item) => item[1]);
  const zScores = robustZScores(values);
  const candidates = sequence
    .map((item, i) => ({ key: item[0], z: round2(zScores[i]) }))
    .filter((item) => Math.abs(item.z) >= 3.5)
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
    .slice(0, 2);
  if (!candidates.length) return [];
  return candidates.map((candidate) => ({
    id: nextId(),
    type: 'outlier',
    values: { metric, key: candidate.key, z: candidate.z },
  }));
}

function rowOutlierObservation(nextId, rows, metric) {
  const values = rows.map((row) => Number(row[metric])).filter((value) => Number.isFinite(value));
  if (values.length < 8) return [];
  const zScores = robustZScores(values);
  const maxAbs = Math.max(...zScores.map((z) => Math.abs(z)));
  if (maxAbs < 3.5) return [];
  const index = zScores.findIndex((z) => Math.abs(z) === maxAbs);
  return [{
    id: nextId(),
    type: 'outlier',
    values: { metric, key: `第 ${index + 1} 行`, z: round2(zScores[index]) },
  }];
}

function contributionObservation(nextId, rows, dateField, metric, lastPeriod, previousPeriod) {
  const dimensions = new Set();
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (key === dateField || key === metric) continue;
      if (typeof value === 'string' && value) dimensions.add(key);
    }
  }
  const dimension = [...dimensions][0];
  if (!dimension) return [];
  const buckets = new Map();
  for (const row of rows) {
    const period = String(row[dateField] ?? '');
    const category = String(row[dimension] ?? '');
    if (!category) continue;
    if (period !== lastPeriod && period !== previousPeriod) continue;
    const value = Number(row[metric]);
    if (!Number.isFinite(value)) continue;
    const bucket = buckets.get(category) || { current: 0, previous: 0 };
    if (period === lastPeriod) bucket.current += value;
    else bucket.previous += value;
    buckets.set(category, bucket);
  }
  const totalDelta = [...buckets.values()].reduce((sum, bucket) => sum + bucket.current - bucket.previous, 0);
  if (Math.abs(totalDelta) < 1e-9) return [];
  const ranking = [...buckets.entries()]
    .map(([key, bucket]) => ({ key, contribution: round2(((bucket.current - bucket.previous) / totalDelta) * 100) }))
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, 3);
  if (!ranking.length) return [];
  return [{
    id: nextId(),
    type: 'contribution',
    values: { dimension, metric, period: lastPeriod, comparedWith: previousPeriod },
    ranking,
  }];
}

function robustZScores(values) {
  if (values.length < 4) return values.map(() => 0);
  const sorted = [...values].sort((a, b) => a - b);
  const median = quantile(sorted, 0.5);
  const deviations = values.map((value) => Math.abs(value - median)).sort((a, b) => a - b);
  const mad = quantile(deviations, 0.5);
  if (mad < 1e-9) {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const sd = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
    if (sd < 1e-9) return values.map(() => 0);
    return values.map((value) => (value - mean) / sd);
  }
  return values.map((value) => (0.6745 * (value - median)) / mad);
}

function quantile(sorted, q) {
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function round2(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) / 100 : null;
}
