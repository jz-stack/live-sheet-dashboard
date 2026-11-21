import { api } from './api.js';

const $ = (id) => document.getElementById(id);
const els = {
  dot: $('statusDot'), version: $('version'), live: $('liveTag'), fileName: $('fileName'),
  sourceSelect: $('sourceSelect'), updatedAt: $('updatedAt'), simulate: $('simulate'),
  editToggle: $('editToggle'), undoButton: $('undoButton'), resetButton: $('resetButton'),
  addButton: $('addButton'), addType: $('addComponentType'), layoutHint: $('layoutHint'),
  canvas: $('canvas'), warnings: $('warnings'), warnCount: $('warnCount'), log: $('log'),
  footInfo: $('footInfo'), docRevision: $('docRevision'), configDialog: $('configDialog'),
  configForm: $('configForm'), configTitle: $('configTitle'), configX: $('configX'),
  configY: $('configY'), configSeries: $('configSeries'), configAgg: $('configAgg'),
  configTip: $('configTip'), configCancel: $('configCancel'),
  aiMode: $('aiMode'), aiChartForm: $('aiChartForm'), aiInstruction: $('aiInstruction'),
  aiChartButton: $('aiChartButton'), aiInsightScan: $('aiInsightScan'),
  aiMaintenanceScan: $('aiMaintenanceScan'), aiSuggestions: $('aiSuggestions'), aiInsights: $('aiInsights'),
};
// canvas 取不到 CSS 变量，这里的色值需与 style.css 的 :root 令牌手工同步
const PALETTE = ['#22D3EE', '#8B7BFF', '#2DD4A7', '#F5B23D', '#FF6B81', '#5B9BFF', '#C084FC', '#94E34A'];
const AXIS = {
  axisLine: { lineStyle: { color: 'rgba(126,164,220,0.16)' } }, axisTick: { show: false },
  axisLabel: { color: '#93A5BF', fontSize: 11 }, splitLine: { lineStyle: { color: 'rgba(126,164,220,0.06)' } },
};
const TOOLTIP = {
  renderMode: 'richText', backgroundColor: '#0B1018F2', borderColor: 'rgba(126,164,220,0.20)',
  textStyle: { color: '#E9F0FB', fontSize: 12 }, valueFormatter: (value) => compact(value),
};
const nf = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
// 表格单元格不能一刀切按整数：毛利率 0.325、工时 1.5 会被抹成 0 和 2。
const nfPct = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 });
const nfSmall = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const nfLarge = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
const logs = [];
const chartInstances = new Map();
let currentInstance = null;
let currentRevision = -1;
let currentDocumentRevision = null;
let currentDocumentId = null;
let latest = null;
let previousKpis = new Map();
let previousCells = new Map();
let editMode = false;
let syncing = false;
let syncPending = false;
let events = null;
let resizeFrame = null;
let currentConfigId = null;
let dragging = false;
let aiSuggestionMap = new Map();
let aiInsightList = [];
let aiPreviewSignature = '';
let lastSourceSignature = '';

// ---------------------------------------------------------------------------
// AI 助手面板：一句话建图 / 洞察 / 建议审阅（模型输出一律转义后展示）
//
// 交互原则：AI 的结论直接画在画布上（预览层），采用 / 撤销 按钮就压在
// 被改动的图表上方，而不是让用户靠文字描述去想象效果。
// ---------------------------------------------------------------------------

const SEVERITY_LABEL = { info: '观察', warning: '关注', critical: '警报' };
const PREVIEW_PREFIX = '__ai_preview__';
const PREVIEW_KIND = { chart: '建图预览', maintenance: '修复预览' };

function pendingPreviews() {
  return [...aiSuggestionMap.values()].filter((item) => {
    const preview = item.preview;
    if (item.state !== 'pending' || !preview || preview.error) return false;
    return Boolean(preview.added?.length || preview.changed?.length || preview.removed?.length);
  });
}

function clearAiPreviews() {
  for (const [id, chart] of [...chartInstances]) {
    if (!id.startsWith(PREVIEW_PREFIX)) continue;
    chart.dispose();
    chartInstances.delete(id);
  }
  for (const node of els.canvas.querySelectorAll('.ai-ghost, .ai-inline-bar')) node.remove();
  for (const node of els.canvas.querySelectorAll('.ai-affected, .ai-superseded')) {
    node.classList.remove('ai-affected', 'ai-superseded');
  }
}

function previewActionBar(suggestion, hint) {
  return `<div class="ai-preview-bar">
    <span class="ai-preview-tag">AI ${esc(PREVIEW_KIND[suggestion.kind] || '预览')}</span>
    <span class="ai-preview-text" title="${esc(hint || suggestion.summary)}">${esc(hint || suggestion.summary)}</span>
    <span class="ai-preview-actions">
      <button class="ai-act accept" data-ai-accept="${esc(suggestion.id)}">采用</button>
      <button class="ai-act reject" data-ai-reject="${esc(suggestion.id)}">撤销</button>
    </span>
  </div>`;
}

function bindPreviewActions(root, suggestion) {
  root.querySelector('[data-ai-accept]')?.addEventListener('click', (event) => {
    event.stopPropagation();
    acceptAiSuggestion(suggestion.id);
  });
  root.querySelector('[data-ai-reject]')?.addEventListener('click', (event) => {
    event.stopPropagation();
    rejectAiSuggestion(suggestion.id);
  });
}

function previewHint(suggestion) {
  const steps = suggestion.preview?.steps;
  if (suggestion.kind === 'maintenance' && steps?.length) return steps.join(' · ');
  return suggestion.summary;
}

