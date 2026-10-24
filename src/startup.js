const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('./config');

const STARTUP_DIR = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const STARTUP_FILE = path.join(STARTUP_DIR, 'OwnRemote.vbs');
const LEGACY_STARTUP_FILE = path.join(STARTUP_DIR, 'RemoteCursor.vbs'); // nama sebelum rebrand
const LAUNCHER_FILE = path.join(config.DATA_DIR, 'launch-hidden.vbs');
const DAEMON = path.join(__dirname, 'daemon.js');

// Script VBS menjalankan node tanpa jendela console (window style 0 = hidden).
// fromStartup: dijalankan dari folder Startup Windows -> daemon menerapkan jeda startup
function launcherScript(fromStartup = false) {
  const q = (s) => s.replace(/"/g, '""');
  return [
    "' Dibuat otomatis oleh OwnRemote - menjalankan server di background tanpa jendela.",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = "${q(config.ROOT)}"`,
    `sh.Run """${q(process.execPath)}"" ""${q(DAEMON)}""${fromStartup ? ' --startup' : ''}", 0, False`,
    '',
  ].join('\r\n');
}

// UTF-16LE + BOM supaya path dengan karakter non-ASCII tetap terbaca oleh Windows Script Host
function writeVbs(file, fromStartup = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `\ufeff${launcherScript(fromStartup)}`, 'utf16le');
}

function isStartupEnabled() {
  return fs.existsSync(STARTUP_FILE);
}

function enableStartup() {
  writeVbs(STARTUP_FILE, true);
}

function disableStartup() {
  for (const f of [STARTUP_FILE, LEGACY_STARTUP_FILE]) {
    try { fs.unlinkSync(f); } catch { /* sudah tidak ada */ }
  }
}

// Perbarui path node/proyek di file startup jika folder proyek dipindah atau versi node berganti.
function refreshStartup() {
  if (fs.existsSync(LEGACY_STARTUP_FILE)) {
    fs.unlinkSync(LEGACY_STARTUP_FILE);
    enableStartup();
    return;
  }
  if (!isStartupEnabled()) return;
  const current = fs.readFileSync(STARTUP_FILE, 'utf16le').replace(/^\ufeff/, '');
  if (current !== launcherScript(true)) enableStartup();
}

function launchBackground() {
  writeVbs(LAUNCHER_FILE);
  const child = spawn('wscript.exe', [LAUNCHER_FILE], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

module.exports = {
  STARTUP_FILE,
  isStartupEnabled,
  enableStartup,
  disableStartup,
  refreshStartup,
  launchBackground,
};
