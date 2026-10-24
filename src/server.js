const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const config = require('./config');
const { InputController, BUTTONS } = require('./input');
const { TrayIcon, openCliWindow } = require('./tray');
const { ScreenStreamer } = require('./screen');
const { TunnelManager } = require('./tunnel');

// Kode close WebSocket yang dipahami halaman HP (public/app.js)
const CLOSE_REVOKED = 4001;
const CLOSE_REPLACED = 4002;
const CLOSE_KICKED = 4003;

const MAX_FAILED_ATTEMPTS = 5; // per IP
const LOCKOUT_MS = 60_000;
// Batas global (semua IP digabung): menahan brute force dari banyak IP saat server terbuka lewat tunnel
const GLOBAL_FAIL_LIMIT = 20;
const GLOBAL_FAIL_WINDOW_MS = 10 * 60_000;
const GLOBAL_LOCKOUT_MS = 10 * 60_000;

// Header yang ditambahkan Cloudflare / reverse proxy. Request yang membawanya datang dari internet,
// walaupun koneksi TCP-nya dari 127.0.0.1 (cloudflared berjalan di PC ini).
const PROXY_HEADERS = ['cf-connecting-ip', 'cf-ray', 'cdn-loop', 'x-forwarded-for', 'forwarded'];
const viaProxy = (req) => PROXY_HEADERS.some((h) => req.headers[h] !== undefined);

function getLanAddresses() {
  const virtual = /vethernet|virtualbox|vmware|hyper-v|wsl|docker|loopback|tailscale|zerotier|vpn/i;
  const list = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (!v4 || a.internal || a.address.startsWith('169.254.')) continue;
      list.push({ name, address: a.address, virtual: virtual.test(name) });
    }
  }
  // Adapter fisik (Wi-Fi/Ethernet) diutamakan
  return list.sort((a, b) => a.virtual - b.virtual);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function normalizeIp(ip = '') {
  return ip.replace(/^::ffff:/, '');
}

function isLoopback(ip) {
  const n = normalizeIp(ip);
  return n === '127.0.0.1' || n === '::1';
}

// IP asli klien. Header proxy hanya dipercaya bila koneksi datang dari localhost (yaitu dari cloudflared).
function clientIp(req) {
  const socketIp = normalizeIp(req.socket.remoteAddress);
  if (isLoopback(socketIp)) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf).trim().slice(0, 64);
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim().slice(0, 64);
  }
  return socketIp;
}

function guessDeviceName(ua = '') {
  let osName = 'Device';
  if (/iPhone/i.test(ua)) osName = 'iPhone';
  else if (/iPad/i.test(ua)) osName = 'iPad';
  else if (/Android/i.test(ua)) osName = 'Android';
  else if (/Windows/i.test(ua)) osName = 'Windows';
  else if (/Mac OS/i.test(ua)) osName = 'Mac';
  let browser = '';
  if (/SamsungBrowser/i.test(ua)) browser = 'Samsung Internet';
  else if (/EdgA?|Edg\//i.test(ua)) browser = 'Edge';
  else if (/Firefox|FxiOS/i.test(ua)) browser = 'Firefox';
  else if (/Chrome|CriOS/i.test(ua)) browser = 'Chrome';
  else if (/Safari/i.test(ua)) browser = 'Safari';
  return browser ? `${osName} · ${browser}` : osName;
}

// Pengaturan untuk ditampilkan di CLI. Token tunnel tidak pernah dikirim balik, hanya penandanya.
function settingsOf(cfg) {
  const out = Object.fromEntries(config.RUNTIME_SETTINGS.filter((k) => k !== 'tunnelToken').map((k) => [k, cfg[k]]));
  out.tunnelTokenSet = Boolean(cfg.tunnelToken);
  return out;
}

// Validasi tiap pengaturan yang dikirim CLI
function sanitizeSetting(key, value) {
  switch (key) {
    case 'startupDelay': return Math.max(0, Math.min(600, Math.round(Number(value) || 0)));
    case 'tunnelMode': return ['off', 'quick', 'token'].includes(value) ? value : 'off';
    case 'tunnelToken': return String(value || '').trim().slice(0, 4096);
    case 'cloudflaredPath': return String(value || '').trim().slice(0, 500);
    case 'publicUrl': {
      const v = String(value || '').trim().replace(/\/+$/, '');
      return /^https?:\/\/[^\s/]+$/i.test(v) ? v : '';
    }
    default: return Boolean(value);
  }
}

function cleanName(name) {
  return String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40);
}