function addAiGhost(suggestion, tile) {
  const spec = tile.spec;
  if (!spec?.span) return null;
  const ghost = document.createElement('article');
  ghost.className = `ai-ghost ai-ghost-${spec.type}`;
  ghost.dataset.aiPreview = suggestion.id;
  ghost.dataset.aiComponent = spec.id;
  applySpan(ghost, spec.span);
  ghost.innerHTML = `${previewActionBar(suggestion, previewHint(suggestion))}
    <div class="component-head">
      <div class="drag-handle"><h2>${esc(spec.title)}</h2><span class="status-badge"></span></div>
    </div>
    <div class="component-body"></div>`;
  bindPreviewActions(ghost, suggestion);
  els.canvas.appendChild(ghost);

  // 预览用一份独立的投影（id 加前缀）复用正式渲染管线，保证像素级一致；
  // 同时隔离 previousKpis / previousCells，避免污染正式组件的涨跌与闪烁对比。
  const savedKpis = previousKpis;
  const savedCells = previousCells;
  previousKpis = new Map(savedKpis);
  previousCells = new Map(savedCells);
  try {
    const projection = {
      ...tile,
      id: `${PREVIEW_PREFIX}${suggestion.id}:${tile.id}`,
      spec,
    };
    setComponentStatus(ghost, projection.status || 'ok', projection.reason);
    renderComponentBody(ghost, projection);
  } finally {
    previousKpis = savedKpis;
    previousCells = savedCells;
  }
  return ghost;
}

function paintAiPreviews() {
  const pending = pendingPreviews();
  const signature = JSON.stringify(pending.map((item) => [
    item.id, item.preview.documentRevision, item.preview.datasetVersion, item.summary,
  ]));
  if (signature === aiPreviewSignature) return;
  aiPreviewSignature = signature;
  clearAiPreviews();
  if (!pending.length) return;

  const documentComponents = new Map((latest?.document?.components || []).map((spec) => [spec.id, spec]));
  // 同一块组件只叠一层预览：多条待审建议指向同一处时，先到先显示，避免图表互相覆盖。
  const claimed = new Set();
  const claim = (id) => {
    if (!id || claimed.has(`${id}`)) return false;
    claimed.add(`${id}`);
    return true;
  };
  for (const suggestion of pending) {
    const preview = suggestion.preview;
    for (const tile of preview.changed || []) {
      const host = els.canvas.querySelector(`.component[data-id="${CSS.escape(tile.spec.id)}"]`);
      if (host) host.classList.add('ai-affected', 'ai-superseded');
      if (claim(tile.spec.id)) addAiGhost(suggestion, tile);
    }
    for (const tile of preview.added || []) {
      if (claim(tile.spec.id)) addAiGhost(suggestion, tile);
    }
    for (const removed of preview.removed || []) {
      const host = els.canvas.querySelector(`.component[data-id="${CSS.escape(removed.id)}"]`);
      if (!host) continue;
      host.classList.add('ai-affected', 'ai-superseded');
      const span = documentComponents.get(removed.id)?.span;
      const covered = span && [...(preview.added || []), ...(preview.changed || [])]
        .some((tile) => spansOverlap(tile.spec.span, span));
      if (covered) continue;
      const bar = document.createElement('div');
      bar.className = 'ai-inline-bar';
      bar.innerHTML = previewActionBar(suggestion, `建议删除「${removed.title}」`);
      bindPreviewActions(bar, suggestion);
      host.querySelector('.component-body')?.appendChild(bar);
    }
  }
}

function spansOverlap(a, b) {
  if (!a || !b) return false;
  return a.col < b.col + b.colSpan && a.col + a.colSpan > b.col && a.row < b.row + b.rowSpan && a.row + a.rowSpan > b.row;
}

function focusAiPreview(id) {
  const ghost = els.canvas.querySelector(`.ai-ghost[data-ai-preview="${CSS.escape(id)}"]`)
    || els.canvas.querySelector(`.ai-inline-bar [data-ai-accept="${CSS.escape(id)}"]`)?.closest('.component');
  if (!ghost) { log('预览已不在画布上，建议可能已过期'); return; }
  ghost.scrollIntoView({ behavior: 'smooth', block: 'center' });
  ghost.classList.remove('ai-focus');
  void ghost.offsetWidth;
  ghost.classList.add('ai-focus');
}

function renderAiSuggestions() {
  const pending = [...aiSuggestionMap.values()].filter((item) => item.state === 'pending').slice(0, 4);
  if (!pending.length) {
    els.aiSuggestions.innerHTML = '<div class="ai-empty">暂无待审阅建议</div>';
    return;
  }
  els.aiSuggestions.innerHTML = pending.map((item) => {
    const isChart = item.kind === 'chart';
    const preview = item.preview || {};
    const onCanvas = Boolean(preview.added?.length || preview.changed?.length || preview.removed?.length);
    const steps = preview.steps?.length ? preview.steps : (item.patches || []).map((patch) => `${patch.op}${patch.reason ? `：${patch.reason}` : ''}`);
    const stepLines = steps.map((step) => `<li>${esc(step)}</li>`).join('');
    const stateText = preview.error
      ? `<p class="ai-rationale">暂不能预览：${esc(preview.error)}</p>`
      : onCanvas
        ? '<p class="ai-rationale">已在画布上直接渲染结果，采用或撤销就在图表上方。</p>'
        : '';
    return `<article class="ai-card ${isChart ? 'chart' : 'maint'}">
      <div class="ai-card-head">
        <span class="ai-kind">${isChart ? '建图' : '维护'}</span>
        <span class="ai-state" title="${esc(item.summary)}">${esc(item.summary)}</span>
      </div>
      ${item.detail?.rationale && !onCanvas ? `<p class="ai-rationale">${esc(item.detail.rationale)}</p>` : ''}
      ${stateText}
      ${stepLines ? `<ul class="ai-patches">${stepLines}</ul>` : ''}
      <div class="ai-card-actions">
        ${onCanvas ? `<button class="btn mini-wide" data-ai-focus="${esc(item.id)}">定位预览</button>` : ''}
        <button class="btn primary mini-wide" data-ai-accept="${esc(item.id)}">采用</button>
        <button class="btn danger mini-wide" data-ai-reject="${esc(item.id)}">撤销</button>
      </div>
    </article>`;
  }).join('');
  for (const button of els.aiSuggestions.querySelectorAll('[data-ai-focus]')) {
    button.addEventListener('click', () => focusAiPreview(button.dataset.aiFocus));
  }
  for (const button of els.aiSuggestions.querySelectorAll('[data-ai-accept]')) {
    button.addEventListener('click', () => acceptAiSuggestion(button.dataset.aiAccept));
  }
  for (const button of els.aiSuggestions.querySelectorAll('[data-ai-reject]')) {
    button.addEventListener('click', () => rejectAiSuggestion(button.dataset.aiReject));
  }
}

