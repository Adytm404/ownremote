// Client kecil untuk Admin API server (hanya localhost). Dipakai CLI untuk status & manajemen session,
// baik server berjalan di terminal ini maupun di background.
const config = require('./config');

function target() {
  const cfg = config.loadConfig();
  const rt = config.readRuntime();
  return { port: rt?.port || cfg.port, token: cfg.adminToken };
}

async function call(method, pathname, body, timeoutMs = 2000) {
  const { port, token } = target();
  const res = await fetch(`http://127.0.0.1:${port}/admin${pathname}`, {
    method,
    headers: { 'x-admin-token': token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/** Status server yang sedang berjalan, atau null jika tidak ada. */
async function getStatus() {
  try {
    return await call('GET', '/status', undefined, 800);
  } catch {
    return null;
  }
}

async function waitUntilUp(timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const st = await getStatus();
    if (st) return st;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

async function waitUntilDown(timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!(await getStatus())) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

module.exports = {
  getStatus,
  waitUntilUp,
  waitUntilDown,
  sessions: () => call('GET', '/sessions'),
  disconnect: (id) => call('POST', `/sessions/${encodeURIComponent(id)}/disconnect`, {}),
  revoke: (id) => call('POST', `/sessions/${encodeURIComponent(id)}/revoke`, {}),
  revokeAll: () => call('POST', '/sessions/revoke-all', {}),
  regenerateCode: () => call('POST', '/pair-code/regenerate', {}),
  setPairing: (allow) => call('POST', '/pairing', { allow }),
  updateSettings: (patch) => call('POST', '/settings', patch),
  shutdown: () => call('POST', '/shutdown', {}),
};
