// Entry point mode background. Dijalankan tersembunyi (tanpa jendela) lewat wscript + launcher .vbs,
// baik dari menu CLI maupun dari folder Startup Windows. Semua output ditulis ke data/server.log.
const fs = require('fs');
const config = require('./config');
const { createServer } = require('./server');

config.ensureDataDir();

// rotasi log sederhana: simpan maksimal ~1 MB
try {
  if (fs.statSync(config.LOG_FILE).size > 1024 * 1024) fs.renameSync(config.LOG_FILE, `${config.LOG_FILE}.old`);
} catch { /* log belum ada */ }

const out = fs.createWriteStream(config.LOG_FILE, { flags: 'a' });
const log = (msg) => out.write(`[${new Date().toLocaleString('en-GB')}] ${msg}\n`);

process.on('uncaughtException', (err) => log(`ERROR: ${err.stack || err}`));
process.on('unhandledRejection', (err) => log(`ERROR: ${err?.stack || err}`));

const server = createServer({
  mode: 'background',
  log,
  onShutdown: () => out.end(() => process.exit(0)),
});

const shutdown = () => server.stop().then(() => out.end(() => process.exit(0)));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Saat dijalankan dari folder Startup Windows, tunggu sesuai "startup delay" (mis. menunggu Wi-Fi tersambung)
const delay = process.argv.includes('--startup') ? config.loadConfig().startupDelay || 0 : 0;
if (delay > 0) log(`Launched at Windows sign-in, waiting ${delay}s before starting...`);

new Promise((r) => setTimeout(r, delay * 1000))
  .then(() => server.start())
  .then(({ addresses, port }) => {
    const urls = addresses.map((a) => `http://${a.address}:${port}`).join(', ') || '(no network)';
    log(`Open on your phone: ${urls}`);
  })
  .catch((err) => {
    log(`Failed to start: ${err.message}`);
    out.end(() => process.exit(1));
  });