function renderAiInsights() {
  const active = aiInsightList.filter((item) => !item.stale).slice(0, 3);
  if (!active.length) {
    els.aiInsights.innerHTML = '<div class="ai-empty">暂无洞察，等待数据变化</div>';
    return;
  }
  els.aiInsights.innerHTML = active.map((item) => `<div class="insight ${esc(item.severity)}">
    <span class="insight-sev">${SEVERITY_LABEL[item.severity] || '观察'}</span>
    <div class="insight-body">
      <p class="insight-statement">${esc(item.statement)}</p>
      ${item.suggestedAction ? `<p class="insight-action">${esc(item.suggestedAction)}</p>` : ''}
    </div>
  </div>`).join('');
}

async function acceptAiSuggestion(id) {
  try {
    await api.aiAcceptSuggestion(id);
    aiSuggestionMap.delete(id);
    log('已采用 AI 建议，画布已更新');
    renderAiSuggestions();
    aiPreviewSignature = '';
    await sync();
  } catch (error) {
    log(`采用失败：${error.message}`);
    await reloadAiSuggestions();
  }
}

async function rejectAiSuggestion(id) {
  try {
    await api.aiRejectSuggestion(id);
    aiSuggestionMap.delete(id);
    log('已撤销 AI 建议，画布保持原样');
    renderAiSuggestions();
    aiPreviewSignature = '';
    paintAiPreviews();
  } catch (error) { log(`撤销失败：${error.message}`); }
}

async function reloadAiSuggestions() {
  try {
    const { suggestions } = await api.aiSuggestions();
    aiSuggestionMap = new Map(suggestions.map((item) => [item.id, item]));
    renderAiSuggestions();
    aiPreviewSignature = '';
    paintAiPreviews();
  } catch { /* 面板保持现状 */ }
}

els.aiChartForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const instruction = els.aiInstruction.value.trim();
  if (!instruction) { log('请先输入建图指令'); return; }
  els.aiChartButton.disabled = true;
  try {
    const result = await api.aiChart(instruction);
    const task = result.task || {};
    log(`AI 建图任务 ${task.status || '完成'}${task.cached ? '（缓存命中）' : ''}`);
    if (result.suggestion) {
      aiSuggestionMap.set(result.suggestion.id, result.suggestion);
      renderAiSuggestions();
      aiPreviewSignature = '';
      paintAiPreviews();
      els.aiInstruction.value = '';
      if (pendingPreviews().some((item) => item.id === result.suggestion.id)) {
        focusAiPreview(result.suggestion.id);
        log('图表已渲染到画布，确认后点「采用」', true);
      }
    }
  } catch (error) {
    log(`AI 建图失败：${error.message}`);
  } finally {
    els.aiChartButton.disabled = false;
  }
});

els.aiInsightScan.addEventListener('click', async () => {
  els.aiInsightScan.disabled = true;
  try {
    const result = await api.aiInsightScan();
    if (result.count) log('洞察已更新');
    else log(result.reason || '没有显著变化');
  } catch (error) { log(`洞察扫描失败：${error.message}`); }
  finally { setTimeout(() => { els.aiInsightScan.disabled = false; }, 600); }
});

els.aiMaintenanceScan.addEventListener('click', async () => {
  els.aiMaintenanceScan.disabled = true;
  try {
    const result = await api.aiMaintenanceScan();
    if (result.count) log('画布体检发现异常，已生成维护建议');
    else log(result.reason || '画布组件状态正常');
  } catch (error) { log(`画布体检失败：${error.message}`); }
  finally { setTimeout(() => { els.aiMaintenanceScan.disabled = false; }, 600); }
});

async function loadAiState({ insights = true } = {}) {
  try {
    const [suggestionPayload, insightPayload] = await Promise.all([
      api.aiSuggestions(),
      insights ? api.aiInsights() : Promise.resolve({ insights: aiInsightList }),
    ]);
    aiSuggestionMap = new Map((suggestionPayload.suggestions || []).map((item) => [item.id, item]));
    if (insights) aiInsightList = insightPayload.insights || [];
    renderAiSuggestions();
    if (insights) renderAiInsights();
    aiPreviewSignature = '';
    paintAiPreviews();
  } catch (error) { log(`AI 面板初始化失败：${error.message}`); }
}

async function loadAiMode() {
  try {
    const caps = await api.aiCapabilities();
    els.aiMode.textContent = caps.external
      ? `外部模型 · ${caps.model} · ${caps.privacyMode}`
      : '本地规则模式（离线可用）';
  } catch { /* 保持默认文案 */ }
}

function compact(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e8) return `${nf1.format(value / 1e8)} 亿`;
  if (abs >= 1e4) return `${nf1.format(value / 1e4)} 万`;
  return nf.format(value);
}

// 表格里的数字展示：整数保留千分位，小数按量级保留有效位，不能一律四舍五入成整数。
function cellNumber(value) {
  if (!Number.isFinite(value)) return '—';
  if (Number.isInteger(value)) return nf.format(value);
  const abs = Math.abs(value);
  if (abs >= 1000) return nfLarge.format(value);
  if (abs >= 1) return nfSmall.format(value);
  return nfPct.format(value);
}
function clock(iso) {
  return (iso ? new Date(iso) : new Date()).toLocaleTimeString('zh-CN', { hour12: false });
}
function esc(value) {
  return String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}
