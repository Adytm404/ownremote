#!/usr/bin/env node
// OwnRemote - CLI utama.
//   node cli.js          menu interaktif
//   node cli.js run      jalankan server di terminal ini
//   node cli.js start    jalankan server di background
//   node cli.js stop     hentikan server
//   node cli.js status   tampilkan status
const readline = require('readline');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const qrcode = require('qrcode-terminal');
const config = require('./src/config');
const api = require('./src/admin-client');
const startup = require('./src/startup');
const { createServer } = require('./src/server');
const logo = require('./src/logo');
const { findCloudflared } = require('./src/tunnel');

// ---------------------------------------------------------------- tampilan
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', underline: '\x1b[4m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m',
  magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m',
};
const paint = (style, s) => `${style.split(' ').map((k) => C[k]).join('')}${s}${C.reset}`;
const visibleLen = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - visibleLen(s)));
const time = () => new Date().toLocaleTimeString('en-GB', { hour12: false });

// Menu utama memakai logo besar; sub-menu memakai header 1 baris supaya daftar & QR tetap muat di layar.
function header(subtitle) {
  console.clear();
  console.log();
  if (subtitle) {
    console.log(logo.smallLogo(subtitle));
    console.log(paint('gray', `  ${'-=#'.repeat(20)}`));
  } else {
    console.log(logo.bigLogo());
  }
  console.log();
}

