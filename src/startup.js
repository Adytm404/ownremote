const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

// Start with Windows lewat entri registry standar milik user (tanpa hak admin):
//   HKCU\Software\Microsoft\Windows\CurrentVersion\Run  ->  OwnRemote
// Nilainya menjalankan launcher statis src/launch-hidden.vbs (ikut di paket) supaya tidak muncul jendela console.
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const VALUE_NAME = 'OwnRemote';
const STARTUP_LOCATION = `${RUN_KEY}\\${VALUE_NAME}`;
const LAUNCHER = path.join(__dirname, 'launch-hidden.vbs');
const DAEMON = path.join(__dirname, 'daemon.js');
const WSCRIPT = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');

// Versi lama menaruh launcher .vbs di folder Startup; dibersihkan & dipindahkan ke registry.
const STARTUP_DIR = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const LEGACY_FILES = ['OwnRemote.vbs', 'RemoteCursor.vbs'].map((f) => path.join(STARTUP_DIR, f));

const quote = (s) => `"${s}"`;

function runCommand() {
  return [WSCRIPT, LAUNCHER, process.execPath, DAEMON].map(quote).join(' ') + ' --startup';
}

function readRunValue() {
  try {
    const out = execFileSync('reg', ['query', RUN_KEY, '/v', VALUE_NAME], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const m = out.match(new RegExp(`${VALUE_NAME}\\s+REG_\\w+\\s+(.*)`));
    return m ? m[1].trim() : null;
  } catch {
    return null; // nilai belum ada
  }
}

function isStartupEnabled() {
  return readRunValue() !== null;
}

function enableStartup() {
  execFileSync('reg', ['add', RUN_KEY, '/v', VALUE_NAME, '/t', 'REG_SZ', '/d', runCommand(), '/f'], { windowsHide: true, stdio: 'ignore' });
}

function disableStartup() {
  try {
    execFileSync('reg', ['delete', RUN_KEY, '/v', VALUE_NAME, '/f'], { windowsHide: true, stdio: 'ignore' });
  } catch { /* sudah tidak ada */ }
}

// Dipanggil setiap CLI dibuka: migrasi dari versi lama, dan perbarui path bila node/aplikasi pindah lokasi.
function refreshStartup() {
  let hadLegacy = false;
  for (const f of LEGACY_FILES) {
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); hadLegacy = true; } catch { /* abaikan */ }
    }
  }
  const current = readRunValue();
  if (hadLegacy || (current !== null && current !== runCommand())) enableStartup();
}

// Jalankan server di background: proses node terpisah tanpa console (DETACHED_PROCESS).
function launchBackground() {
  const child = spawn(process.execPath, [DAEMON], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

module.exports = {
  STARTUP_LOCATION,
  isStartupEnabled,
  enableStartup,
  disableStartup,
  refreshStartup,
  launchBackground,
};