function setDot(kind) { els.dot.className = `dot ${kind}`; }
function log(message, hot = false) {
  logs.unshift({ time: clock(), message, hot });
  if (logs.length > 14) logs.pop();
  els.log.innerHTML = logs.map((entry) => `<li class="${entry.hot ? 'hot' : ''}"><span class="t">${entry.time}</span><span class="m">${esc(entry.message)}</span></li>`).join('');
}
function pulse() {
  els.live.classList.remove('pulse');
  void els.live.offsetWidth;
  els.live.classList.add('pulse');
}
function safeRender(name, render) {
  try { render(); } catch (error) { log(`${name}渲染失败：${error.message}`); }
}
function disposeCharts() {
  for (const chart of chartInstances.values()) chart.dispose();
  chartInstances.clear();
}
function setComponentStatus(el, status, reason) {
  el.classList.remove('status-ok', 'status-degraded', 'status-invalid', 'status-empty');
  el.classList.add(`status-${status}`);
  const badge = el.querySelector('.status-badge');
  if (badge) {
    const label = { ok: '', degraded: '降级', invalid: '配置异常', empty: '暂无数据' }[status] || '';
    badge.textContent = label;
    badge.hidden = !label;
    badge.title = reason || label;
  }
}
function applySpan(el, span) {
  el.style.gridColumn = `${span.col + 1} / span ${span.colSpan}`;
  el.style.gridRow = `${span.row + 1} / span ${span.rowSpan}`;
}

function buildCanvas(state) {
  const doc = state.document;
  disposeCharts();
  els.canvas.innerHTML = '';
  aiPreviewSignature = '';
  const grid = doc.grid;
  els.canvas.style.gridTemplateColumns = `repeat(${grid.columns}, 1fr)`;
  els.canvas.style.gridAutoRows = `${grid.rowHeight}px`;
  els.canvas.style.gap = `${grid.gap}px`;
  els.canvas.style.padding = `${grid.padding}px`;
  const stateMap = new Map((state.components || []).map((component) => [component.spec.id, component]));
  for (const spec of doc.components) {
    const component = document.createElement('article');
    component.className = `component component-${spec.type}`;
    component.dataset.id = spec.id;
    applySpan(component, spec.span);
    component.innerHTML = `
      <div class="component-head">
        <div class="drag-handle">
          <h2>${esc(spec.title)}</h2>
          <span class="status-badge"></span>
        </div>
        <div class="component-actions">
          <button class="mini" data-action="config" title="配置数据编码">配置</button>
          <button class="mini danger" data-action="remove" title="删除组件">删</button>
        </div>
      </div>
      <div class="component-body"></div>
      <div class="resize-handle resize-se" data-resize="se" title="拖动调整大小"></div>
      <div class="resize-handle resize-w" data-resize="w" title="拖动调整宽度（拉左边界）"></div>
      <div class="resize-handle resize-n" data-resize="n" title="拖动调整高度（拉上边界）"></div>`;
    component.querySelector('[data-action="config"]').addEventListener('click', () => openConfig(spec.id));
    component.querySelector('[data-action="remove"]').addEventListener('click', () => removeComponent(spec.id));
    component.querySelector('.component-head').addEventListener('pointerdown', (event) => {
      if (event.target.closest('button')) return;
      startDrag(event, spec.id, 'move');
    });
    for (const grip of component.querySelectorAll('.resize-handle')) {
      // 已经到最小尺寸的方向不必显示手柄：1 行高的 KPI 没有可压缩空间，1 列宽同理
      const dir = grip.dataset.resize;
      if ((dir === 'n' && spec.span.rowSpan <= 1) || (dir === 'w' && spec.span.colSpan <= 1)) {
        grip.style.display = 'none';
        continue;
      }
      grip.addEventListener('pointerdown', (event) => {
        if (!editMode) return;
        event.preventDefault();
        event.stopPropagation();
        startDrag(event, spec.id, `resize-${dir}`);
      });
    }
    els.canvas.appendChild(component);
    const projected = stateMap.get(spec.id);
    setComponentStatus(component, projected?.status || 'empty', projected?.reason);
    renderComponentBody(component, projected || { spec, status: 'empty', data: null });
  }
  currentDocumentRevision = doc.revision;
  currentDocumentId = doc.id;
}

function renderKpiBody(body, component) {
  const value = component.data?.raw;
  const next = value ?? 0;
  let deltaHtml = '<span class="delta flat">当前快照</span>';
  const previous = previousKpis.get(component.id);
  if (typeof previous === 'number' && Number.isFinite(Number(next)) && previous !== 0 && component.data?.agg !== 'count') {
    const percent = ((next - previous) / Math.abs(previous)) * 100;
    const cls = Math.abs(percent) < 0.05 ? 'flat' : percent > 0 ? 'up' : 'down';
    const arrow = Math.abs(percent) < 0.05 ? '—' : percent > 0 ? '▲' : '▼';
    deltaHtml = `<span class="delta ${cls}">${arrow} ${Math.abs(percent).toFixed(2)}% 较上次</span>`;
  }
  previousKpis.set(component.id, Number.isFinite(Number(next)) ? next : null);
  body.innerHTML = `<div class="kpi"><span class="value">${esc(component.data?.agg === 'count' ? nf.format(next) : compact(next))}</span>${deltaHtml}</div>`;
}

function renderChartBody(body, component) {
  let chart = chartInstances.get(component.id);
  if (chart && chart.__type !== component.type) {
    chart.dispose();
    chartInstances.delete(component.id);
    chart = null;
  }
  if (!chart) {
    body.innerHTML = '<div class="chart"></div>';
    chart = echarts.init(body.querySelector('.chart'), null, { renderer: 'canvas' });
    chart.__type = component.type;
    chartInstances.set(component.id, chart);
  }
  const data = component.data || { labels: [], series: [] };
  const accent = component.spec.style?.accent;
  const series = (data.series || []).map((item, index) => ({
    type: component.type,
    name: item.name,
    data: item.values.map((value) => (value === null || value === undefined ? null : value)),
    color: accent || PALETTE[index % PALETTE.length],
    ...(component.type === 'line' ? {
      smooth: true, symbol: 'circle', symbolSize: 5, showSymbol: (data.labels?.length || 0) <= 40,
      lineStyle: { width: 2 }, areaStyle: index === 0 ? { color: 'rgba(34,211,238,0.16)' } : undefined,
    } : {
      barMaxWidth: 34, itemStyle: { color: accent || PALETTE[index % PALETTE.length], borderRadius: [4, 4, 0, 0] },
    }),
  }));
  chart.setOption({
    animationDuration: 420, animationEasing: 'cubicOut',
    // right 留够空间，否则最后一个日期标签会被画布边缘裁掉半截
    grid: { left: 6, right: 34, top: 24, bottom: 4, containLabel: true },
    tooltip: { trigger: 'axis', ...TOOLTIP },
    legend: series.length > 1 ? { top: 0, itemWidth: 8, itemHeight: 8, icon: 'circle', textStyle: { color: '#93A5BF', fontSize: 11 } } : undefined,
    xAxis: { type: 'category', data: data.labels || [], boundaryGap: component.type === 'bar', ...AXIS, splitLine: { show: false }, axisLabel: { ...AXIS.axisLabel, hideOverlap: true } },
    yAxis: { type: 'value', ...AXIS, axisLine: { show: false } },
    series,
  }, { notMerge: true, lazyUpdate: true });
}