/**
 * @param {object} opts
 * @param {'foreground'|'background'} opts.mode
 * @param {(msg: string) => void} opts.log
 * @param {() => void} [opts.onShutdown] dipanggil setelah server berhenti karena perintah /admin/shutdown
 */
function createServer({ mode = 'foreground', log = () => {}, onShutdown = () => {} } = {}) {
  const cfg = config.loadConfig();
  let devices = config.loadDevices();
  const sockets = new Map(); // deviceId -> ws
  const failed = new Map(); // ip -> { count, until }
  let globalFails = []; // waktu kode salah dari semua IP
  let globalLockUntil = 0;
  const input = new InputController(log);
  const screen = new ScreenStreamer({ log });
  const startedAt = new Date().toISOString();
  let devicesDirty = false;
  let stopping = null;

  const persistDevices = () => {
    config.saveDevices(devices);
    devicesDirty = false;
  };

  const findDevice = (token) => {
    if (!token) return null;
    const h = hashToken(token);
    return devices.find((d) => safeEqual(d.tokenHash, h)) || null;
  };

  const publicDevice = (d) => ({
    id: d.id,
    name: d.name,
    ip: d.ip,
    userAgent: d.userAgent,
    pairedAt: d.pairedAt,
    lastSeen: d.lastSeen,
    online: sockets.has(d.id),
    connectedAt: sockets.get(d.id)?.connectedAt || null,
    viewingScreen: sockets.has(d.id) && screen.isViewing(sockets.get(d.id)),
  });

  const disconnect = (id, code, reason) => {
    const ws = sockets.get(id);
    if (!ws) return false;
    ws.close(code, reason);
    return true;
  };

  function regenerateCode() {
    cfg.pairCode = config.newPairCode();
    globalFails = []; // kode baru: percobaan brute force sebelumnya tidak berguna lagi
    globalLockUntil = 0;
    config.saveConfig(cfg);
    failed.clear();
    log('New pairing code generated.');
    pushTray();
  }

  function setPairing(allow) {
    cfg.allowPairing = allow;
    config.saveConfig(cfg);
    log(allow ? 'Pairing for new devices UNLOCKED.' : 'Pairing for new devices LOCKED.');
    pushTray();
  }

  // ---------- ikon system tray (hanya mode background) ----------
  const tray = new TrayIcon({
    log,
    onCommand: (cmd) => {
      if (cmd === 'open') openCliWindow();
      else if (cmd === 'newcode') regenerateCode();
      else if (cmd === 'togglepair') setPairing(!cfg.allowPairing);
      else if (cmd === 'stop') {
        log('Stop command received from the tray icon.');
        stop().then(onShutdown);
      }
    },
  });

  const trayWanted = () => mode === 'background' && cfg.trayIcon && !stopping;

  // ---------- Cloudflare Tunnel (opsional) ----------
  const tunnel = new TunnelManager({ log, onChange: () => pushTray() });

  function syncTunnel() {
    if (stopping) return;
    tunnel.apply({
      mode: cfg.tunnelMode,
      port: cfg.port,
      token: cfg.tunnelToken,
      publicUrl: cfg.publicUrl,
      cloudflaredPath: cfg.cloudflaredPath,
    });
  }

  function pushTray() {
    if (!tray.proc) return;
    const addr = getLanAddresses()[0];
    tray.update({
      publicUrl: tunnel.status().url,
      url: addr ? `http://${addr.address}:${cfg.port}` : '',
      pairCode: cfg.pairCode,
      online: sockets.size,
      paired: devices.length,
      allowPairing: cfg.allowPairing,
    });
  }

  function syncTray() {
    if (trayWanted()) {
      tray.start();
      pushTray();
    } else {
      tray.stop();
    }
  }

  // ---------- HTTP ----------
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '8kb' }));
  app.use(express.static(path.join(config.ROOT, 'public'), { index: 'index.html' }));

  app.post('/api/pair', (req, res) => {
    const ip = clientIp(req);
    const now = Date.now();
    if (globalLockUntil > now) {
      const wait = Math.ceil((globalLockUntil - now) / 60_000);
      return res.status(429).json({ error: `Pairing dikunci sementara karena terlalu banyak kode salah. Coba lagi dalam ${wait} menit.` });
    }
    const f = failed.get(ip);
    if (f && f.until > now) {
      const wait = Math.ceil((f.until - now) / 1000);
      return res.status(429).json({ error: `Terlalu banyak percobaan. Coba lagi dalam ${wait} detik.` });
    }
    if (!cfg.allowPairing) {
      return res.status(403).json({ error: 'Pairing perangkat baru sedang dikunci di PC.' });
    }
    const code = String(req.body?.code ?? '').replace(/\D/g, '');
    if (!safeEqual(code, cfg.pairCode)) {
      const count = (f?.count || 0) + 1;
      failed.set(ip, count >= MAX_FAILED_ATTEMPTS ? { count: 0, until: now + LOCKOUT_MS } : { count, until: 0 });
      log(`Wrong code from ${ip}${viaProxy(req) ? ' (via tunnel)' : ''} (${count}/${MAX_FAILED_ATTEMPTS})`);
      globalFails = globalFails.filter((t) => now - t < GLOBAL_FAIL_WINDOW_MS);
      globalFails.push(now);
      if (globalFails.length >= GLOBAL_FAIL_LIMIT) {
        globalFails = [];
        globalLockUntil = now + GLOBAL_LOCKOUT_MS;
        log(`Too many wrong codes from several addresses: pairing blocked for ${GLOBAL_LOCKOUT_MS / 60_000} minutes.`);
        tray.notify('Pairing blocked', 'Too many wrong pairing codes. Consider generating a new code.');
      }
      return res.status(401).json({ error: 'Kode salah.' });
    }
    failed.delete(ip);

    const ua = String(req.get('user-agent') || '').slice(0, 300);
    const token = crypto.randomBytes(32).toString('hex');
    const device = {
      id: crypto.randomBytes(4).toString('hex'),
      name: cleanName(req.body?.name) || guessDeviceName(ua),
      tokenHash: hashToken(token),
      ip,
      userAgent: ua,
      pairedAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };
    devices.push(device);
    persistDevices();
    log(`New device paired: ${device.name} (${ip})`);
    if (cfg.autoLockPairing && cfg.allowPairing) setPairing(false);
    pushTray();
    res.json({ token, id: device.id, name: device.name, pc: os.hostname() });
  });

  const bearer = (req) => String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');

  app.get('/api/check', (req, res) => {
    const device = findDevice(bearer(req));
    if (!device) return res.status(401).json({ error: 'Token tidak valid.' });
    res.json({ id: device.id, name: device.name, pc: os.hostname() });
  });

  // HP memilih "Lupakan PC ini": hapus perangkat dari daftar
  app.post('/api/unpair', (req, res) => {
    const device = findDevice(bearer(req));
    if (!device) return res.status(401).json({ error: 'Token tidak valid.' });
    devices = devices.filter((d) => d.id !== device.id);
    persistDevices();
    disconnect(device.id, CLOSE_REVOKED, 'Perangkat dilupakan');
    log(`${device.name} unpaired itself from the phone.`);
    pushTray();
    res.json({ ok: true });
  });

  // ---------- Admin API (hanya dari localhost + admin token, dipakai oleh CLI) ----------
  const admin = express.Router();
  admin.use((req, res, next) => {
    // Hanya CLI di PC ini: koneksi localhost, TIDAK lewat tunnel/proxy, dan membawa admin token
    if (!isLoopback(req.socket.remoteAddress) || viaProxy(req) || !safeEqual(req.get('x-admin-token') || '', cfg.adminToken)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  });

  admin.get('/status', (req, res) => {
    res.json({
      pid: process.pid,
      mode,
      port: cfg.port,
      startedAt,
      pairCode: cfg.pairCode,
      allowPairing: cfg.allowPairing,
      mouseReady: input.ready,
      addresses: getLanAddresses(),
      hostname: os.hostname(),
      devices: devices.length,
      online: sockets.size,
      trayActive: Boolean(tray.proc),
      tunnel: tunnel.status(),
      settings: settingsOf(cfg),
    });
  });

  admin.get('/sessions', (req, res) => {
    res.json(devices.map(publicDevice));
  });

  admin.post('/sessions/:id/disconnect', (req, res) => {
    const d = devices.find((x) => x.id === req.params.id);
    if (!d) return res.status(404).json({ error: 'Device not found.' });
    const ok = disconnect(d.id, CLOSE_KICKED, 'Diputuskan dari PC');
    if (ok) log(`${d.name} disconnected from the CLI.`);
    res.json({ ok });
  });

  admin.post('/sessions/:id/revoke', (req, res) => {
    const d = devices.find((x) => x.id === req.params.id);
    if (!d) return res.status(404).json({ error: 'Device not found.' });
    devices = devices.filter((x) => x.id !== d.id);
    persistDevices();
    disconnect(d.id, CLOSE_REVOKED, 'Akses dicabut');
    log(`Access revoked for ${d.name}.`);
    pushTray();
    res.json({ ok: true });
  });

  admin.post('/sessions/revoke-all', (req, res) => {
    const count = devices.length;
    for (const d of devices) disconnect(d.id, CLOSE_REVOKED, 'Akses dicabut');
    devices = [];
    persistDevices();
    log(`Access revoked for all devices (${count}).`);
    pushTray();
    res.json({ ok: true, count });
  });

  admin.post('/pair-code/regenerate', (req, res) => {
    regenerateCode();
    res.json({ pairCode: cfg.pairCode });
  });

  admin.post('/pairing', (req, res) => {
    setPairing(Boolean(req.body?.allow));
    res.json({ allowPairing: cfg.allowPairing });
  });

  admin.post('/settings', (req, res) => {
    const patch = req.body || {};
    for (const key of config.RUNTIME_SETTINGS) {
      if (!(key in patch)) continue;
      cfg[key] = sanitizeSetting(key, patch[key]);
    }
    config.saveConfig(cfg);
    syncTray();
    syncTunnel();
    if (!cfg.allowScreen) screen.unsubscribeAll('disabled');
    log('Settings updated.');
    res.json(settingsOf(cfg));
  });

  admin.post('/shutdown', (req, res) => {
    res.json({ ok: true });
    log('Stop command received from the CLI.');
    setImmediate(() => stop().then(onShutdown));
  });

  app.use('/admin', admin);

  // ---------- WebSocket (trackpad) ----------
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return socket.destroy();
    }
    if (url.pathname !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const device = findDevice(url.searchParams.get('token'));
      if (!device) return ws.close(CLOSE_REVOKED, 'Token tidak valid');
      onConnection(ws, device, req);
    });
  });

  function onConnection(ws, device, req) {
    const old = sockets.get(device.id);
    if (old) old.close(CLOSE_REPLACED, 'Terhubung dari tab/perangkat lain');

    const ip = clientIp(req);
    ws.connectedAt = new Date().toISOString();
    ws.isAlive = true;
    const pressed = new Set();
    sockets.set(device.id, ws);
    device.ip = ip;
    device.lastSeen = ws.connectedAt;
    persistDevices();
    log(`Connected: ${device.name} (${ip})`);
    pushTray();
    if (cfg.notifyOnConnect) tray.notify('Device connected', `${device.name} (${ip})`);

    ws.send(JSON.stringify({ t: 'hello', name: device.name, pc: os.hostname() }));

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      device.lastSeen = new Date().toISOString();
      devicesDirty = true;
      switch (msg.t) {
        case 'm': input.move(Number(msg.x), Number(msg.y)); break;
        case 's': input.scroll(Number(msg.y) || 0, Number(msg.x) || 0); break;
        case 'c': input.click(msg.b); break;
        case 'd':
          if (BUTTONS.has(msg.b) && !pressed.has(msg.b)) { pressed.add(msg.b); input.down(msg.b); }
          break;
        case 'u':
          if (pressed.delete(msg.b)) input.up(msg.b);
          break;
        // keyboard
        case 'type': if (typeof msg.s === 'string') input.typeText(msg.s); break;
        case 'key': input.key(String(msg.k), Number(msg.m) || 0); break;
        case 'kc': if (typeof msg.c === 'string') input.keyChar(msg.c, Number(msg.m) || 0); break;
        case 'bs': {
          // hapus n karakter (backspace beruntun dari diff teks di HP)
          const n = Math.min(500, Math.max(0, Math.floor(Number(msg.n) || 0)));
          for (let i = 0; i < n; i++) input.key('backspace');
          break;
        }
        // preview layar (opt-in dari HP)
        case 'screen':
          if (!msg.on) screen.unsubscribe(ws);
          else if (!cfg.allowScreen) ws.send(JSON.stringify({ t: 'screen-off', reason: 'disabled' }));
          else {
            const first = !screen.isViewing(ws);
            screen.subscribe(ws, { preset: msg.preset, fps: msg.fps, width: msg.width, quality: msg.quality }, device.name);
            if (first && cfg.notifyOnConnect) tray.notify('Screen preview started', `${device.name} is viewing your screen`);
          }
          break;
        case 'fack': screen.ack(ws); break;
        case 'ping': ws.send(JSON.stringify({ t: 'pong' })); break;
        default: break;
      }
    });

    ws.on('close', () => {
      // lepas tombol yang masih ditekan supaya tidak "nyangkut" drag
      for (const b of pressed) input.up(b);
      screen.unsubscribe(ws);
      pressed.clear();
      if (sockets.get(device.id) === ws) sockets.delete(device.id);
      pushTray();
      if (devices.includes(device)) {
        device.lastSeen = new Date().toISOString();
        persistDevices();
      }
      log(`Disconnected: ${device.name}`);
    });
  }

  const heartbeat = setInterval(() => {
    for (const ws of sockets.values()) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
    if (devicesDirty) persistDevices();
    pushTray(); // IP bisa berubah (ganti Wi-Fi)
  }, 15_000);
  heartbeat.unref();

  // ---------- lifecycle ----------
  function start() {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${cfg.port} is already in use by another app (or this server is already running).`));
        } else {
          reject(err);
        }
      };
      server.once('error', onError);
      server.listen(cfg.port, '0.0.0.0', () => {
        server.off('error', onError);
        input.start();
        syncTray();
        syncTunnel();
        config.writeRuntime({ pid: process.pid, port: cfg.port, mode, startedAt });
        log(`Server listening on port ${cfg.port} (${mode} mode).`);
        resolve({ port: cfg.port, pairCode: cfg.pairCode, addresses: getLanAddresses() });
      });
    });
  }

  function stop() {
    if (stopping) return stopping;
    stopping = new Promise((resolve) => {
      clearInterval(heartbeat);
      for (const ws of sockets.values()) ws.close(1001, 'Server dimatikan');
      if (devicesDirty) persistDevices();
      input.stop();
      screen.stop();
      tunnel.stop();
      tray.stop();
      config.clearRuntime();
      wss.close();
      server.close(() => resolve());
      // koneksi keep-alive bisa menahan close; paksa setelah 1.5 detik
      setTimeout(() => {
        server.closeAllConnections?.();
        resolve();
      }, 1500).unref();
      log('Server stopped.');
    });
    return stopping;
  }

  return { start, stop, getLanAddresses };
}

module.exports = { createServer, getLanAddresses };
