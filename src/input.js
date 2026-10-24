const { spawn } = require('child_process');
const path = require('path');

const BUTTONS = new Set(['l', 'r', 'm']);

// Nama tombol yang boleh dikirim dari HP -> virtual-key code Windows
const KEYS = {
  enter: 0x0d, backspace: 0x08, tab: 0x09, esc: 0x1b, space: 0x20,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, insert: 0x2d, delete: 0x2e,
  win: 0x5b, menu: 0x5d, printscreen: 0x2c,
  volumeup: 0xaf, volumedown: 0xae, mute: 0xad, playpause: 0xb3, next: 0xb0, prev: 0xb1,
};
for (let i = 1; i <= 12; i++) KEYS[`f${i}`] = 0x6f + i;

const MAX_TEXT = 500;

// Mengendalikan mouse & keyboard lewat proses PowerShell persisten (input-helper.ps1) yang memanggil Win32 API.
// Tanpa native module, jadi tidak perlu Visual Studio Build Tools.
class InputController {
  constructor(log = () => {}) {
    this.log = log;
    this.proc = null;
    this.ready = false;
    this.stopped = false;
    this.restartTimer = null;
    // sisa pecahan pixel/scroll agar gerakan halus tidak hilang saat dibulatkan
    this.fx = 0;
    this.fy = 0;
    this.fs = 0;
    this.fh = 0;
  }

  start() {
    this.stopped = false;
    const script = path.join(__dirname, 'input-helper.ps1');
    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.proc = proc;
    this.ready = false;

    proc.stdout.on('data', (buf) => {
      if (!this.ready && String(buf).includes('ready')) {
        this.ready = true;
        this.log('Input controller ready (mouse + keyboard).');
      }
    });
    proc.stderr.on('data', (buf) => {
      const msg = String(buf).trim();
      if (msg) this.log(`Input helper: ${msg}`);
    });
    proc.stdin.on('error', () => { /* proses sudah mati, ditangani di 'exit' */ });
    proc.on('error', (err) => this.log(`Failed to launch PowerShell: ${err.message}`));
    proc.on('exit', (code) => {
      if (this.proc === proc) {
        this.proc = null;
        this.ready = false;
      }
      if (!this.stopped) {
        this.log(`Input helper exited (code ${code}), restarting in 2 seconds...`);
        this.restartTimer = setTimeout(() => this.start(), 2000);
      }
    });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    if (this.proc) {
      try { this.proc.stdin.end('q\n'); } catch { /* abaikan */ }
      const p = this.proc;
      setTimeout(() => { if (p.exitCode === null) p.kill(); }, 1000).unref();
      this.proc = null;
    }
  }

  send(line) {
    if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(`${line}\n`);
  }

  move(dx, dy) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this.fx += clamp(dx, -2000, 2000);
    this.fy += clamp(dy, -2000, 2000);
    const ix = Math.trunc(this.fx);
    const iy = Math.trunc(this.fy);
    if (ix === 0 && iy === 0) return;
    this.fx -= ix;
    this.fy -= iy;
    this.send(`m ${ix} ${iy}`);
  }

  scroll(dy, dx = 0) {
    if (Number.isFinite(dy) && dy !== 0) {
      this.fs += clamp(dy, -1200, 1200);
      const v = Math.trunc(this.fs);
      if (v !== 0) {
        this.fs -= v;
        this.send(`s ${v}`);
      }
    }
    if (Number.isFinite(dx) && dx !== 0) {
      this.fh += clamp(dx, -1200, 1200);
      const h = Math.trunc(this.fh);
      if (h !== 0) {
        this.fh -= h;
        this.send(`h ${h}`);
      }
    }
  }

  click(button) {
    if (BUTTONS.has(button)) this.send(`c ${button}`);
  }

  down(button) {
    if (BUTTONS.has(button)) this.send(`d ${button}`);
  }

  up(button) {
    if (BUTTONS.has(button)) this.send(`u ${button}`);
  }

  /** Ketik teks Unicode apa adanya ('\n' = Enter). */
  typeText(text) {
    const s = String(text ?? '').slice(0, MAX_TEXT);
    if (s) this.send(`t ${Buffer.from(s, 'utf8').toString('base64')}`);
  }

  /** Tekan tombol bernama (lihat KEYS) dengan modifier bitmask: 1 Ctrl, 2 Alt, 4 Shift, 8 Win. */
  key(name, mods = 0) {
    const vk = KEYS[name];
    if (vk) this.send(`k ${vk} ${mods & 15}`);
  }

  /** Tekan satu karakter dengan modifier, mis. ('c', 1) = Ctrl+C. */
  keyChar(char, mods = 0) {
    const code = String(char ?? '').charCodeAt(0);
    if (!code) return;
    if ((mods & 15) === 0) this.typeText(char);
    else this.send(`kc ${mods & 15} ${code}`);
  }
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

module.exports = { InputController, BUTTONS, KEYS };