function renderPieBody(body, component) {
  let chart = chartInstances.get(component.id);
  if (chart && chart.__type !== 'pie') {
    chart.dispose();
    chartInstances.delete(component.id);
    chart = null;
  }
  if (!chart) {
    body.innerHTML = '<div class="chart"></div>';
    chart = echarts.init(body.querySelector('.chart'), null, { renderer: 'canvas' });
    chart.__type = 'pie';
    chartInstances.set(component.id, chart);
  }
  const points = component.data?.points || [];
  chart.setOption({
    animationDuration: 420,
    color: component.spec.style?.accent ? [component.spec.style.accent, ...PALETTE.slice(1)] : PALETTE,
    tooltip: { trigger: 'item', ...TOOLTIP },
    legend: { bottom: 0, itemWidth: 8, itemHeight: 8, icon: 'circle', textStyle: { color: '#93A5BF', fontSize: 11 } },
    series: [{
      type: 'pie', radius: ['46%', '68%'], center: ['50%', '44%'], avoidLabelOverlap: true,
      itemStyle: { borderColor: '#0A0F18', borderWidth: 2 }, label: { show: false },
      data: points.map((point) => ({ name: point.name, value: point.value })),
    }],
  }, { notMerge: true, lazyUpdate: true });
}

function renderTableBody(body, component) {
  const preview = component.data || { headers: [], rows: [] };
  const nextCells = new Map();
  const head = `<thead><tr>${preview.headers.map((header) => `<th>${esc(header)}</th>`).join('')}</tr></thead>`;
  const rows = preview.rows.map((row) => {
    nextCells.set(row.id, row.values);
    const previous = previousCells.get(row.id);
    const cells = row.values.map((value, index) => {
      const isNumber = typeof value === 'number';
      let cls = isNumber ? 'num' : '';
      if (previous && previous[index] !== undefined && previous[index] !== value) {
        cls += isNumber && typeof previous[index] === 'number' ? (previous[index] < value ? ' flash-up' : ' flash-down') : ' flash-up';
      }
      const text = isNumber ? cellNumber(value) : value === null || value === undefined ? '—' : esc(value);
      return `<td class="${cls.trim()}">${text}</td>`;
    }).join('');
    return `<tr data-row="${row.id}">${cells}</tr>`;
  }).join('');
  body.innerHTML = `<div class="table-wrap"><table>${head}<tbody>${rows || '<tr><td class="empty-table">暂无数据</td></tr>'}</tbody></table></div>`;
  previousCells = nextCells;
}

function disposeComponentChart(id) {
  const chart = chartInstances.get(id);
  if (!chart) return;
  chart.dispose();
  chartInstances.delete(id);
}

function renderComponentBody(componentEl, component) {
  const body = componentEl.querySelector('.component-body');
  if (!component || component.status === 'invalid') {
    // 必须销毁实例：body 被替换成提示文案后，旧 canvas 已脱离 DOM，
    // 只 clear() 会让恢复后的 setOption 画在看不见的节点上。
    disposeComponentChart(component?.spec?.id);
    body.innerHTML = `<div class="state-message">${esc(component?.reason || '组件编码无效，请重新配置')}</div>`;
    return;
  }
  if (!component.data) {
    disposeComponentChart(component.spec.id);
    body.innerHTML = `<div class="state-message">${esc(component.reason || '暂无数据')}</div>`;
    return;
  }
  switch (component.spec.type) {
    case 'kpi': safeRender('指标卡', () => renderKpiBody(body, component)); break;
    case 'line':
    case 'bar': safeRender('图表', () => renderChartBody(body, component)); break;
    case 'pie': safeRender('占比图', () => renderPieBody(body, component)); break;
    case 'table': safeRender('表格', () => renderTableBody(body, component)); break;
    case 'text': body.innerHTML = `<div class="text-block">${esc(component.data.text || component.spec.title)}</div>`; break;
    default: body.innerHTML = '<div class="state-message">未知组件类型</div>';
  }
}

function updateComponents(state) {
  const stateMap = new Map((state.components || []).map((component) => [component.spec.id, component]));
  for (const el of els.canvas.querySelectorAll('.component')) {
    const id = el.dataset.id;
    const component = stateMap.get(id);
    if (!component) continue;
    setComponentStatus(el, component.status, component.reason);
    safeRender(`组件「${component.spec.title}」`, () => renderComponentBody(el, component));
  }
}

function renderWarnings(state) {
  const warnings = [...(state.warnings || [])];
  for (const component of state.components || []) {
    if (component.status !== 'invalid') continue;
    warnings.push({ level: 'error', message: `「${component.spec?.title || component.id}」${component.reason || '配置异常'}` });
  }
  if (state.status === 'error' && state.error) warnings.unshift({ level: 'error', message: `读取失败：${state.error.message}` });
  if (state.status === 'missing') warnings.unshift({ level: 'warn', message: '文件不存在，当前展示最后一次成功快照' });
  els.warnCount.textContent = warnings.length ? `${warnings.length} 条` : '';
  els.warnings.innerHTML = warnings.length
    ? warnings.slice(0, 8).map((warning) => `<div class="warn-item ${esc(warning.level)}">${esc(warning.message)}</div>`).join('')
    : '<div class="warn-item empty">没发现问题，表结构干净</div>';
}

