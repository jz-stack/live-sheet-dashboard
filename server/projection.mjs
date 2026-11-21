function aggregate(rows, dimension, measure, { date = false, limit = 10 } = {}) {
  if (!dimension || !measure) return [];
  const buckets = new Map();
  for (const row of rows) {
    const key = row[dimension.name];
    const value = Number(row[measure.name]);
    if (key === null || key === undefined || key === '' || !Number.isFinite(value)) continue;
    buckets.set(key, (buckets.get(key) || 0) + value);
  }
  let points = [...buckets].map(([key, value]) => ({ key: String(key), value }));
  if (date) points.sort((a, b) => a.key.localeCompare(b.key));
  else points = points.sort((a, b) => b.value - a.value).slice(0, limit);
  return points;
}

function selectMain(snapshot) {
  const numbers = snapshot.schema.filter((column) => column.type === 'number' && column.distinct > 1);
  const dates = snapshot.schema.filter((column) => column.type === 'date');
  const dimensions = snapshot.schema.filter(
    (column) => column.type === 'string' && column.distinct > 1 && column.distinct <= 30,
  );
  const y = numbers[0];
  const x = dates[0] || dimensions[0];
  if (!x || !y) return null;
  const points = aggregate(snapshot.rows, x, y, { date: x.type === 'date' });
  if (!points.length) return null;
  return { x, y, points, kind: x.type === 'date' ? 'line' : 'bar' };
}

function selectSub(snapshot, main) {
  const numbers = snapshot.schema.filter((column) => column.type === 'number' && column.distinct > 1);
  const y = main?.y || numbers[0];
  const dimension = snapshot.schema.find(
    (column) => column.type === 'string' && column.distinct > 1 && column.distinct <= 40 && column.name !== main?.x?.name,
  );
  if (!y || !dimension) return null;
  const points = aggregate(snapshot.rows, dimension, y);
  if (!points.length) return null;
  return { dimension, y, points, kind: points.length <= 8 ? 'pie' : 'bar' };
}

function calculateKpis(snapshot, main) {
  if (!main) return [];
  let sum = 0;
  let count = 0;
  let max = 0;
  for (const row of snapshot.rows) {
    const value = Number(row[main.y.name]);
    if (!Number.isFinite(value)) continue;
    sum += value;
    count += 1;
    if (count === 1 || value > max) max = value;
  }
  const average = count ? sum / count : 0;
  return [
    { key: 'sum', label: `${main.y.name}合计`, raw: sum, delta: true },
    { key: 'count', label: '记录数', raw: snapshot.rows.length, delta: false, sub: `${snapshot.headers.length} 个字段` },
    { key: 'average', label: '平均单条', raw: average, delta: true },
    { key: 'max', label: '峰值', raw: max, delta: true },
  ];
}

export function emptyProjection() {
  return { main: null, sub: null, kpis: [], preview: { headers: [], rows: [] } };
}

export function buildProjection(snapshot) {
  const main = selectMain(snapshot);
  const sub = selectSub(snapshot, main);
  const headers = snapshot.headers.slice(0, 7);
  const previewRows = snapshot.rows.slice(0, 12).map((row, index) => ({
    id: snapshot.rowNumbers[index] ?? index + 1,
    values: headers.map((header) => row[header]),
  }));
  return {
    main,
    sub,
    kpis: calculateKpis(snapshot, main),
    preview: { headers, rows: previewRows },
  };
}