function relTime(iso) {
  if (!iso) return '-';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

const fmtCode = (code) => `${code.slice(0, 3)} ${code.slice(3)}`;
const urlsOf = (st) => st.addresses.map((a) => `http://${a.address}:${st.port}`);

function printStatus(st) {
  const row = (label, value) => console.log(`  ${paint('gray', pad(label, 15))}${value}`);
  if (st) {
    const mode = st.mode === 'background' ? 'background' : 'another terminal';
    row('Server', `${paint('green bold', '● RUNNING')} ${paint('gray', `(${mode}, PID ${st.pid})`)}`);
    printConnectInfo(st, row);
    row('Devices', `${paint('bold', st.online)} online / ${st.devices} paired`);
    if (st.mode === 'background') {
      row('Tray icon', st.trayActive ? paint('green', 'shown (bottom-right of the taskbar)') : paint('gray', 'off'));
    }
  } else {
    row('Server', paint('red bold', '○ NOT RUNNING'));
  }
  row('Startup', startup.isStartupEnabled() ? paint('green', 'ENABLED (runs automatically at Windows sign-in)') : paint('gray', 'disabled'));
  console.log();
}

function printConnectInfo(st, row = (l, v) => console.log(`  ${paint('gray', pad(l, 15))}${v}`)) {
  const urls = urlsOf(st);
  if (urls.length === 0) {
    row('Address', paint('red', 'no LAN/Wi-Fi network detected'));
  } else {
    urls.forEach((u, i) => row(i === 0 ? 'Open on phone' : '', paint(i === 0 ? 'bold underline cyan' : 'cyan', u) + (st.addresses[i].virtual ? paint('gray', ` (${st.addresses[i].name})`) : '')));
  }
  const t = st.tunnel;
  if (t && t.mode !== 'off') {
    if (t.state === 'connected' && t.url) row('Internet', `${paint('bold underline magenta', t.url)} ${paint('gray', '(Cloudflare Tunnel)')}`);
    else if (t.state === 'error') row('Internet', paint('red', t.error));
    else row('Internet', paint('yellow', 'Cloudflare Tunnel connecting...'));
  }
  const pairing = st.allowPairing ? paint('green', 'pairing open') : paint('red', 'pairing LOCKED');
  row('Code', `${paint('bold yellow', fmtCode(st.pairCode))}  ${paint('gray', '·')} ${pairing}`);
}

const tunnelUrl = (st) => (st?.tunnel?.state === 'connected' && st.tunnel.url) || '';

function printQr(st, url = urlsOf(st)[0]) {
  if (!url) return;
  qrcode.generate(`${url}/#code=${st.pairCode}`, { small: true }, (qr) => {
    console.log(qr.split('\n').map((l) => `    ${l}`).join('\n'));
  });
  console.log(paint('gray', `    Scan with your phone camera (the code is filled in automatically): ${url}`));
  console.log();
}

function menu(items) {
  for (const [key, label] of items) console.log(`  ${paint('cyan bold', `[${key}]`)} ${label}`);
  console.log();
}

const ok = (msg) => console.log(`  ${paint('green', '✔')} ${msg}`);
const fail = (msg) => console.log(`  ${paint('red', '✖')} ${msg}`);
const info = (msg) => console.log(`  ${paint('cyan', '›')} ${msg}`);

// ---------------------------------------------------------------- input
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let pendingAsk = null;
let foregroundServer = null;
let inputClosed = false;
const queuedLines = []; // baris yang masuk sebelum ada pertanyaan (mis. paste beberapa baris)
const STOPPED = Symbol('stopped');

rl.on('line', (line) => {
  if (!pendingAsk) {
    queuedLines.push(line.trim());
    return;
  }
  const resolve = pendingAsk;
  pendingAsk = null;
  resolve(line.trim());
});
rl.on('SIGINT', () => exitApp());

function ask(question) {
  return new Promise((resolve) => {
    if (queuedLines.length) {
      const line = queuedLines.shift();
      process.stdout.write(`${question}${line}\n`);
      resolve(line);
    } else if (inputClosed) {
      exitApp();
    } else {
      pendingAsk = resolve;
      rl.setPrompt(question);
      rl.prompt();
    }
  });
}

function cancelAsk(value) {
  if (!pendingAsk) return;
  const resolve = pendingAsk;
  pendingAsk = null;
  process.stdout.write('\n');
  resolve(value);
}

const choose = (label = 'Choose') => ask(`  ${paint('bold', label)} ${paint('cyan', '›')} `);
const pause = () => ask(paint('gray', '\n  Press Enter to go back...'));

async function confirm(question) {
  const ans = await ask(`  ${question} ${paint('gray', '(y/n)')} `);
  return /^y(a|es)?$/i.test(String(ans));
}

// Tulis log di atas prompt tanpa merusak input yang sedang diketik.
function logAbove(text) {
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  process.stdout.write(`${text}\n`);
  if (pendingAsk) rl.prompt(true);
}

let exiting = false;
async function exitApp(code = 0) {
  if (exiting) return;
  exiting = true;
  if (foregroundServer) {
    console.log(paint('gray', '\n  Stopping server...'));
    await foregroundServer.stop();
  }
  process.exit(code);
}

async function spinner(text, promise) {
  if (!process.stdout.isTTY) return promise;
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const t = setInterval(() => process.stdout.write(`\r  ${paint('cyan', frames[i++ % frames.length])} ${text}`), 80);
  try {
    return await promise;
  } finally {
    clearInterval(t);
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  }
}

// ---------------------------------------------------------------- aksi server
async function startBackground() {
  const st = await api.getStatus();
  if (st) {
    info(`Server is already running (${st.mode}, PID ${st.pid}).`);
    return st;
  }
  startup.launchBackground();
  const started = await spinner('Starting server in the background...', api.waitUntilUp(12_000));
  if (!started) {
    fail('Server failed to start. Latest log:');
    printLogTail(10);
    return null;
  }
  ok(`Server is running in the background ${paint('gray', `(PID ${started.pid})`)}. You can close this terminal.`);
  console.log();
  printConnectInfo(started);
  console.log();
  return started;
}

async function stopServer() {
  const st = await api.getStatus();
  if (!st) {
    info('Server is not running.');
    return;
  }
  try {
    await api.shutdown();
  } catch { /* fallback di bawah */ }
  let down = await spinner('Stopping server...', api.waitUntilDown(5000));
  if (!down) {
    try { process.kill(st.pid); } catch { /* sudah mati */ }
    down = await api.waitUntilDown(2000);
  }
  if (down) ok('Server stopped.');
  else fail(`Could not stop the server. Try ending node process PID ${st.pid} in Task Manager.`);
}

async function runForeground() {
  const st = await api.getStatus();
  if (st) {
    fail(`Server is already running (${st.mode}, PID ${st.pid}). Stop it first with menu [4].`);
    await pause();
    return;
  }

  const recent = [];
  let stoppedExternally = false;
  const server = createServer({
    mode: 'foreground',
    log: (msg) => {
      const line = `${paint('gray', time())} ${msg}`;
      recent.push(line);
      if (recent.length > 8) recent.shift();
      logAbove(`  ${line}`);
    },
    onShutdown: () => {
      stoppedExternally = true;
      foregroundServer = null;
      cancelAsk(STOPPED);
    },
  });

  try {
    await server.start();
  } catch (err) {
    fail(err.message);
    await server.stop();
    await pause();
    return;
  }
  foregroundServer = server;
  await sessionMenu({ foreground: true, recent });

  if (stoppedExternally) {
    header();
    info('Server was stopped from another terminal.');
    await pause();
  } else {
    await server.stop();
    foregroundServer = null;
  }
}

// ---------------------------------------------------------------- manajemen session
function printSessions(list) {
  console.log(paint('bold', '  Paired devices'));
  if (list.length === 0) {
    console.log(paint('gray', '  None yet. Open the address above on your phone and enter the code.'));
    console.log();
    return;
  }
  const cols = [4, 24, 17, 11, 16];
  const head = ['No', 'Name', 'IP', 'Status', 'Last active'];
  console.log(paint('gray', `  ${head.map((h, i) => pad(h, cols[i])).join('')}`));
  console.log(paint('gray', `  ${'─'.repeat(cols.reduce((a, b) => a + b, 0))}`));
  list.forEach((d, i) => {
    let status = d.online ? paint('green', '● online') : paint('gray', '○ offline');
    if (d.viewingScreen) status = paint('cyan bold', '◉ screen');
    const last = d.online ? `since ${relTime(d.connectedAt)}` : relTime(d.lastSeen);
    const name = d.name.length > 22 ? `${d.name.slice(0, 21)}…` : d.name;
    console.log(`  ${pad(String(i + 1), cols[0])}${pad(name, cols[1])}${pad(d.ip || '-', cols[2])}${pad(status, cols[3])}${paint('gray', last)}`);
  });
  console.log();
}

async function pickDevice(list, verb) {
  if (list.length === 0) {
    info('No paired devices yet.');
    await pause();
    return null;
  }
  const ans = await ask(`  Device number to ${verb} ${paint('gray', '(empty = cancel)')} › `);
  if (ans === STOPPED || ans === '') return null;
  const d = list[Number(ans) - 1];
  if (!d) {
    fail('Invalid number.');
    await pause();
    return null;
  }
  return d;
}

async function sessionMenu({ foreground = false, recent = [] } = {}) {
  let showQr = false;
  for (;;) {
    const st = await api.getStatus();
    if (!st) {
      if (!foreground) {
        header('SESSION MANAGEMENT');
        fail('Server is not running. Start it first with menu [1] or [2].');
        await pause();
      }
      return;
    }
    let list = [];
    try { list = await api.sessions(); } catch { /* tampilkan kosong */ }

    header(foreground ? 'SERVER RUNNING IN THIS TERMINAL' : 'SESSION MANAGEMENT');
    printConnectInfo(st);
    console.log();
    if (showQr === 'internet') printQr(st, tunnelUrl(st));
    else if (showQr || list.length === 0) printQr(st);
    showQr = false;
    printSessions(list);

    if (foreground && recent.length) {
      console.log(paint('bold', '  Recent activity'));
      recent.forEach((l) => console.log(`  ${l}`));
      console.log();
    }

    menu([
      ['1', 'Refresh'],
      ['2', 'Disconnect a device'],
      ['3', 'Revoke device access (must pair again)'],
      ['4', 'Revoke access for ALL devices'],
      ['5', 'Generate new pairing code'],
      ['6', st.allowPairing ? 'Lock pairing (reject new devices)' : 'Unlock pairing for new devices'],
      ['7', 'Show QR code (Wi-Fi / LAN)'],
      ...(tunnelUrl(st) ? [['8', 'Show QR code (internet, Cloudflare Tunnel)']] : []),
      ['0', foreground ? paint('red', 'Stop server & return to main menu') : 'Back'],
    ]);

    const ch = await choose();
    if (ch === STOPPED) return;
    try {
      switch (ch) {
        case '1': case '': break;
        case '2': {
          const d = await pickDevice(list, 'disconnect');
          if (d) {
            const r = await api.disconnect(d.id);
            if (!r.ok) { info(`${d.name} is not connected.`); await pause(); }
          }
          break;
        }
        case '3': {
          const d = await pickDevice(list, 'revoke');
          if (d && await confirm(`Revoke access for ${paint('bold', d.name)}?`)) await api.revoke(d.id);
          break;
        }
        case '4':
          if (list.length && await confirm(paint('red', `Revoke access for ${list.length} device(s)?`))) await api.revokeAll();
          break;
        case '5':
          await api.regenerateCode();
          break;
        case '6':
          await api.setPairing(!st.allowPairing);
          break;
        case '7':
          showQr = true;
          break;
        case '8':
          if (tunnelUrl(st)) showQr = 'internet';
          break;
        case '0':
          return;
        default:
          break;
      }
    } catch (err) {
      fail(err.message);
      await pause();
    }
  }
}

// ---------------------------------------------------------------- pengaturan
function printLogTail(lines = 30) {
  let text = '';
  try { text = fs.readFileSync(config.LOG_FILE, 'utf8'); } catch { /* belum ada */ }
  const tail = text.trimEnd().split(/\r?\n/).filter(Boolean).slice(-lines);
  if (tail.length === 0) info('Log is empty.');
  tail.forEach((l) => console.log(paint('gray', `    ${l}`)));
}

function addFirewallRule(port) {
  const name = `OwnRemote-${port}`;
  const args = `/c netsh advfirewall firewall delete rule name=${name} >nul & netsh advfirewall firewall add rule name=${name} dir=in action=allow protocol=TCP localport=${port}`;
  const ps = `$p = Start-Process cmd -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '${args}'; exit $p.ExitCode`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true }, (err) => resolve(!err));
  });
}