/**
 * 数据源切换器：合并视图 + 每张工作表。
 * 只在工作表清单变化时重建选项，避免下拉框在轮询中被重置。
 */
function renderSourceSelect(state) {
  const sheets = state.sheets || state.source?.sheets || [];
  // 隐藏表 / 解析失败的表不参与合并，计数里要排掉，否则会出现「全部工作表（7）」但只合并了 6 张
  const usable = sheets.filter((sheet) => sheet.status !== 'skipped');
  const currentValue = state.mode === 'sheet' && state.activeSheet ? `sheet:${state.activeSheet}` : 'merged';
  const signature = `${state.sheets?.map((sheet) => sheet.name).join('|')}#${sheets.length}`;
  if (signature !== lastSourceSignature) {
    const options = [`<option value="merged">全部工作表（${usable.length}）</option>`];
    for (const sheet of sheets) {
      const suffix = sheet.hidden ? '（隐藏）' : '';
      const disabled = sheet.status === 'skipped' ? ' disabled' : '';
      options.push(`<option value="sheet:${esc(sheet.name)}"${disabled}>${esc(sheet.name)}${suffix}</option>`);
    }
    if (!options.length) options.push('<option value="merged">等待工作表</option>');
    els.sourceSelect.innerHTML = options.join('');
    lastSourceSignature = signature;
  }
  if (els.sourceSelect.value !== currentValue) els.sourceSelect.value = currentValue;
  els.sourceSelect.classList.toggle('is-merged', state.mode === 'merged');
  els.sourceSelect.title = state.mode === 'merged'
    ? `合并 ${usable.length} 张工作表，可用「${state.sheetColumn || '工作表'}」列做分表对比`
    : `当前数据源：工作表 ${state.activeSheet}`;
}

function render(state) {
  latest = state;
  els.version.textContent = `v${state.version}`;
  els.fileName.textContent = state.fileName || '未加载文件';
  els.fileName.title = state.fileName || '';
  renderSourceSelect(state);
  els.updatedAt.textContent = state.updatedAt ? `${clock(state.updatedAt)} 更新` : '等待数据';
  els.docRevision.textContent = `画布 r${state.documentRevision ?? 0}`;
  els.footInfo.textContent = state.parseMs ? `解析 ${state.parseMs}ms · ${state.rowCount} 行 · 组件 ${state.components?.length || 0} 个` : '本地服务 · worker 解析 → 快照 → SSE → Document → ECharts';
  setDot(state.status === 'ready' ? 'ok' : state.status === 'error' || state.status === 'missing' ? 'err' : 'busy');
  if (!state.document) {
    renderWarnings(state);
    return;
  }
  if (state.documentRevision !== currentDocumentRevision || state.document.id !== currentDocumentId) {
    buildCanvas(state);
  } else {
    updateComponents(state);
  }
  renderWarnings(state);
  paintAiPreviews();
}

function canvasMetrics() {
  const rect = els.canvas.getBoundingClientRect();
  const style = window.getComputedStyle(els.canvas);
  const gap = Number.parseFloat(style.columnGap || style.gap) || 0;
  const padding = Number.parseFloat(style.padding) || 0;
  const columns = latest.document.grid.columns;
  const columnWidth = (rect.width - padding * 2 - gap * (columns - 1)) / columns;
  const rowUnit = latest.document.grid.rowHeight + gap;
  return { rect, columnWidth, rowUnit, columns, padding, columnUnit: columnWidth + gap };
}

