const { spawn } = require('child_process');
const path = require('path');
const config = require('./config');

// Ikon system tray (mode background) lewat proses PowerShell + WinForms NotifyIcon (tray-helper.ps1).
class TrayIcon {
  constructor({ log = () => {}, onCommand = () => {} } = {}) {
    this.log = log;
    this.onCommand = onCommand;
    this.proc = null;
    this.lastState = null;
  }

  start() {
    if (this.proc) return;
    const script = path.join(__dirname, 'tray-helper.ps1');
    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', script],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.proc = proc;

    let buf = '';
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line === 'ready') {
          if (this.lastState) this.send(this.lastState);
        } else if (line.startsWith('cmd ')) {
          this.onCommand(line.slice(4));
        }
      }
    });
    proc.stderr.on('data', (d) => {
      const msg = String(d).trim();
      if (msg) this.log(`Tray icon: ${msg}`);
    });
    proc.stdin.on('error', () => { /* proses sudah mati */ });
    proc.on('error', (err) => this.log(`Tray icon failed to start: ${err.message}`));
    proc.on('exit', () => {
      if (this.proc === proc) this.proc = null;
    });
  }

  stop() {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;
    try { p.stdin.end('quit\n'); } catch { /* abaikan */ }
    setTimeout(() => { if (p.exitCode === null) p.kill(); }, 1500).unref();
  }

  send(line) {
    if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(`${line}\n`);
  }

  update({ url, pairCode, online, paired, allowPairing, publicUrl }) {
    const clean = (s) => String(s).replace(/[\t\r\n]/g, ' ');
    this.lastState = `state ${clean(url || '')}\t${pairCode}\t${online}\t${paired}\t${allowPairing ? 1 : 0}\t${clean(publicUrl || '')}`;
    this.send(this.lastState);
  }

  notify(title, text = '') {
    const clean = (s) => String(s).replace(/[\t\r\n]/g, ' ');
    this.send(`notify ${clean(title)}\t${clean(text)}`);
  }
}

// Buka menu CLI di jendela console baru (dipanggil dari menu tray).
function openCliWindow() {
  const cli = path.join(config.ROOT, 'cli.js');
  const args = `/c start "OwnRemote" "${process.execPath}" "${cli}"`;
  spawn('cmd.exe', [args], {
    cwd: config.ROOT,
    detached: true,
    stdio: 'ignore',
    windowsVerbatimArguments: true,
  }).unref();
}

module.exports = { TrayIcon, openCliWindow };
