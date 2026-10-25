const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

// Lokasi data (config, perangkat, log):
//   1. OWNREMOTE_DATA_DIR, bila diset (instance kedua, demo, pengujian)
//   2. folder data/ di samping aplikasi, bila sudah ada (clone git lama tetap memakai datanya)
//   3. %APPDATA%\OwnRemote: install lewat npm berada di node_modules yang terhapus saat update
function resolveDataDir() {
  if (process.env.OWNREMOTE_DATA_DIR) return path.resolve(process.env.OWNREMOTE_DATA_DIR);
  const legacy = path.join(ROOT, 'data');
  if (fs.existsSync(path.join(legacy, 'config.json'))) return legacy;
  const appData = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'OwnRemote');
}

const DATA_DIR = resolveDataDir();
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
const RUNTIME_FILE = path.join(DATA_DIR, 'runtime.json');
const LOG_FILE = path.join(DATA_DIR, 'server.log');

const DEFAULTS = {
  port: 8787,
  allowPairing: true,
  startupDelay: 0, // detik menunggu sebelum server jalan saat Windows login
  trayIcon: true, // ikon system tray di mode background
  notifyOnConnect: true, // notifikasi tray saat HP terhubung
  autoLockPairing: false, // kunci pairing otomatis setelah satu HP berhasil pairing
  allowScreen: true, // HP boleh melihat preview layar (tetap harus dinyalakan manual dari HP)
  tunnelMode: 'off', // Cloudflare Tunnel: off | quick (*.trycloudflare.com) | token (named tunnel)
  tunnelToken: '', // token named tunnel dari Cloudflare Zero Trust (rahasia, tidak pernah dikirim ke HP/CLI status)
  publicUrl: '', // URL publik named tunnel, mis. https://remote.domainanda.com
  cloudflaredPath: '', // kosong = deteksi otomatis
};

// Pengaturan yang boleh diubah lewat Admin API saat server berjalan
const RUNTIME_SETTINGS = [
  'startupDelay', 'trayIcon', 'notifyOnConnect', 'autoLockPairing', 'allowScreen',
  'tunnelMode', 'tunnelToken', 'publicUrl', 'cloudflaredPath',
];

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDataDir();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function newPairCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function loadConfig() {
  const cfg = { ...DEFAULTS, ...readJson(CONFIG_FILE, {}) };
  let changed = false;
  if (!/^\d{6}$/.test(cfg.pairCode || '')) {
    cfg.pairCode = newPairCode();
    changed = true;
  }
  if (!cfg.adminToken) {
    cfg.adminToken = crypto.randomBytes(24).toString('hex');
    changed = true;
  }
  if (changed) writeJson(CONFIG_FILE, cfg);
  return cfg;
}

function saveConfig(cfg) {
  writeJson(CONFIG_FILE, cfg);
}

function loadDevices() {
  const list = readJson(DEVICES_FILE, []);
  return Array.isArray(list) ? list : [];
}

function saveDevices(devices) {
  writeJson(DEVICES_FILE, devices);
}

function readRuntime() {
  return readJson(RUNTIME_FILE, null);
}

function writeRuntime(info) {
  writeJson(RUNTIME_FILE, info);
}

function clearRuntime(pid = process.pid) {
  const rt = readRuntime();
  if (rt && rt.pid === pid) {
    try { fs.unlinkSync(RUNTIME_FILE); } catch { /* sudah tidak ada */ }
  }
}

module.exports = {
  ROOT,
  DATA_DIR,
  LOG_FILE,
  RUNTIME_SETTINGS,
  ensureDataDir,
  newPairCode,
  loadConfig,
  saveConfig,
  loadDevices,
  saveDevices,
  readRuntime,
  writeRuntime,
  clearRuntime,
};