function startDrag(event, id, mode) {
  if (!editMode) return;
  const spec = latest.document.components.find((item) => item.id === id);
  const el = els.canvas.querySelector(`.component[data-id="${CSS.escape(id)}"]`);
  if (!spec || !el) return;
  event.preventDefault();
  const metrics = canvasMetrics();
  const start = { x: event.clientX, y: event.clientY, span: { ...spec.span } };
  const original = { ...spec.span };
  let preview = { ...spec.span };
  let moved = false;
  dragging = true;
  el.classList.add('is-resizing');

  // 本地重叠预检：拖到相邻组件边上就停住，而不是松手后被后端拒绝再整体弹回
  const overlaps = (a, b) => a.col < b.col + b.colSpan && b.col < a.col + a.colSpan
    && a.row < b.row + b.rowSpan && b.row < a.row + a.rowSpan;
  const others = (latest.document.components || [])
    .filter((item) => item.id !== id)
    .map((item) => item.span);
  const fits = (candidate) => !others.some((span) => overlaps(candidate, span));
  const clampResize = (candidate, dir) => {
    let next = { ...candidate };
    for (let guard = 0; guard < 200; guard += 1) {
      if (fits(next)) return next;
      if (dir === 'se') {
        if (next.rowSpan > 1) { next = { ...next, rowSpan: next.rowSpan - 1 }; continue; }
        if (next.colSpan > 1) { next = { ...next, colSpan: next.colSpan - 1 }; continue; }
      } else if (dir === 'w' && next.colSpan > 1) {
        next = { ...next, col: next.col + 1, colSpan: next.colSpan - 1 };
        continue;
      } else if (dir === 'n' && next.rowSpan > 1) {
        next = { ...next, row: next.row + 1, rowSpan: next.rowSpan - 1 };
        continue;
      }
      break;
    }
    return next;
  };
  const onMove = (moveEvent) => {
    const dx = moveEvent.clientX - start.x;
    const dy = moveEvent.clientY - start.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
    if (mode === 'move') {
      const col = Math.min(Math.max(0, original.col + Math.round(dx / metrics.columnUnit)), metrics.columns - original.colSpan);
      const row = Math.max(0, original.row + Math.round(dy / metrics.rowUnit));
      preview = { ...original, row, col };
    } else {
      // dir：se 拖右下角、w 拖左边界、n 拖上边界。左/上手柄拖动时 col(row) 与 span 反向变化，
      // 保持对侧边界不动，这才能"向左拉宽"。
      const dir = mode.slice('resize-'.length);
      const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
      const colDelta = Math.round(dx / metrics.columnUnit);
      const rowDelta = Math.round(dy / metrics.rowUnit);
      let { row, col, rowSpan, colSpan } = original;
      if (dir === 'w') {
        const nextCol = clamp(original.col + colDelta, 0, original.col + original.colSpan - 1);
        col = nextCol;
        colSpan = original.colSpan + (original.col - nextCol);
      } else if (dir === 'n') {
        const nextRow = clamp(original.row + rowDelta, 0, original.row + original.rowSpan - 1);
        row = nextRow;
        rowSpan = original.rowSpan + (original.row - nextRow);
      } else {
        colSpan = clamp(original.colSpan + colDelta, 1, metrics.columns - original.col);
        rowSpan = clamp(original.rowSpan + rowDelta, 1, 100);
      }
      preview = clampResize({ row, col, rowSpan, colSpan }, dir);
    }
    applySpan(el, preview);
  };
  const onUp = async () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    dragging = false;
    el.classList.remove('is-resizing');
    if (!moved) return;
    try {
      await api.submitPatch({ op: mode === 'move' ? 'move' : 'resize', componentId: id, to: preview });
      log(`${mode === 'move' ? '移动' : '调整'}「${spec.title}」`);
      await sync();
    } catch (error) {
      log(`画布变更失败：${error.message}`);
      applySpan(el, original);
    }
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

async function removeComponent(id) {
  const spec = latest?.document?.components.find((item) => item.id === id);
  if (!spec) return;
  try {
    await api.submitPatch({ op: 'remove', componentId: id });
    log(`删除「${spec.title}」，可通过撤销恢复`);
    await sync();
  } catch (error) { log(`删除失败：${error.message}`); }
}

function fillOptions(select, columns, { includeBlank = true, current = '' } = {}) {
  const options = includeBlank ? '<option value="">未配置</option>' : '';
  select.innerHTML = options + columns.map((column) => `<option value="${esc(column.name)}" ${column.name === current ? 'selected' : ''}>${esc(column.name)}（${column.type}）</option>`).join('');
}

function openConfig(id) {
  const spec = latest?.document?.components.find((item) => item.id === id);
  if (!spec) return;
  currentConfigId = id;
  const schema = latest?.schema || [];
  const dimensions = schema.filter((column) => column.type === 'date' || column.type === 'string');
  const numbers = schema.filter((column) => column.type === 'number');
  els.configTitle.value = spec.title;
  fillOptions(els.configX, dimensions, { current: spec.encoding.x || '' });
  fillOptions(els.configY, numbers, { current: spec.encoding.y || '' });
  fillOptions(els.configSeries, dimensions, { current: spec.encoding.series || '' });
  els.configAgg.value = spec.encoding.agg || 'sum';
  const hasEncoding = !['table', 'text'].includes(spec.type);
  for (const control of [els.configX, els.configY, els.configSeries, els.configAgg]) control.disabled = !hasEncoding;
  els.configTip.textContent = hasEncoding ? '维度用于分组，度量用于聚合；系列列会把图表拆成多条线或多组柱。' : '该组件不绑定数据列，仅支持修改标题。';
  els.configDialog.showModal();
}

els.configForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentConfigId) return;
  const spec = latest.document.components.find((item) => item.id === currentConfigId);
  const patches = [];
  if (els.configTitle.value.trim() !== spec.title) patches.push({ op: 'retitle', componentId: spec.id, title: els.configTitle.value.trim() });
  if (!['table', 'text'].includes(spec.type)) {
    const x = els.configX.value || null;
    const y = els.configY.value || null;
    const series = els.configSeries.value || null;
    if (x !== (spec.encoding.x || null)) patches.push({ op: 'remap', componentId: spec.id, field: 'x', value: x });
    if (y !== (spec.encoding.y || null)) patches.push({ op: 'remap', componentId: spec.id, field: 'y', value: y });
    if (series !== (spec.encoding.series || null)) patches.push({ op: 'remap', componentId: spec.id, field: 'series', value: series });
    if (els.configAgg.value !== spec.encoding.agg) patches.push({ op: 'remap', componentId: spec.id, field: 'agg', value: els.configAgg.value });
  }
  els.configDialog.close();
  if (!patches.length) { log('配置没有变化'); return; }
  try {
    for (const patch of patches) await api.submitPatch(patch);
    log(`更新「${els.configTitle.value.trim()}」的配置`);
    await sync();
  } catch (error) { log(`配置保存失败：${error.message}`); await sync(); }
});
els.configCancel.addEventListener('click', () => els.configDialog.close());

els.editToggle.addEventListener('click', () => {
  editMode = !editMode;
  els.editToggle.classList.toggle('active', editMode);
  els.editToggle.setAttribute('aria-pressed', String(editMode));
  els.editToggle.textContent = editMode ? '完成编辑' : '编辑布局';
  document.body.classList.toggle('editing', editMode);
});

els.undoButton.addEventListener('click', async () => {
  const top = latest?.document?.patches?.[0];
  if (!top) { log('没有可撤销的操作'); return; }
  try {
    await api.revertPatch(top.id);
    log(`撤销「${top.op}」操作`);
    await sync();
  } catch (error) { log(`撤销失败：${error.message}`); }
});

els.resetButton.addEventListener('click', async () => {
  if (!window.confirm('恢复默认布局会清空当前画布配置和撤销历史，继续吗？')) return;
  try {
    await api.resetDocument();
    previousKpis = new Map();
    previousCells = new Map();
    log('已恢复默认布局');
    await sync();
  } catch (error) { log(`恢复失败：${error.message}`); }
});

function defaultEncodingFor(type, schema) {
  const numbers = schema.filter((column) => column.type === 'number' && column.distinct > 1);
  const dates = schema.filter((column) => column.type === 'date');
  const dimensions = schema.filter((column) => column.type === 'string' && column.distinct > 1 && column.distinct <= 40);
  const measure = numbers[0]?.name;
  const dimension = (type === 'line' ? dates[0] : dimensions[0])?.name;
  if (type === 'kpi') return measure ? { y: measure, agg: 'sum' } : null;
  if (type === 'table' || type === 'text') return { agg: 'count' };
  return measure && dimension ? { x: dimension, y: measure, agg: 'sum' } : null;
}