async function settingsMenu() {
  for (;;) {
    const cfg = config.loadConfig();
    const st = await api.getStatus();
    header('SETTINGS');
    menu([
      ['1', `Change port ${paint('gray', `(current: ${cfg.port})`)}`],
      ['2', 'Generate new pairing code'],
      ['3', `Allow port ${cfg.port} in Windows Firewall ${paint('gray', '(requires admin)')}`],
      ['4', 'View background server log'],
      ['5', 'Open data folder'],
      ['6', `${paint('bold', 'Advanced settings')} ${paint('gray', '(startup, tray icon, notifications, ...)')}`],
      ['7', `${paint('bold', 'Cloudflare Tunnel')} ${paint('gray', '(use OwnRemote outside your Wi-Fi)')}`],
      ['0', 'Back'],
    ]);
    const ch = await choose();
    switch (ch) {
      case '6':
        await advancedMenu();
        break;
      case '7':
        await tunnelMenu();
        break;
      case '1': {
        if (st) {
          fail('Stop the server before changing the port.');
          await pause();
          break;
        }
        const ans = await ask(`  New port ${paint('gray', '(1024-65535, empty = cancel)')} › `);
        if (!ans) break;
        const port = Number(ans);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) {
          fail('Invalid port.');
          await pause();
          break;
        }
        config.saveConfig({ ...cfg, port });
        ok(`Port changed to ${port}.`);
        await pause();
        break;
      }
      case '2': {
        const code = st ? (await api.regenerateCode()).pairCode : config.newPairCode();
        if (!st) config.saveConfig({ ...cfg, pairCode: code });
        ok(`New pairing code: ${paint('bold yellow', fmtCode(code))}`);
        await pause();
        break;
      }
      case '3': {
        info('Approve the UAC prompt that appears...');
        const added = await addFirewallRule(cfg.port);
        if (added) ok(`Firewall rule "OwnRemote-${cfg.port}" added.`);
        else fail('Failed or cancelled. Run the terminal as Administrator and try again.');
        await pause();
        break;
      }
      case '4':
        header('BACKGROUND SERVER LOG');
        printLogTail(30);
        await pause();
        break;
      case '5':
        config.ensureDataDir();
        spawn('explorer.exe', [config.DATA_DIR], { detached: true, stdio: 'ignore' }).unref();
        break;
      case '0':
        return;
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------- advanced settings
const onOff = (v) => (v ? paint('green bold', 'ON') : paint('gray', 'OFF'));

function settingLine(key, label, value, hint = '') {
  const dots = paint('gray', ` ${'.'.repeat(Math.max(2, 40 - label.length))} `);
  console.log(`  ${paint('cyan bold', `[${key}]`)} ${label}${dots}${pad(value, 6)}${hint ? paint('gray', `  ${hint}`) : ''}`);
}

// Saat server berjalan, pengaturan dikirim lewat Admin API supaya langsung berlaku (dan tidak tertimpa server).
async function applySettings(st, patch) {
  if (st) return api.updateSettings(patch);
  config.saveConfig({ ...config.loadConfig(), ...patch });
  return null;
}

async function advancedMenu() {
  for (;;) {
    const st = await api.getStatus();
    const s = { ...config.loadConfig(), ...(st?.settings || {}) }; // server versi lama: lengkapi dari config
    const autostart = startup.isStartupEnabled();
    const trayHint = st?.mode === 'background' ? (st.trayActive ? 'showing now' : 'hidden now') : 'background mode only';

    header('ADVANCED SETTINGS');
    console.log(paint('bold', '  Startup'));
    settingLine('1', 'Start with Windows', onOff(autostart), 'runs in the background at sign-in');
    settingLine('2', 'Startup delay', `${s.startupDelay}s`, 'wait after sign-in (e.g. for Wi-Fi)');
    console.log();
    console.log(paint('bold', '  System tray'));
    settingLine('3', 'Show tray icon', onOff(s.trayIcon), trayHint);
    settingLine('4', 'Notify when a device connects', onOff(s.notifyOnConnect), 'tray notification');
    console.log();
    console.log(paint('bold', '  Security & privacy'));
    settingLine('5', 'Auto-lock pairing after a new device', onOff(s.autoLockPairing), 'rejects further devices');
    settingLine('6', 'Allow screen preview on phone', onOff(s.allowScreen), 'phone must still turn it on');
    settingLine('7', 'Reset all devices & pairing code', '', 'every phone must pair again');
    console.log();
    menu([['0', 'Back']]);

    const ch = await choose();
    try {
      switch (ch) {
        case '1':
          if (autostart) {
            startup.disableStartup();
            ok('Start with Windows disabled.');
          } else {
            startup.enableStartup();
            ok('The server will start in the background at every Windows sign-in.');
            console.log(paint('gray', `    ${startup.STARTUP_FILE}`));
            if (!st && await confirm('Start the server in the background now?')) await startBackground();
          }
          await pause();
          break;
        case '2': {
          const ans = await ask(`  Startup delay in seconds ${paint('gray', '(0-600, empty = cancel)')} › `);
          if (!ans) break;
          const sec = Number(ans);
          if (!Number.isInteger(sec) || sec < 0 || sec > 600) {
            fail('Enter a whole number between 0 and 600.');
            await pause();
            break;
          }
          await applySettings(st, { startupDelay: sec });
          break;
        }
        case '3':
          await applySettings(st, { trayIcon: !s.trayIcon });
          if (st?.mode === 'background') await new Promise((r) => setTimeout(r, 500)); // beri waktu ikon muncul/hilang
          break;
        case '4':
          await applySettings(st, { notifyOnConnect: !s.notifyOnConnect });
          break;
        case '5':
          await applySettings(st, { autoLockPairing: !s.autoLockPairing });
          break;
        case '6':
          await applySettings(st, { allowScreen: !s.allowScreen });
          break;
        case '7':
          if (!await confirm(paint('red', 'Revoke ALL devices and generate a new pairing code?'))) break;
          if (st) {
            await api.revokeAll();
            await api.regenerateCode();
            await api.setPairing(true);
          } else {
            config.saveDevices([]);
            config.saveConfig({ ...config.loadConfig(), pairCode: config.newPairCode(), allowPairing: true });
          }
          ok('All devices removed. New pairing code created.');
          await pause();
          break;
        case '0':
          return;
        default:
          break;
      }
    } catch (err) {
      fail(err.message);
      await pause();
    }
  }
}

// ---------------------------------------------------------------- Cloudflare Tunnel
const TUNNEL_LABELS = { off: 'Off', quick: 'Quick tunnel (*.trycloudflare.com)', token: 'Named tunnel (your domain)' };

async function enableTunnel(st, patch) {
  const s = { ...config.loadConfig(), ...(st?.settings || {}) }; // server versi lama: lengkapi dari config
  console.log();
  console.log(paint('yellow', '  ! Anyone on the internet who has this URL can open the OwnRemote page.'));
  console.log(paint('yellow', '    They still need the 6-digit pairing code, but locking pairing after your phone is paired is safer.'));
  if (!s.autoLockPairing && await confirm('Enable auto-lock pairing after a new device pairs? (recommended)')) {
    patch.autoLockPairing = true;
  }
  await applySettings(st, patch);
  if (!st) {
    ok('Saved. The tunnel starts together with the server.');
    await pause();
    return;
  }
  const up = await spinner('Connecting to Cloudflare...', (async () => {
    for (let i = 0; i < 60; i++) {
      const now = await api.getStatus();
      const t = now?.tunnel;
      if (t && (t.state === 'connected' || t.state === 'error')) return now;
      await new Promise((r) => setTimeout(r, 500));
    }
    return api.getStatus();
  })());
  const t = up?.tunnel;
  if (t?.state === 'connected') {
    ok(`Tunnel connected${t.url ? `: ${paint('bold magenta', t.url)}` : ''}`);
    if (patch.tunnelMode === 'quick') info('A brand-new quick tunnel URL can take up to a minute before it opens on your phone.');
    if (t.url) printQr(up, t.url);
  } else {
    fail(t?.error || 'Tunnel is still connecting. Check the status again in a moment.');
  }
  await pause();
}

async function tunnelMenu() {
  for (;;) {
    const st = await api.getStatus();
    const s = { ...config.loadConfig(), ...(st?.settings || {}) }; // server versi lama: lengkapi dari config
    const tokenSet = st ? s.tunnelTokenSet : Boolean(s.tunnelToken);
    const exe = findCloudflared(s.cloudflaredPath);
    const t = st?.tunnel;

    header('CLOUDFLARE TUNNEL');
    console.log(paint('gray', '  Reach your PC from anywhere (mobile data, other Wi-Fi) through a secure HTTPS tunnel.'));
    console.log();
    const row = (l, v) => console.log(`  ${paint('gray', pad(l, 15))}${v}`);
    row('cloudflared', exe ? paint('green', exe) : paint('red', 'not found  ->  winget install --id Cloudflare.cloudflared'));
    row('Mode', s.tunnelMode === 'off' ? paint('gray', 'off') : paint('bold', TUNNEL_LABELS[s.tunnelMode]));
    if (s.tunnelMode !== 'off') {
      if (!st) row('Status', paint('gray', 'starts when the server starts'));
      else if (!t) row('Status', paint('yellow', 'restart the server to start the tunnel (it is running an older version)'));
      else if (t?.state === 'connected') row('Status', `${paint('green bold', '● connected')}  ${t.url ? paint('bold underline magenta', t.url) : ''}`);
      else if (t?.state === 'error') row('Status', paint('red', t.error));
      else row('Status', paint('yellow', 'connecting...'));
    }
    row('Tunnel token', tokenSet ? paint('green', 'set') : paint('gray', 'not set (only needed for named tunnels)'));
    row('Public URL', s.publicUrl ? paint('cyan', s.publicUrl) : paint('gray', 'not set (only needed for named tunnels)'));
    console.log();

    menu([
      ['1', 'Turn tunnel off'],
      ['2', `Quick tunnel ${paint('gray', '- random https://*.trycloudflare.com URL, no account needed')}`],
      ['3', `Named tunnel ${paint('gray', '- your own domain, needs a Cloudflare tunnel token')}`],
      ['4', 'Set tunnel token'],
      ['5', 'Set public URL of the named tunnel'],
      ...(tunnelUrl(st) ? [['6', 'Show QR code for the internet URL']] : []),
      ['0', 'Back'],
    ]);

    const ch = await choose();
    try {
      switch (ch) {
        case '1':
          await applySettings(st, { tunnelMode: 'off' });
          break;
        case '2':
          if (!exe) { fail('Install cloudflared first: winget install --id Cloudflare.cloudflared'); await pause(); break; }
          await enableTunnel(st, { tunnelMode: 'quick' });
          break;
        case '3':
          if (!exe) { fail('Install cloudflared first: winget install --id Cloudflare.cloudflared'); await pause(); break; }
          if (!tokenSet || !s.publicUrl) {
            console.log();
            info('Setup in the Cloudflare dashboard (Zero Trust > Networks > Tunnels > Create a tunnel):');
            console.log(paint('gray', `    1. Choose "Cloudflared", copy the token from the install command.`));
            console.log(paint('gray', `    2. Add a public hostname (e.g. remote.yourdomain.com) -> service HTTP, URL localhost:${config.loadConfig().port}`));
            console.log(paint('gray', '    3. Paste the token (menu 4) and the public URL (menu 5) here, then pick menu 3 again.'));
            await pause();
            break;
          }
          await enableTunnel(st, { tunnelMode: 'token' });
          break;
        case '4': {
          console.log(paint('gray', '  Paste the token or the whole "cloudflared service install <token>" command.'));
          const ans = await ask(`  Tunnel token ${paint('gray', '(empty = cancel, "-" = remove)')} › `);
          if (!ans) break;
          const token = ans === '-' ? '' : ans.trim().split(/\s+/).pop();
          await applySettings(st, { tunnelToken: token });
          ok(token ? 'Tunnel token saved.' : 'Tunnel token removed.');
          await pause();
          break;
        }
        case '5': {
          const ans = await ask(`  Public URL, e.g. https://remote.yourdomain.com ${paint('gray', '(empty = cancel, "-" = remove)')} › `);
          if (!ans) break;
          const url = ans === '-' ? '' : ans.trim().replace(/\/+$/, '');
          if (url && !/^https?:\/\/[^\s/]+$/i.test(url)) { fail('Enter a URL like https://remote.yourdomain.com'); await pause(); break; }
          await applySettings(st, { publicUrl: url });
          break;
        }
        case '6':
          if (tunnelUrl(st)) {
            header('CLOUDFLARE TUNNEL');
            printQr(st, tunnelUrl(st));
            await pause();
          }
          break;
        case '0':
          return;
        default:
          break;
      }
    } catch (err) {
      fail(err.message);
      await pause();
    }
  }
}

// ---------------------------------------------------------------- menu utama
async function mainMenu() {
  for (;;) {
    const st = await api.getStatus();
    header();
    printStatus(st);
    menu([
      ['1', `Run in this terminal${st ? paint('gray', '  (server already running)') : ''}`],
      ['2', `Run in the background${st ? paint('gray', '  (server already running)') : ''}`],
      ['3', 'Session / device management'],
      ['4', 'Stop server'],
      ['5', `Settings ${paint('gray', '(port, firewall, log, advanced)')}`],
      ['0', 'Exit'],
    ]);

    const ch = await choose();
    switch (ch) {
      case '1':
        await runForeground();
        break;
      case '2':
        await startBackground();
        await pause();
        break;
      case '3':
        await sessionMenu();
        break;
      case '4':
        await stopServer();
        await pause();
        break;
      case '5':
        await settingsMenu();
        break;
      case '0': {
        const running = await api.getStatus();
        if (running?.mode === 'background') console.log(paint('gray', '\n  The server keeps running in the background. Bye!\n'));
        else if (running) console.log(paint('gray', '\n  The server keeps running in the other terminal. Bye!\n'));
        return exitApp();
      }
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------- entry
async function main() {
  config.loadConfig();
  startup.refreshStartup();

  const cmd = (process.argv[2] || '').toLowerCase();
  // Ctrl+D / stdin ditutup hanya mengakhiri program di mode interaktif
  if (cmd === '' || cmd === 'run') {
    rl.on('close', () => {
      inputClosed = true;
      if (pendingAsk) exitApp();
    });
  }
  switch (cmd) {
    case '':
      return mainMenu();
    case 'run':
      await runForeground();
      return exitApp();
    case 'start': {
      const st = await startBackground();
      return exitApp(st ? 0 : 1);
    }
    case 'stop':
      await stopServer();
      return exitApp();
    case 'status': {
      const st = await api.getStatus();
      console.log();
      printStatus(st);
      return exitApp();
    }
    default:
      console.log('Usage: node cli.js [run|start|stop|status]');
      return exitApp(1);
  }
}

main().catch((err) => {
  console.error(err);
  exitApp(1);
});
