const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Cloudflare Tunnel yang dijalankan & diawasi oleh OwnRemote.
//   quick : `cloudflared tunnel --url http://localhost:<port>` -> URL acak *.trycloudflare.com (tanpa akun)
//   token : `cloudflared tunnel run --token <token>` -> named tunnel dengan domain sendiri
//           (public hostname diarahkan ke http://localhost:<port> di dashboard Cloudflare Zero Trust)
const MODES = ['off', 'quick', 'token'];
const QUICK_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const CONNECTED_RE = /Registered tunnel connection|Connection [a-f0-9-]+ registered/i;
const RESTART_DELAYS = [2000, 5000, 15000, 30000];

function findCloudflared(customPath) {
  const candidates = [
    customPath,
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'cloudflared', 'cloudflared.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'cloudflared', 'cloudflared.exe'),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try {
    const found = execFileSync('where', ['cloudflared'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().split(/\r?\n/).find(Boolean);
    if (found) return found.trim();
  } catch { /* tidak ada di PATH */ }
  return null;
}

class TunnelManager {
  constructor({ log = () => {}, onChange = () => {} } = {}) {
    this.log = log;
    this.onChange = onChange;
    this.proc = null;
    this.mode = 'off';
    this.state = 'off'; // off | starting | connected | error
    this.url = '';
    this.error = '';
    this.restarts = 0;
    this.restartTimer = null;
    this.opts = null;
  }

  status() {
    return { mode: this.mode, state: this.state, url: this.url, error: this.error };
  }

  /** Terapkan konfigurasi; aman dipanggil berulang (hanya restart bila ada yang berubah). */
  apply({ mode, port, token, publicUrl, cloudflaredPath }) {
    const next = { mode: MODES.includes(mode) ? mode : 'off', port, token: token || '', publicUrl: publicUrl || '', cloudflaredPath };
    const same = this.opts && JSON.stringify(this.opts) === JSON.stringify(next);
    if (same && (this.proc || next.mode === 'off')) return;
    this.stop();
    this.opts = next;
    this.mode = next.mode;
    this.restarts = 0;
    if (next.mode === 'off') {
      this.set('off', '', '');
      return;
    }
    this.launch();
  }

  launch() {
    const { mode, port, token, publicUrl, cloudflaredPath } = this.opts;
    const exe = findCloudflared(cloudflaredPath);
    if (!exe) {
      this.set('error', '', 'cloudflared not found. Install it with: winget install --id Cloudflare.cloudflared');
      return;
    }
    if (mode === 'token' && !token) {
      this.set('error', publicUrl, 'Named tunnel needs a tunnel token (Cloudflare Zero Trust > Networks > Tunnels).');
      return;
    }
    const args = mode === 'quick'
      ? ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`]
      : ['tunnel', '--no-autoupdate', 'run', '--token', token];
    this.set('starting', mode === 'token' ? publicUrl : '', '');
    this.log(mode === 'quick' ? 'Starting Cloudflare quick tunnel...' : 'Starting Cloudflare named tunnel...');

    const proc = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    let tail = '';
    const onOutput = (chunk) => {
      const text = String(chunk);
      tail = (tail + text).slice(-2000);
      const m = mode === 'quick' && text.match(QUICK_URL_RE);
      if (m && this.url !== m[0]) {
        this.url = m[0];
        this.onChange(this.status());
      }
      if (CONNECTED_RE.test(text) && this.state !== 'connected') {
        this.restarts = 0;
        this.set('connected', this.url || publicUrl, '');
        this.log(`Cloudflare tunnel connected${this.url ? `: ${this.url}` : ''}.`);
      }
    };
    proc.stdout.on('data', onOutput);
    proc.stderr.on('data', onOutput);
    proc.on('error', (err) => this.set('error', '', `Failed to run cloudflared: ${err.message}`));
    proc.on('exit', (code) => {
      if (this.proc !== proc) return; // dihentikan dengan sengaja
      this.proc = null;
      const reason = (tail.match(/ERR[^\n]*/g) || []).pop() || `cloudflared exited (code ${code})`;
      const delay = RESTART_DELAYS[Math.min(this.restarts, RESTART_DELAYS.length - 1)];
      this.restarts++;
      this.set('error', '', `${reason.replace(/^.*?ERR\s*/, '').trim()} - retrying in ${delay / 1000}s`);
      this.log(`Cloudflare tunnel stopped: ${reason.trim()}`);
      this.restartTimer = setTimeout(() => this.launch(), delay);
    });
  }

  set(state, url, error) {
    this.state = state;
    this.url = url;
    this.error = error;
    this.onChange(this.status());
  }

  stop() {
    clearTimeout(this.restartTimer);
    if (this.proc) {
      const p = this.proc;
      this.proc = null;
      try { p.kill(); } catch { /* sudah mati */ }
    }
  }
}

module.exports = { TunnelManager, findCloudflared, MODES };