els.addButton.addEventListener('click', async () => {
  const type = els.addType.value;
  const schema = latest?.schema || [];
  const encoding = defaultEncodingFor(type, schema);
  if (!encoding) { log(`当前数据缺少新增「${type}」所需的列`); return; }
  const names = { line: '折线图', bar: '柱状图', pie: '占比图', kpi: '指标卡', table: '数据表', text: '文本块' };
  try {
    await api.submitPatch({ op: 'add', spec: { type, title: `新增${names[type]}`, encoding } });
    log(`新增${names[type]}，可在编辑模式下调整位置`);
    await sync();
  } catch (error) { log(`新增失败：${error.message}`); }
});

async function authenticate() {
  const token = window.prompt('请输入大屏访问口令');
  if (token === null) throw new Error('未提供访问口令');
  await api.createSession(token);
}

async function sync() {
  if (syncing) { syncPending = true; return; }
  syncing = true;
  try {
    do {
      syncPending = false;
      try {
        const state = await api.projection();
        const serverRestarted = state.instanceId !== currentInstance;
        if (serverRestarted || state.revision >= currentRevision) {
          currentInstance = state.instanceId;
          currentRevision = state.revision;
          if (serverRestarted) {
            previousKpis = new Map();
            previousCells = new Map();
            currentDocumentRevision = null;
          }
          render(state);
        }
      } catch (error) {
        if (error.status === 401) {
          await authenticate();
          syncPending = true;
          continue;
        }
        setDot('err');
        log(`拉取数据失败：${error.message}`);
      }
    } while (syncPending);
  } finally { syncing = false; }
}

let previewRefreshTimer = null;
function queuePreviewRefresh() {
  if (!aiSuggestionMap.size) return;
  clearTimeout(previewRefreshTimer);
  previewRefreshTimer = setTimeout(() => { loadAiState({ insights: false }); }, 500);
}

function connect() {
  events?.close();
  events = new EventSource('/api/events');
  events.addEventListener('ready', () => { setDot('ok'); log('已连接实时通道'); sync(); });
  events.addEventListener('update', (event) => {
    try {
      const detail = JSON.parse(event.data);
      log(`数据 v${detail.version} · ${detail.reason} · ${detail.rowCount} 行`, true);
      pulse();
    } catch { /* 仍按版本对齐 */ }
    sync();
    queuePreviewRefresh();
  });
  events.addEventListener('status', (event) => {
    try {
      const detail = JSON.parse(event.data);
      if (detail.status === 'parsing') setDot('busy');
      if (detail.status === 'missing') log('文件不见了，保留最后一次成功快照');
    } catch { /* 由同步接口恢复 */ }
    sync();
  });
  events.addEventListener('failure', (event) => {
    try { log(`读取失败：${JSON.parse(event.data).message}`); } catch { log('读取失败'); }
    sync();
  });
  events.addEventListener('document', (event) => {
    try { log(`画布更新 r${JSON.parse(event.data).revision}`); } catch { log('画布更新'); }
    sync();
    queuePreviewRefresh();
  });
  events.addEventListener('ai-task', (event) => {
    try {
      const detail = JSON.parse(event.data);
      if (detail.status === 'running') log(`AI 任务 ${detail.kind} 运行中`);
    } catch { /* 非关键事件 */ }
  });
  events.addEventListener('ai-suggestion', (event) => {
    try {
      const detail = JSON.parse(event.data);
      log(`AI 建议：${detail.summary}`, true);
      loadAiState();
    } catch { loadAiState(); }
  });
  events.addEventListener('ai-insight', (event) => {
    try {
      const detail = JSON.parse(event.data);
      log(`AI 洞察：${detail.statement.slice(0, 60)}${detail.statement.length > 60 ? '…' : ''}`, true);
    } catch { /* 由 loadAiState 补齐 */ }
    loadAiState();
  });
  events.onerror = () => setDot('err');
}

els.sourceSelect.addEventListener('change', async () => {
  const raw = els.sourceSelect.value;
  const isSheet = raw.startsWith('sheet:');
  const sheet = isSheet ? raw.slice('sheet:'.length) : null;
  els.sourceSelect.disabled = true;
  try {
    await api.setSource(isSheet ? 'sheet' : 'merged', sheet);
    log(isSheet ? `数据源切换为工作表「${sheet}」` : '数据源切换为全部工作表合并', true);
    currentRevision = -1;
    await sync();
  } catch (error) {
    log(`切换数据源失败：${error.message}`);
    if (latest) renderSourceSelect(latest);
  } finally { els.sourceSelect.disabled = false; }
});

els.simulate.addEventListener('click', async () => {
  els.simulate.disabled = true;
  try {
    const result = await api.simulate();
    log(`模拟改 ${result.column}：${result.previous} → ${result.next}`, true);
  } catch (error) { log(`模拟失败：${error.message}`); }
  finally { setTimeout(() => { els.simulate.disabled = false; }, 600); }
});

window.addEventListener('resize', () => {
  if (resizeFrame) cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => { for (const chart of chartInstances.values()) chart.resize(); });
});
window.addEventListener('beforeunload', () => {
  events?.close();
  disposeCharts();
});

async function bootstrap() {
  const url = new URL(window.location.href);
  const token = url.searchParams.get('token');
  if (token !== null) {
    url.searchParams.delete('token');
    window.history.replaceState(null, '', url);
    try { await api.createSession(token); } catch (error) { log(`登录失败：${error.message}`); }
  }
  try {
    const meta = await api.meta();
    els.simulate.hidden = !meta.features.simulate;
  } catch (error) {
    if (error.status === 401) {
      try { await authenticate(); els.simulate.hidden = !(await api.meta()).features.simulate; }
      catch (authError) { log(authError.message); }
    } else log(`读取配置失败：${error.message}`);
  }
  await sync();
  await loadAiMode();
  await loadAiState();
  connect();
}

bootstrap().catch((error) => { setDot('err'); log(`启动失败：${error.message}`); });
