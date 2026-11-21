export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(payload.message || `HTTP ${response.status}`, response.status, payload.code);
  return payload;
}

export const api = {
  meta: () => request('/api/meta'),
  projection: () => request('/api/projection'),
  rows: (offset = 0, limit = 100) => request(`/api/rows?offset=${offset}&limit=${limit}`),
  reload: () => request('/api/reload', { method: 'POST' }),
  sheets: () => request('/api/sheets'),
  setSource: (mode, sheet = null) => request('/api/dataset/source', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sheet ? { mode, sheet } : { mode }),
  }),
  simulate: () => request('/api/simulate', { method: 'POST' }),
  createSession: (token) => request('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  }),
  submitPatch: (patch) => request('/api/document/patches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }),
  dryRunPatch: (patch) => request('/api/document/patches/dry-run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }),
  revertPatch: (id) => request(`/api/document/patches/${encodeURIComponent(id)}/revert`, { method: 'POST' }),
  resetDocument: () => request('/api/document/reset', { method: 'POST' }),
  document: () => request('/api/document'),
  aiCapabilities: () => request('/api/ai/capabilities'),
  aiChart: (instruction) => request('/api/ai/chart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instruction }),
  }),
  aiInsightScan: () => request('/api/ai/insights/scan', { method: 'POST' }),
  aiMaintenanceScan: () => request('/api/ai/maintenance/scan', { method: 'POST' }),
  aiSuggestions: () => request('/api/ai/suggestions'),
  aiInsights: () => request('/api/ai/insights'),
  aiAcceptSuggestion: (id) => request(`/api/ai/suggestions/${encodeURIComponent(id)}/accept`, { method: 'POST' }),
  aiRejectSuggestion: (id) => request(`/api/ai/suggestions/${encodeURIComponent(id)}/reject`, { method: 'POST' }),
};
