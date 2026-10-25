const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');

// Preset kualitas preview layar. "normal" = rekomendasi: gambar 5 fps, sementara posisi cursor
// dikirim terpisah ~30x/detik supaya virtual cursor di HP tetap terasa mulus.
const PRESETS = {
  saver: { fps: 2, width: 640, quality: 40 },
  normal: { fps: 5, width: 960, quality: 50 },
  sharp: { fps: 8, width: 1280, quality: 60 },
};
const LIMITS = { fps: [1, 15], width: [320, 2560], quality: [10, 95] };

const clampInt = (v, [min, max], fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Ambil parameter stream dari pesan HP: nilai kustom (fps/width/quality) atau nama preset. */
function resolveParams(opts = {}) {
  const base = PRESETS[opts.preset] || PRESETS.normal;
  return {
    fps: clampInt(opts.fps, LIMITS.fps, base.fps),
    width: clampInt(opts.width, LIMITS.width, base.width),
    quality: clampInt(opts.quality, LIMITS.quality, base.quality),
  };
}

const ACK_TIMEOUT_MS = 4000; // HP tidak membalas -> anggap siap lagi
const ERROR_RETRY_MS = 2000; // layar terkunci dll -> coba lagi
const IDLE_STOP_MS = 30_000; // matikan helper setelah tidak ada penonton

/**
 * Mengalirkan tangkapan layar ke HP yang meminta (opt-in).
 * Hemat data: frame berikutnya baru dikirim setelah HP selesai menampilkan frame sebelumnya (ack),
 * dan frame yang identik dengan sebelumnya tidak dikirim ulang.
 */
class ScreenStreamer {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.viewers = new Map(); // ws -> { preset, waiting, waitingSince, lastHash, name }
    this.proc = null;
    this.ready = false;
    this.busy = false;
    this.timer = null;
    this.idleTimer = null;
    this.lastFrameAt = 0;
    this.bounds = null; // monitor yang terakhir ditangkap
    this.buf = Buffer.alloc(0);
  }

  get viewerCount() {
    return this.viewers.size;
  }

  isViewing(ws) {
    return this.viewers.has(ws);
  }

  subscribe(ws, opts, name) {
    const params = resolveParams(opts);
    const desc = `${params.fps} fps, ${params.width}px, quality ${params.quality}`;
    const existing = this.viewers.get(ws);
    if (existing) {
      if (JSON.stringify(existing.params) !== JSON.stringify(params)) this.log(`Screen preview of ${name} changed to ${desc}.`);
      existing.params = params;
      existing.lastHash = null; // kualitas/resolusi berubah: kirim frame baru walaupun layar diam
    } else {
      this.viewers.set(ws, { params, waiting: false, waitingSince: 0, lastHash: null, name });
      this.log(`Screen preview started by ${name} (${desc}).`);
    }
    clearTimeout(this.idleTimer);
    this.ensureProcess();
    this.send('c 1');
    this.sendMonitorTo(ws);
    this.sendCursorTo(ws);
    this.pump();
  }

  unsubscribe(ws) {
    const v = this.viewers.get(ws);
    if (!v) return;
    this.viewers.delete(ws);
    this.log(`Screen preview stopped by ${v.name}.`);
    if (this.viewers.size === 0) {
      this.send('c 0');
      clearTimeout(this.timer);
      this.timer = null;
      this.idleTimer = setTimeout(() => this.stopProcess(), IDLE_STOP_MS);
      this.idleTimer.unref?.();
    }
  }

  unsubscribeAll(reason) {
    for (const ws of [...this.viewers.keys()]) {
      safeSend(ws, JSON.stringify({ t: 'screen-off', reason }));
      this.unsubscribe(ws);
    }
  }

  ack(ws) {
    const v = this.viewers.get(ws);
    if (!v) return;
    v.waiting = false;
    this.pump();
  }

  stop() {
    this.viewers.clear();
    clearTimeout(this.timer);
    clearTimeout(this.idleTimer);
    this.stopProcess();
  }

  // ---------------------------------------------------------------- proses helper
  ensureProcess() {
    if (this.proc) return;
    const script = path.join(__dirname, 'screen-helper.ps1');
    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.proc = proc;
    this.ready = false;
    this.busy = false;
    this.buf = Buffer.alloc(0);
    proc.stdout.on('data', (chunk) => this.onData(chunk));
    proc.stderr.on('data', (d) => {
      const msg = String(d).trim();
      if (msg) this.log(`Screen helper: ${msg}`);
    });
    proc.stdin.on('error', () => { /* proses sudah mati */ });
    proc.on('error', (err) => this.log(`Screen helper failed to start: ${err.message}`));
    proc.on('exit', () => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.ready = false;
      this.busy = false;
      if (this.viewers.size > 0) {
        this.log('Screen helper exited, restarting...');
        setTimeout(() => { if (this.viewers.size > 0) { this.ensureProcess(); this.send('c 1'); } }, 1000);
      }
    });
  }

  stopProcess() {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;
    this.ready = false;
    try { p.stdin.end('q\n'); } catch { /* abaikan */ }
    setTimeout(() => { if (p.exitCode === null) p.kill(); }, 1500).unref?.();
  }

  send(line) {
    if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(`${line}\n`);
  }

  onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 5) {
      const type = String.fromCharCode(this.buf[0]);
      const len = this.buf.readInt32LE(1);
      if (this.buf.length < 5 + len) break;
      const payload = this.buf.subarray(5, 5 + len);
      this.buf = this.buf.subarray(5 + len);
      if (type === 'R') {
        this.ready = true;
        if (this.viewers.size) this.send('c 1');
        this.pump();
      } else if (type === 'F') {
        this.onFrame(Buffer.from(payload));
      } else if (type === 'C') {
        this.onCursor(payload.readInt32LE(0), payload.readInt32LE(4));
      } else if (type === 'E') {
        this.onError(payload.toString('utf8'));
      }
    }
  }

  // ---------------------------------------------------------------- frame
  // Beberapa HP menonton sekaligus: pakai nilai tertinggi yang diminta
  currentParams() {
    const p = { fps: 1, width: 320, quality: 10 };
    for (const v of this.viewers.values()) {
      p.fps = Math.max(p.fps, v.params.fps);
      p.width = Math.max(p.width, v.params.width);
      p.quality = Math.max(p.quality, v.params.quality);
    }
    return p;
  }

  pump() {
    if (!this.ready || this.busy || this.viewers.size === 0) return;
    const preset = this.currentParams();
    const wait = this.lastFrameAt + 1000 / preset.fps - Date.now();
    if (wait > 0) {
      if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.pump(); }, wait);
      return;
    }
    const now = Date.now();
    const anyReady = [...this.viewers.values()].some((v) => !v.waiting || now - v.waitingSince > ACK_TIMEOUT_MS);
    if (!anyReady) return; // dipanggil lagi saat ack datang
    this.busy = true;
    this.lastFrameAt = now;
    this.send(`f ${preset.width} ${preset.quality}`);
  }

  onFrame(buf) {
    this.busy = false;
    const [left, top, width, height] = [0, 4, 8, 12].map((o) => buf.readInt32LE(o));
    const monitorChanged = !this.bounds || this.bounds.left !== left || this.bounds.top !== top;
    this.bounds = { left, top, width, height };
    const jpeg = buf.subarray(24);
    const hash = crypto.createHash('sha1').update(jpeg).digest('base64');
    const now = Date.now();
    for (const [ws, v] of this.viewers) {
      if (v.waiting && now - v.waitingSince <= ACK_TIMEOUT_MS) continue;
      if (v.lastHash === hash) continue; // layar tidak berubah: hemat data
      if (ws.bufferedAmount > 1024 * 1024) continue; // jaringan HP sedang lambat
      v.waiting = true;
      v.waitingSince = now;
      v.lastHash = hash;
      ws.send(jpeg, { binary: true });
    }
    if (monitorChanged) {
      for (const ws of this.viewers.keys()) {
        this.sendMonitorTo(ws);
        this.sendCursorTo(ws);
      }
    }
    this.pump();
  }

  onError(message) {
    this.busy = false;
    this.lastFrameAt = Date.now() + ERROR_RETRY_MS;
    const msg = /handle|invalid|operation/i.test(message)
      ? "Can't capture the PC screen (the PC is locked or a UAC prompt is open)."
      : `Screen capture failed: ${message}`;
    for (const ws of this.viewers.keys()) safeSend(ws, JSON.stringify({ t: 'screen-err', msg }));
    this.pump();
  }

  // ---------------------------------------------------------------- cursor
  normalized(x, y) {
    const b = this.bounds;
    if (!b) return null;
    return { x: (x - b.left) / b.width, y: (y - b.top) / b.height };
  }

  onCursor(x, y) {
    this.lastCursor = { x, y };
    const n = this.normalized(x, y);
    if (!n) return;
    const msg = JSON.stringify({ t: 'cur', x: round4(n.x), y: round4(n.y) });
    for (const ws of this.viewers.keys()) {
      if (ws.bufferedAmount < 256 * 1024) safeSend(ws, msg);
    }
  }

  // Ukuran monitor dalam piksel fisik: dipakai HP untuk memprediksi posisi cursor tanpa menunggu jaringan
  sendMonitorTo(ws) {
    if (this.bounds) safeSend(ws, JSON.stringify({ t: 'mon', w: this.bounds.width, h: this.bounds.height }));
  }

  sendCursorTo(ws) {
    if (!this.lastCursor) return;
    const n = this.normalized(this.lastCursor.x, this.lastCursor.y);
    if (n) safeSend(ws, JSON.stringify({ t: 'cur', x: round4(n.x), y: round4(n.y) }));
  }
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function safeSend(ws, data) {
  try {
    if (ws.readyState === 1) ws.send(data);
  } catch { /* koneksi sedang ditutup */ }
}

module.exports = { ScreenStreamer, PRESETS, LIMITS, resolveParams };
