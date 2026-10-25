(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* mode privat */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* mode privat */ } },
  };
  // per tab: reload saat sedang mengontrol PC kembali ke PC yang sama
  const tabStore = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* mode privat */ } },
    del(k) { try { sessionStorage.removeItem(k); } catch { /* mode privat */ } },
  };

  const SESSIONS_KEY = 'or_sessions';
  const CURRENT_KEY = 'or_current';
  const LEGACY_TOKEN_KEY = 'rc_token';
  const LEGACY_PC_KEY = 'rc_pc';
  const SETTINGS_KEY = 'rc_settings';
  const DEFAULTS = { sens: 1.6, accel: 0.8, scrollSpeed: 4, natural: true, haptic: true, screenFps: 5, screenWidth: 960, screenQuality: 50, screenZoom: 1 };

  // Gesture
  const TAP_MAX_MS = 300;
  const TAP_MAX_TRAVEL = 12;
  const HOLD_MS = 500;
  const HOLD_MAX_TRAVEL = 6;

  let settings = { ...DEFAULTS };
  try { Object.assign(settings, JSON.parse(store.get(SETTINGS_KEY) || '{}')); } catch { /* default */ }

  let ws = null;
  let retry = 0;
  let retryTimer = 0;
  let autoReconnect = true;
  let pongTimer = 0;

  // ================================================================ daftar PC (sesi)
  // Satu HP bisa menyimpan beberapa PC. Tiap PC = { id, url (origin), token, pc (hostname), label }.
  // Halaman ini boleh dibuka dari PC mana pun; API & WebSocket PC lain dipanggil lintas origin.
  const HERE = location.origin;
  const DEFAULT_PORT = '8787';

  const newId = () => Math.random().toString(36).slice(2, 10);
  const hostOf = (url) => { try { return new URL(url).host; } catch { return url; } };
  const titleOf = (s) => s.label || s.pc || hostOf(s.url);
  // Halaman HTTPS (tunnel) tidak boleh memanggil alamat http:// (Wi-Fi) - diblokir browser
  const blockedByHttps = (url) => location.protocol === 'https:' && url.startsWith('http:');

  let sessions = loadSessions();
  let active = null; // PC yang sedang dikontrol
  let pairTarget = null; // { url, fixed, session } saat menambah / pairing ulang PC

  function loadSessions() {
    let list = [];
    try { list = JSON.parse(store.get(SESSIONS_KEY) || '[]'); } catch { /* rusak: mulai kosong */ }
    if (!Array.isArray(list)) list = [];
    list = list.filter((s) => s && typeof s.url === 'string' && typeof s.token === 'string');
    // Versi lama hanya menyimpan satu PC (PC yang membuka halaman ini)
    const legacy = store.get(LEGACY_TOKEN_KEY);
    if (legacy) {
      if (!list.some((s) => s.url === HERE)) {
        list.unshift({ id: newId(), url: HERE, token: legacy, pc: store.get(LEGACY_PC_KEY) || '', label: '', used: Date.now() });
      }
      store.set(SESSIONS_KEY, JSON.stringify(list));
      store.del(LEGACY_TOKEN_KEY);
      store.del(LEGACY_PC_KEY);
    }
    return list;
  }

  const saveSessions = () => store.set(SESSIONS_KEY, JSON.stringify(sessions));
  const findSession = (id) => sessions.find((s) => s.id === id) || null;

  // "192.168.1.20" -> http://192.168.1.20:8787, "abc.trycloudflare.com" -> https://abc.trycloudflare.com
  function normalizeUrl(raw) {
    let text = String(raw || '').trim().replace(/\/+$/, '');
    if (!text) throw new Error('Enter the address shown on your PC.');
    const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(text);
    let local = false;
    if (!hasScheme) {
      const host = text.split(/[/:]/)[0];
      local = /^(localhost|\d{1,3}(\.\d{1,3}){3})$/i.test(host) || /\.(local|lan|home)$/i.test(host) || !host.includes('.');
      text = `${local ? 'http' : 'https'}://${text}`;
    }
    let u;
    try { u = new URL(text); } catch { throw new Error("That doesn't look like an address."); }
    if (!/^https?:$/.test(u.protocol) || !u.hostname) throw new Error("That doesn't look like an address.");
    if (local && !u.port) u.port = DEFAULT_PORT;
    return u.origin;
  }

  // ================================================================ layar
  const homeScreen = $('homeScreen');
  const pairScreen = $('pairScreen');
  const padScreen = $('padScreen');
  const overlay = $('overlay');

  function showOnly(el) {
    [homeScreen, pairScreen, padScreen].forEach((s) => s.classList.toggle('hidden', s !== el));
  }

  // Pairing PC baru (url kosong = isi alamat sendiri) atau pairing ulang PC yang sudah ada
  function showPair({ url = '', session = null, message = '' } = {}) {
    const target = session ? session.url : url;
    pairTarget = { url: target, fixed: Boolean(target), session };
    showOnly(pairScreen);
    const isHere = target === HERE;
    $('pairTitle').textContent = session ? `Pair ${titleOf(session)} again` : target ? 'Connect to your PC' : 'Add a PC';
    $('pairSub').textContent = target && !isHere
      ? `Enter the 6-digit code shown on ${hostOf(target)}.`
      : target ? 'Enter the 6-digit code shown on your PC.'
        : 'Enter the address and 6-digit code shown in OwnRemote on that PC.';
    $('addrField').classList.toggle('hidden', Boolean(target));
    $('pairBackBtn').classList.toggle('hidden', !sessions.length && isHere);
    $('pairError').textContent = message;
    $('addrInput').value = '';
    codeInput.value = '';
    renderSlots();
    if (!target) setTimeout(() => $('addrInput').focus(), 50);
  }

  function showPad() {
    showOnly(padScreen);
    hideOverlay();
    $('pcName').textContent = active ? titleOf(active) : 'PC';
  }

  function showHome() {
    showOnly(homeScreen);
    closePcSheet();
    renderHome();
    refreshStatuses();
  }

  function setConn(state, text) {
    $('connDot').className = `dot ${state}`;
    $('connText').textContent = text;
  }

  function showOverlay(text, withButton = true) {
    $('overlayText').textContent = text;
    $('reconnectBtn').classList.toggle('hidden', !withButton);
    overlay.classList.remove('hidden');
  }

  const hideOverlay = () => overlay.classList.add('hidden');

  // ================================================================ dashboard
  const MONITOR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 3H3a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h7v2H8v2h8v-2h-2v-2h7a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 13H3V5h18z"/></svg>';
  const STATUS_TEXT = {
    checking: 'Checking…',
    online: 'Online',
    offline: 'Offline',
    unpaired: 'Needs pairing again',
    blocked: 'Open the Wi-Fi address to reach it',
  };
  const status = new Map(); // id -> status
  const sessionList = $('sessionList');

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  function renderHome() {
    const list = [...sessions].sort((a, b) => (b.used || 0) - (a.used || 0));
    const rows = list.map((s) => {
      const st = status.get(s.id) || 'checking';
      return `<li class="pc-card">
        <button class="pc-main" data-connect="${s.id}">
          <span class="pc-ico">${MONITOR_SVG}</span>
          <span class="pc-text">
            <strong>${escapeHtml(titleOf(s))}</strong>
            <small>${escapeHtml(hostOf(s.url))}${s.url === HERE ? ' · this page' : ''}</small>
          </span>
          <span class="pc-status ${st}"><i></i>${STATUS_TEXT[st]}</span>
        </button>
        <button class="pc-more" data-more="${s.id}" aria-label="Options for ${escapeHtml(titleOf(s))}">
          <svg viewBox="0 0 24 24"><path d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>
        </button>
      </li>`;
    });
    // PC yang menyajikan halaman ini belum dipasangkan: tawarkan langsung
    if (!sessions.some((s) => s.url === HERE)) {
      rows.unshift(`<li class="pc-card new">
        <button class="pc-main" data-pair-here>
          <span class="pc-ico">${MONITOR_SVG}</span>
          <span class="pc-text"><strong>This PC</strong><small>${escapeHtml(location.host)} · this page</small></span>
          <span class="pc-status pair"><i></i>Tap to pair</span>
        </button>
      </li>`);
    }
    sessionList.innerHTML = rows.join('');
    const n = sessions.length;
    $('homeSub').textContent = n ? `${n} PC${n > 1 ? 's' : ''} saved on this phone. Pick one to control.` : 'No PCs yet. Pair this PC or add another one.';
  }

  async function checkSession(s) {
    if (blockedByHttps(s.url)) return 'blocked';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const res = await fetch(`${s.url}/api/check`, { headers: { authorization: `Bearer ${s.token}` }, signal: ctrl.signal, cache: 'no-store' });
      if (res.status === 401) return 'unpaired';
      if (!res.ok) return 'offline';
      const data = await res.json().catch(() => ({}));
      if (data.pc && data.pc !== s.pc) { s.pc = data.pc; saveSessions(); }
      return 'online';
    } catch {
      return 'offline';
    } finally {
      clearTimeout(timer);
    }
  }

  let refreshing = 0;
  function refreshStatuses() {
    const run = ++refreshing;
    sessions.forEach((s) => status.set(s.id, 'checking'));
    renderHome();
    sessions.forEach(async (s) => {
      const st = await checkSession(s);
      if (run !== refreshing || homeScreen.classList.contains('hidden')) return;
      status.set(s.id, st);
      renderHome();
    });
  }

  sessionList.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.hasAttribute('data-pair-here')) return showPair({ url: HERE });
    const s = findSession(btn.dataset.connect || btn.dataset.more);
    if (!s) return;
    if (btn.dataset.more) return openPcSheet(s);
    if (status.get(s.id) === 'unpaired') return showPair({ session: s });
    openSession(s);
  });

  $('addPcBtn').addEventListener('click', () => showPair());
  $('refreshBtn').addEventListener('click', refreshStatuses);
  $('pairBackBtn').addEventListener('click', showHome);

  // ---- aksi satu PC (ganti nama, pairing ulang, hapus)
  const pcSheet = $('pcSheet');
  let sheetSession = null;

  function openPcSheet(s) {
    sheetSession = s;
    $('pcSheetTitle').textContent = titleOf(s);
    $('pcSheetUrl').textContent = `${s.url}${s.pc ? ` · ${s.pc}` : ''}`;
    $('pcLabel').value = s.label || '';
    $('pcLabel').placeholder = s.pc || 'e.g. Office laptop';
    pcSheet.classList.remove('hidden');
    pcSheet.setAttribute('aria-hidden', 'false');
  }

  function closePcSheet() {
    if (sheetSession) {
      const label = $('pcLabel').value.trim().slice(0, 40);
      if (label !== (sheetSession.label || '')) {
        sheetSession.label = label;
        saveSessions();
        renderHome();
      }
    }
    sheetSession = null;
    pcSheet.classList.add('hidden');
    pcSheet.setAttribute('aria-hidden', 'true');
  }

  pcSheet.querySelector('[data-close]').addEventListener('click', closePcSheet);
  $('pcLabel').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); closePcSheet(); } });
  $('pcConnectBtn').addEventListener('click', () => {
    const s = sheetSession;
    closePcSheet();
    if (s) openSession(s);
  });
  $('pcRepairBtn').addEventListener('click', () => {
    const s = sheetSession;
    closePcSheet();
    if (s) showPair({ session: s });
  });
  $('pcRemoveBtn').addEventListener('click', () => {
    const s = sheetSession;
    if (!s || !confirm(`Remove ${titleOf(s)} from this phone? You will need its pairing code to connect again.`)) return;
    closePcSheet();
    removeSession(s);
    renderHome();
  });

  // Hapus dari HP dan (bila terjangkau) dari daftar perangkat di PC tersebut
  function removeSession(s) {
    sessions = sessions.filter((x) => x.id !== s.id);
    status.delete(s.id);
    saveSessions();
    if (!blockedByHttps(s.url)) {
      fetch(`${s.url}/api/unpair`, { method: 'POST', headers: { authorization: `Bearer ${s.token}` } })
        .catch(() => { /* PC tidak terjangkau, cukup hapus lokal */ });
    }
  }

  // ================================================================ pairing
  const codeInput = $('codeInput');
  const slots = [...document.querySelectorAll('.code-slots i')];
  let pairing = false;

  function renderSlots() {
    const v = codeInput.value;
    const focused = document.activeElement === codeInput;
    slots.forEach((s, i) => {
      s.textContent = v[i] || '';
      s.classList.toggle('filled', Boolean(v[i]));
      s.classList.toggle('active', focused && i === Math.min(v.length, 5));
    });
  }

  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6);
    $('pairError').textContent = '';
    renderSlots();
    if (codeInput.value.length === 6) pair();
  });
  codeInput.addEventListener('focus', renderSlots);
  codeInput.addEventListener('blur', renderSlots);
  $('addrInput').addEventListener('input', () => { $('pairError').textContent = ''; });
  $('addrInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); codeInput.focus(); }
  });

  $('pairForm').addEventListener('submit', (e) => {
    e.preventDefault();
    pair();
  });

  async function pair() {
    if (pairing || !pairTarget) return;
    let url = pairTarget.url;
    if (!pairTarget.fixed) {
      try {
        url = normalizeUrl($('addrInput').value);
      } catch (err) {
        $('pairError').textContent = err.message;
        return;
      }
    }
    const code = codeInput.value;
    if (code.length !== 6) {
      fail('The code has 6 digits.');
      return;
    }
    if (blockedByHttps(url)) {
      fail(`This page is open over HTTPS, so your browser blocks the Wi-Fi address ${hostOf(url)}. Open OwnRemote from a Wi-Fi address (http://…) instead, or use that PC's tunnel address.`);
      return;
    }
    pairing = true;
    $('pairBtn').disabled = true;
    $('pairBtn').textContent = 'Connecting…';
    try {
      const res = await fetch(`${url}/api/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, name: $('nameInput').value.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not connect.');
      // PC yang sama (alamat sama) cukup diperbarui, bukan diduplikasi
      let s = pairTarget.session || sessions.find((x) => x.url === url);
      if (!s) {
        s = { id: newId(), url, label: '' };
        sessions.push(s);
      }
      Object.assign(s, { token: data.token, pc: data.pc || s.pc || '' });
      saveSessions();
      status.set(s.id, 'online');
      codeInput.blur();
      openSession(s);
    } catch (err) {
      fail(err instanceof TypeError
        ? (url === HERE ? "Can't reach your PC. Make sure your phone is on the same Wi-Fi."
          : `Can't reach ${hostOf(url)}. Check the address, make sure OwnRemote is running there and your phone is on the same Wi-Fi.`)
        : err.message);
    } finally {
      pairing = false;
      $('pairBtn').disabled = false;
      $('pairBtn').textContent = 'Connect';
    }

    function fail(msg) {
      $('pairError').textContent = msg;
      const field = document.querySelector('.code-field');
      field.classList.remove('shake');
      void field.offsetWidth;
      field.classList.add('shake');
      codeInput.value = '';
      renderSlots();
    }
  }

  // ================================================================ pilih / tinggalkan PC
  function openSession(s) {
    leaveSession({ quiet: true });
    active = s;
    s.used = Date.now();
    saveSessions();
    tabStore.set(CURRENT_KEY, s.id);
    applyNetworkDefaults(s.url);
    $('deviceInfo').textContent = '';
    setConn('', 'Connecting…');
    showPad();
    retry = 0;
    connect();
  }

  // Putus dari PC aktif. quiet = langsung pindah ke PC lain tanpa membuka dashboard.
  function leaveSession({ quiet = false } = {}) {
    autoReconnect = false;
    clearTimeout(retryTimer);
    clearTimeout(pongTimer);
    if (screenOn) setScreen(false);
    const sock = ws;
    ws = null;
    if (sock) sock.close(1000, 'Switched PC');
    resetInputState();
    active = null;
    tabStore.del(CURRENT_KEY);
    hideOverlay();
    closeSheet();
    if (!quiet) showHome();
  }

  $('homeBtn').addEventListener('click', () => leaveSession());
  $('overlayHomeBtn').addEventListener('click', () => leaveSession());

  // ================================================================ koneksi
  function connect() {
    clearTimeout(retryTimer);
    if (!active) return showHome();
    if (ws && ws.readyState <= 1) return;
    autoReconnect = true;
    setConn('', 'Connecting…');

    const target = active;
    const sock = new WebSocket(`${target.url.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(target.token)}`);
    ws = sock;
    sock.binaryType = 'arraybuffer'; // frame layar dikirim sebagai JPEG biner

    sock.onopen = () => {
      retry = 0;
      hideOverlay();
      setConn('on', 'Connected');
      if (screenOn) subscribeScreen();
    };

    sock.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        onScreenFrame(e.data);
        return;
      }
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === 'hello') {
        if (target.pc !== msg.pc) { target.pc = msg.pc; saveSessions(); }
        $('pcName').textContent = titleOf(target);
        $('deviceInfo').textContent = `This device is paired as "${msg.name}".`;
      } else if (msg.t === 'pong') {
        clearTimeout(pongTimer);
      } else if (['cur', 'mon', 'screen-err', 'screen-off'].includes(msg.t)) {
        onScreenMessage(msg);
      }
    };

    sock.onclose = (e) => {
      if (ws !== sock) return;
      ws = null;
      clearTimeout(pongTimer);
      resetInputState();

      if (e.code === 4001) {
        active = null;
        tabStore.del(CURRENT_KEY);
        status.set(target.id, 'unpaired');
        showPair({ session: target, message: 'This phone was removed on that PC. Enter its code again.' });
        return;
      }
      if (e.code === 4003) return stopWith('Disconnected', 'Disconnected from the PC.');
      if (e.code === 4002) return stopWith('In use elsewhere', 'This device is connected from another tab or window.');
      if (!autoReconnect) return stopWith('Disconnected', 'Connection closed.');

      setConn('off', 'Disconnected, retrying…');
      if (retry >= 3) showOverlay(`Can't connect to ${titleOf(target)}. Make sure OwnRemote is running and your phone is on the same Wi-Fi.\nRetrying…`);
      const delay = Math.min(10_000, 500 * 2 ** retry++);
      retryTimer = setTimeout(connect, delay);
    };
  }

  function stopWith(label, message) {
    autoReconnect = false;
    setConn('off', label);
    showOverlay(message);
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  $('reconnectBtn').addEventListener('click', () => {
    hideOverlay();
    retry = 0;
    connect();
  });

  // HP habis sleep: koneksi bisa "setengah mati". Cek dengan ping, sambung ulang bila perlu.
  // Preview layar dijeda saat HP dikunci / tab ditinggalkan supaya tidak boros data.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (screenOn) send({ t: 'screen', on: false });
      return;
    }
    if (!active || padScreen.classList.contains('hidden')) return;
    if (ws && ws.readyState === 1) {
      send({ t: 'ping' });
      clearTimeout(pongTimer);
      pongTimer = setTimeout(() => ws && ws.close(), 3000);
      if (screenOn) subscribeScreen();
    } else if (autoReconnect) {
      retry = 0;
      connect();
    }
  });

  // ================================================================ kirim gerakan (dibatch per frame)
  let mx = 0, my = 0, sx = 0, sy = 0, raf = 0;
  const r2 = (n) => Math.round(n * 100) / 100;

  function schedule() {
    if (!raf) raf = requestAnimationFrame(flush);
  }

  function flush() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (mx || my) {
      send({ t: 'm', x: r2(mx), y: r2(my) });
      predictMove(r2(mx), r2(my)); // virtual cursor langsung ikut bergerak
      mx = my = 0;
    }
    if (sx || sy) {
      send({ t: 's', x: r2(sx), y: r2(sy) });
      sx = sy = 0;
    }
  }

  function vibrate(ms) {
    if (settings.haptic && navigator.vibrate) navigator.vibrate(ms);
  }

  function click(b) {
    flush();
    send({ t: 'c', b });
    flashCursor(b);
    vibrate(12);
  }

  // ================================================================ trackpad
  const pad = $('touchpad');
  const strip = $('scrollStrip');
  const pts = new Map(); // touch id -> { x, y, t }
  let g = null; // gesture aktif

  function ripple(x, y) {
    const rect = pad.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = 'ripple';
    el.style.left = `${x - rect.left}px`;
    el.style.top = `${y - rect.top}px`;
    el.addEventListener('animationend', () => el.remove());
    pad.appendChild(el);
  }

  function setDragging(on) {
    $('dragBadge').classList.toggle('hidden', !on);
  }

  function cancelHold() {
    if (g && g.holdTimer) {
      clearTimeout(g.holdTimer);
      g.holdTimer = 0;
    }
  }

  function startDrag() {
    if (!g || g.mode !== 'move' || pts.size !== 1) return;
    g.holdTimer = 0;
    g.dragging = true;
    flush();
    send({ t: 'd', b: 'l' });
    setDragging(true);
    vibrate(35);
  }

  pad.addEventListener('touchstart', (e) => {
    e.preventDefault();
    $('padHint').classList.add('faded');
    const now = performance.now();
    if (!g) {
      g = { start: now, maxFingers: 0, travel: 0, mode: 'move', dragging: false, holdTimer: 0 };
      if (e.changedTouches[0].target === strip) {
        g.mode = 'strip';
        strip.classList.add('active');
      }
    }
    for (const t of e.changedTouches) {
      pts.set(t.identifier, { x: t.clientX, y: t.clientY, t: now });
      ripple(t.clientX, t.clientY);
    }
    g.maxFingers = Math.max(g.maxFingers, pts.size);

    if (g.mode === 'strip') return;
    if (pts.size >= 2 && !g.dragging) {
      g.mode = 'scroll';
      cancelHold();
    } else if (pts.size === 1 && g.mode === 'move' && !g.holdTimer && !g.dragging) {
      g.holdTimer = setTimeout(startDrag, HOLD_MS);
    }
  }, { passive: false });

  pad.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (!g) return;
    const now = performance.now();
    let sumX = 0, sumY = 0, n = 0, dt = 16;
    for (const t of e.changedTouches) {
      const p = pts.get(t.identifier);
      if (!p) continue;
      sumX += t.clientX - p.x;
      sumY += t.clientY - p.y;
      dt = Math.max(1, now - p.t);
      p.x = t.clientX;
      p.y = t.clientY;
      p.t = now;
      n++;
    }
    if (!n) return;
    const dx = sumX / n;
    const dy = sumY / n;
    g.travel += Math.hypot(dx, dy);
    if (g.holdTimer && g.travel > HOLD_MAX_TRAVEL) cancelHold();

    if (g.mode === 'move') {
      const speed = Math.hypot(dx, dy) / dt; // px per ms
      const gain = settings.sens * (1 + settings.accel * Math.min(speed, 3));
      mx += dx * gain;
      my += dy * gain;
    } else {
      // positif = scroll ke atas/kanan di Windows; natural = konten mengikuti jari
      const dir = settings.natural ? 1 : -1;
      const k = settings.scrollSpeed;
      sy += dy * k * dir;
      if (g.mode === 'scroll') sx += -dx * k * dir;
    }
    schedule();
  }, { passive: false });

  function onTouchEnd(e) {
    e.preventDefault();
    if (!g) return;
    for (const t of e.changedTouches) pts.delete(t.identifier);
    if (pts.size > 0) return;

    // semua jari sudah terangkat
    cancelHold();
    strip.classList.remove('active');
    const duration = performance.now() - g.start;
    if (g.dragging) {
      flush();
      send({ t: 'u', b: 'l' });
      setDragging(false);
    } else if (e.type === 'touchend' && g.mode !== 'strip' && duration < TAP_MAX_MS && g.travel < TAP_MAX_TRAVEL) {
      click(g.maxFingers >= 3 ? 'm' : g.maxFingers === 2 ? 'r' : 'l');
    } else {
      flush();
    }
    g = null;
  }

  pad.addEventListener('touchend', onTouchEnd, { passive: false });
  pad.addEventListener('touchcancel', onTouchEnd, { passive: false });
  pad.addEventListener('contextmenu', (e) => e.preventDefault());

  // ================================================================ tombol fisik (tekan-tahan = drag)
  const buttons = [...document.querySelectorAll('.mbtn')];
  for (const btn of buttons) {
    const b = btn.dataset.btn;
    let pointer = null;
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (pointer !== null) return;
      pointer = e.pointerId;
      try { btn.setPointerCapture(pointer); } catch { /* abaikan */ }
      btn.classList.add('down');
      flush();
      send({ t: 'd', b });
      flashCursor(b);
      vibrate(12);
    });
    const release = (e) => {
      if (pointer === null || (e && e.pointerId !== pointer)) return;
      pointer = null;
      btn.classList.remove('down');
      flush();
      send({ t: 'u', b });
    };
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('lostpointercapture', release);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    btn._reset = () => { pointer = null; btn.classList.remove('down'); };
  }

  function resetInputState() {
    buttons.forEach((b) => b._reset());
    pts.clear();
    if (g) cancelHold();
    g = null;
    setDragging(false);
    mx = my = sx = sy = 0;
    setMods(0);
  }

  // ================================================================ preview layar PC
  // Opt-in: hanya berjalan setelah tombol layar ditekan. Gambar datang sesuai fps pilihan (JPEG biner).
  // Akurasi virtual cursor:
  //  - posisi asli dari PC ~60x/detik dalam piksel fisik (DPI-aware)
  //  - saat jari menggeser trackpad, HP langsung memprediksi posisi dari delta piksel yang dikirim ke PC
  //    (tanpa menunggu jaringan), lalu kembali ke posisi asli dari PC begitu gerakan berhenti
  //  - ujung panah (hotspot) tepat di titik koordinat dan tanpa animasi transisi
  const screenBtn = $('screenBtn');
  const screenPanel = $('screenPanel');
  const stage = $('stage');
  const stageInner = $('stageInner');
  const screenImg = $('screenImg');
  const vCursor = $('vCursor');
  const screenMsg = $('screenMsg');
  const SCREEN_PRESETS = {
    saver: { label: 'Saver', fps: 2, width: 640, quality: 40 },
    normal: { label: 'Normal', fps: 5, width: 960, quality: 50 },
    sharp: { label: 'Sharp', fps: 8, width: 1280, quality: 60 },
  };
  const PRESET_CYCLE = ['saver', 'normal', 'sharp'];
  const SCREEN_WIDTHS = [640, 960, 1280, 1600, 1920];
  const ZOOMS = [1, 2, 3];
  const PREDICT_HOLD_MS = 250; // setelah gerakan terakhir, kembali memakai posisi asli dari PC
  const CURSOR_SIZE = 22; // px, sama dengan .vcursor di CSS
  const HOTSPOT = CURSOR_SIZE / 24; // ujung panah ada di (1,1) pada viewBox 24x24
  let screenOn = false;
  let screenBig = false;
  let frameUrl = null;
  let aspect = 16 / 9;
  let monitor = null; // { w, h } piksel fisik monitor yang ditampilkan
  let serverPos = null; // posisi asli dari PC, 0..1
  let predicted = null; // posisi prediksi lokal selama jari bergerak
  let predictTimer = 0;
  let cursorRaf = 0;
  let statBytes = 0;
  let statFrames = 0;
  let statTimer = 0;
  let resubTimer = 0;

  // Pengaturan lama (hanya nama preset) -> nilai fps/resolusi/kualitas
  if (!Number.isFinite(settings.screenFps)) {
    const p = SCREEN_PRESETS[settings.screenPreset] || SCREEN_PRESETS.normal;
    Object.assign(settings, { screenFps: p.fps, screenWidth: p.width, screenQuality: p.quality });
  }
  delete settings.screenPreset;
  // Dibuka lewat internet (Cloudflare Tunnel) dan belum pernah diatur: mulai dari preset Hemat supaya hemat kuota
  const isInternet = (url) => !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.)/.test(new URL(url).hostname);
  function applyNetworkDefaults(url) {
    let stored = false;
    try { stored = 'screenFps' in JSON.parse(store.get(SETTINGS_KEY) || '{}'); } catch { /* default */ }
    if (stored) return;
    const p = isInternet(url) ? SCREEN_PRESETS.saver : SCREEN_PRESETS.normal;
    Object.assign(settings, { screenFps: p.fps, screenWidth: p.width, screenQuality: p.quality });
    renderScreenSettings();
  }
  if (!ZOOMS.includes(settings.screenZoom)) settings.screenZoom = 1;

  function presetName() {
    return PRESET_CYCLE.find((k) => {
      const p = SCREEN_PRESETS[k];
      return p.fps === settings.screenFps && p.width === settings.screenWidth && p.quality === settings.screenQuality;
    }) || null;
  }

  function subscribeScreen() {
    send({ t: 'screen', on: true, fps: settings.screenFps, width: settings.screenWidth, quality: settings.screenQuality });
  }

  // Slider digeser terus-menerus: kirim ke PC sekali saja setelah berhenti
  function resubscribeSoon() {
    clearTimeout(resubTimer);
    resubTimer = setTimeout(() => { if (screenOn) subscribeScreen(); }, 300);
  }

  function setScreen(on) {
    screenOn = on;
    screenBtn.setAttribute('aria-pressed', String(on));
    screenPanel.classList.toggle('hidden', !on);
    clearInterval(statTimer);
    predicted = null;
    if (on) {
      showStageMsg('Loading screen…');
      vCursor.classList.add('hidden');
      subscribeScreen();
      statBytes = statFrames = 0;
      statTimer = setInterval(updateStats, 1000);
      $('screenStats').textContent = '';
      layoutStage();
    } else {
      send({ t: 'screen', on: false });
      if (frameUrl) URL.revokeObjectURL(frameUrl);
      frameUrl = null;
      screenImg.removeAttribute('src');
      setBig(false);
    }
  }

  function showStageMsg(text) {
    screenMsg.textContent = text;
    screenMsg.classList.toggle('hidden', !text);
  }

  function onScreenFrame(buffer) {
    if (!screenOn) return;
    statBytes += buffer.byteLength;
    statFrames++;
    const url = URL.createObjectURL(new Blob([buffer], { type: 'image/jpeg' }));
    const prev = frameUrl;
    frameUrl = url;
    const done = () => {
      if (prev) URL.revokeObjectURL(prev);
      send({ t: 'fack' }); // siap menerima frame berikutnya
    };
    screenImg.onload = () => {
      showStageMsg('');
      const ar = screenImg.naturalWidth / screenImg.naturalHeight;
      if (Math.abs(ar - aspect) > 0.001) {
        aspect = ar;
        layoutStage();
      }
      done();
    };
    screenImg.onerror = done;
    screenImg.src = url;
  }

  function onScreenMessage(msg) {
    if (msg.t === 'cur') {
      serverPos = { x: msg.x, y: msg.y };
      if (!predicted) drawCursorSoon();
    } else if (msg.t === 'mon') {
      monitor = { w: msg.w, h: msg.h };
      aspect = msg.w / msg.h; // rasio pasti dari ukuran monitor, bukan dari gambar yang dibulatkan
      layoutStage();
    } else if (msg.t === 'screen-err') {
      showStageMsg(msg.msg);
    } else if (msg.t === 'screen-off') {
      setScreen(false);
      showOverlayToast(msg.reason === 'disabled' ? 'Screen preview is turned off on the PC.' : 'Screen preview stopped.');
    }
  }

  // Dipanggil dari flush() dengan delta piksel yang baru saja dikirim ke PC
  function predictMove(dx, dy) {
    if (!screenOn || !monitor || !serverPos) return;
    const base = predicted || serverPos;
    const maxX = 1 - 1 / monitor.w;
    const maxY = 1 - 1 / monitor.h;
    predicted = {
      x: Math.min(maxX, Math.max(0, base.x + dx / monitor.w)),
      y: Math.min(maxY, Math.max(0, base.y + dy / monitor.h)),
    };
    clearTimeout(predictTimer);
    predictTimer = setTimeout(() => {
      predicted = null; // gerakan selesai: pakai posisi asli terbaru dari PC
      drawCursorSoon();
    }, PREDICT_HOLD_MS);
    drawCursorSoon();
  }

  function drawCursorSoon() {
    if (!cursorRaf) cursorRaf = requestAnimationFrame(() => { cursorRaf = 0; positionCursor(); });
  }

  function updateStats() {
    const kb = statBytes / 1024;
    $('screenStats').textContent = statFrames
      ? `${statFrames} fps · ${kb >= 100 ? Math.round(kb) : kb.toFixed(1)} KB/s`
      : 'screen idle · 0 KB/s';
    statBytes = statFrames = 0;
  }

  // Ukuran preview: selebar layar HP, tinggi maksimal ~1/3 layar (atau ~60% saat diperbesar).
  // Lebar & tinggi dihitung dari rasio monitor yang sama persis supaya koordinat cursor tidak melenceng.
  function layoutStage() {
    if (!screenOn) return;
    const avail = padScreen.clientWidth - 24;
    const maxH = padScreen.clientHeight * (screenBig ? 0.6 : 0.34);
    const w = Math.min(avail, maxH * aspect);
    stage.style.width = `${w}px`;
    stage.style.height = `${w / aspect}px`;
    stage.style.aspectRatio = 'auto';
    positionCursor();
  }

  // Virtual cursor + zoom yang mengikuti cursor (gambar di-scale, cursor tetap berukuran normal)
  function positionCursor() {
    const pos = predicted || serverPos;
    const z = settings.screenZoom;
    const rect = stage.getBoundingClientRect();
    const W = rect.width;
    const H = rect.height;
    if (!pos || !W) return;
    const inside = pos.x >= 0 && pos.x <= 1 && pos.y >= 0 && pos.y <= 1;
    vCursor.classList.toggle('hidden', !inside);
    const cx = pos.x * W;
    const cy = pos.y * H;
    let tx = 0;
    let ty = 0;
    if (z > 1) {
      tx = Math.min(0, Math.max(W - W * z, W / 2 - cx * z));
      ty = Math.min(0, Math.max(H - H * z, H / 2 - cy * z));
    }
    stageInner.style.transform = `translate(${tx}px, ${ty}px) scale(${z})`;
    // translate ke titik cursor, batalkan zoom pada ikon, lalu geser supaya UJUNG panah tepat di titik itu
    vCursor.style.transform = `translate(${cx}px, ${cy}px) scale(${1 / z}) translate(${-HOTSPOT}px, ${-HOTSPOT}px)`;
  }

  // Animasi lingkaran di ujung virtual cursor saat klik, supaya terlihat apa yang diklik
  function flashCursor(b) {
    if (!screenOn) return;
    vCursor.classList.remove('clicked', 'right');
    void vCursor.offsetWidth;
    vCursor.classList.add('clicked');
    if (b === 'r') vCursor.classList.add('right');
  }

  function setBig(big) {
    screenBig = big;
    padScreen.classList.toggle('screen-big', big);
    $('expandBtn').textContent = big ? '⤡' : '⤢';
    layoutStage();
  }

  function showOverlayToast(text) {
    setConn(ws && ws.readyState === 1 ? 'on' : 'off', text);
    setTimeout(() => { if (ws && ws.readyState === 1) setConn('on', 'Connected'); }, 3000);
  }

  // Perkiraan data maksimum (saat layar terus berubah). Layar diam = ~0 karena frame identik tidak dikirim.
  function estimateKBps() {
    const w = settings.screenWidth;
    const bitsPerPixel = 0.25 + settings.screenQuality * 0.009;
    const kbPerFrame = (w * (w * 9 / 16) * bitsPerPixel) / 8 / 1024;
    return Math.round(kbPerFrame * settings.screenFps);
  }

  function renderScreenSettings() {
    const name = presetName();
    $('zoomBtn').textContent = `Zoom ${settings.screenZoom}×`;
    $('qualityBtn').textContent = name ? SCREEN_PRESETS[name].label : `${settings.screenFps} fps`;
    $('screenFps').value = settings.screenFps;
    $('screenFpsOut').textContent = `${settings.screenFps} fps`;
    $('screenWidth').value = String(settings.screenWidth);
    $('screenQuality').value = settings.screenQuality;
    $('screenQualityOut').textContent = `${settings.screenQuality}%`;
    $('screenEstimate').textContent = `Up to ±${estimateKBps()} KB/s while the screen keeps changing · idle screen ≈ 0`;
    document.querySelectorAll('[data-screen-preset]').forEach((b) => b.classList.toggle('on', b.dataset.screenPreset === name));
  }

  function applyPreset(name) {
    const p = SCREEN_PRESETS[name];
    Object.assign(settings, { screenFps: p.fps, screenWidth: p.width, screenQuality: p.quality });
    saveSettings();
    renderScreenSettings();
    if (screenOn) subscribeScreen();
  }

  screenBtn.addEventListener('click', () => setScreen(!screenOn));
  $('zoomBtn').addEventListener('click', () => {
    settings.screenZoom = ZOOMS[(ZOOMS.indexOf(settings.screenZoom) + 1) % ZOOMS.length];
    saveSettings();
    renderScreenSettings();
    positionCursor();
  });
  // chip kualitas di bawah preview: putar preset Hemat -> Normal -> Jelas
  $('qualityBtn').addEventListener('click', () => {
    const name = presetName();
    applyPreset(PRESET_CYCLE[(PRESET_CYCLE.indexOf(name) + 1) % PRESET_CYCLE.length]);
  });
  $('expandBtn').addEventListener('click', () => setBig(!screenBig));
  stage.addEventListener('dblclick', () => setBig(!screenBig));
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('resize', layoutStage);

  // pengaturan di panel ⚙
  $('screenFps').addEventListener('input', (e) => {
    settings.screenFps = Number(e.target.value);
    saveSettings();
    renderScreenSettings();
    resubscribeSoon();
  });
  $('screenWidth').addEventListener('change', (e) => {
    settings.screenWidth = Number(e.target.value);
    saveSettings();
    renderScreenSettings();
    resubscribeSoon();
  });
  $('screenQuality').addEventListener('input', (e) => {
    settings.screenQuality = Number(e.target.value);
    saveSettings();
    renderScreenSettings();
    resubscribeSoon();
  });
  document.querySelectorAll('[data-screen-preset]').forEach((b) => {
    b.addEventListener('click', () => applyPreset(b.dataset.screenPreset));
  });
  if (!SCREEN_WIDTHS.includes(settings.screenWidth)) settings.screenWidth = 960;
  renderScreenSettings();

  // ================================================================ keyboard
  // Ketikan dikirim live dengan membandingkan isi textarea sebelum & sesudah setiap perubahan (diff).
  // Cara ini tahan terhadap autocorrect, prediksi kata, dan swipe typing: kata yang diganti keyboard HP
  // dihapus (backspace) lalu diketik ulang di PC. Textarea selalu diawali satu spasi "jangkar" supaya
  // tombol backspace tetap memicu event walaupun belum ada teks.
  const kbPanel = $('kbPanel');
  const kbInput = $('kbInput');
  const kbBtn = $('kbBtn');
  const ANCHOR = ' ';
  const MOD_CTRL = 1;
  let lastValue = ANCHOR;
  let composing = false;
  let mods = 0;

  function resetKb() {
    kbInput.value = ANCHOR;
    lastValue = ANCHOR;
    try { kbInput.setSelectionRange(ANCHOR.length, ANCHOR.length); } catch { /* belum fokus */ }
    $('kbPlaceholder').classList.remove('hidden');
  }

  function setMods(value) {
    mods = value;
    document.querySelectorAll('.kk.mod').forEach((b) => b.classList.toggle('on', (mods & Number(b.dataset.mod)) !== 0));
  }

  function sendKey(k, extraMods = 0) {
    flush();
    send({ t: 'key', k, m: mods | extraMods });
    setMods(0);
    vibrate(8);
  }

  function sendChar(c, extraMods = 0) {
    flush();
    send({ t: 'kc', c, m: mods | extraMods });
    setMods(0);
    vibrate(8);
  }

  kbInput.addEventListener('compositionstart', () => { composing = true; });
  kbInput.addEventListener('compositionend', () => { composing = false; });

  kbInput.addEventListener('input', () => {
    const now = kbInput.value;
    const before = Array.from(lastValue); // per code point, supaya emoji dihitung satu karakter
    const after = Array.from(now);
    let p = 0;
    while (p < before.length && p < after.length && before[p] === after[p]) p++;
    const removed = before.length - p;
    const added = after.slice(p).join('');
    lastValue = now;

    if (removed > 0) send({ t: 'bs', n: removed });
    if (added) {
      // modifier aktif + satu karakter = shortcut (mis. Ctrl lalu ketik "c" = Ctrl+C)
      if (mods && Array.from(added).length === 1 && added !== '\n') {
        sendChar(added);
        resetKb(); // huruf shortcut tidak ikut tersisa di kotak ketik
        return;
      }
      send({ t: 'type', s: added });
    }
    $('kbPlaceholder').classList.toggle('hidden', now !== ANCHOR);

    // mulai baris baru setelah Enter, saat jangkar terhapus, atau teks sudah panjang
    if (now === '' || added.includes('\n') || (!composing && now.length > 200)) resetKb();
  });

  function setKeyboard(open) {
    kbPanel.classList.toggle('hidden', !open);
    padScreen.classList.toggle('kb-open', open);
    kbBtn.setAttribute('aria-pressed', String(open));
    if (open) {
      resetKb();
      kbInput.focus();
    } else {
      kbInput.blur();
      setMods(0);
    }
  }

  kbBtn.addEventListener('click', () => setKeyboard(kbPanel.classList.contains('hidden')));

  // Tombol panel: aksi di pointerdown + preventDefault agar fokus tetap di textarea (keyboard HP tidak tertutup).
  // Tombol dengan data-repeat diulang selama ditahan (backspace, panah, volume).
  // Chip shortcut ada di baris yang bisa di-scroll: jalankan saat click (batal otomatis kalau jari menggeser).
  kbPanel.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('pointerdown', (e) => e.preventDefault()); // fokus tetap di textarea
    chip.addEventListener('click', () => {
      const extra = Number(chip.dataset.mods || 0);
      if (chip.dataset.key) sendKey(chip.dataset.key, extra);
      else if (chip.dataset.char) sendChar(chip.dataset.char, extra);
    });
    chip.addEventListener('contextmenu', (e) => e.preventDefault());
  });

  kbPanel.querySelectorAll('.kk').forEach((btn) => {
    let repeatTimer = 0;
    const stopRepeat = () => {
      clearTimeout(repeatTimer);
      clearInterval(repeatTimer);
      btn.classList.remove('pressed');
    };
    const fire = () => {
      const extra = Number(btn.dataset.mods || 0);
      if (btn.dataset.key) sendKey(btn.dataset.key, extra);
      else if (btn.dataset.char) sendChar(btn.dataset.char, extra);
    };
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (btn.dataset.mod) {
        setMods(mods ^ Number(btn.dataset.mod));
        vibrate(8);
        return;
      }
      btn.classList.add('pressed');
      fire();
      if ('repeat' in btn.dataset) {
        repeatTimer = setTimeout(() => { repeatTimer = setInterval(fire, 70); }, 400);
      }
    });
    btn.addEventListener('pointerup', stopRepeat);
    btn.addEventListener('pointercancel', stopRepeat);
    btn.addEventListener('pointerleave', stopRepeat);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  });

  // Ikuti tinggi area terlihat saat keyboard HP muncul (terutama iOS yang tidak mengecilkan layout)
  const vv = window.visualViewport;
  function fitViewport() {
    const h = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-h', `${Math.round(h)}px`);
    if (vv && vv.offsetTop) window.scrollTo(0, 0);
    layoutStage();
  }
  if (vv) {
    vv.addEventListener('resize', fitViewport);
    vv.addEventListener('scroll', fitViewport);
  }
  window.addEventListener('resize', fitViewport);
  fitViewport();

  // ================================================================ pengaturan
  const sheet = $('sheet');
  const openSheet = () => { sheet.classList.remove('hidden'); sheet.setAttribute('aria-hidden', 'false'); };
  const closeSheet = () => { sheet.classList.add('hidden'); sheet.setAttribute('aria-hidden', 'true'); };
  $('settingsBtn').addEventListener('click', openSheet);
  sheet.querySelector('[data-close]').addEventListener('click', closeSheet);

  const saveSettings = () => store.set(SETTINGS_KEY, JSON.stringify(settings));

  function bindRange(id, outId, key, fmt) {
    const input = $(id);
    const out = $(outId);
    input.value = settings[key];
    out.textContent = fmt(settings[key]);
    input.addEventListener('input', () => {
      settings[key] = Number(input.value);
      out.textContent = fmt(settings[key]);
      saveSettings();
    });
  }

  function bindToggle(id, key) {
    const input = $(id);
    input.checked = Boolean(settings[key]);
    input.addEventListener('change', () => {
      settings[key] = input.checked;
      saveSettings();
    });
  }

  bindRange('sens', 'sensOut', 'sens', (v) => `${v.toFixed(1)}×`);
  bindRange('accel', 'accelOut', 'accel', (v) => (v === 0 ? 'off' : v.toFixed(1)));
  bindRange('scrollSpeed', 'scrollOut', 'scrollSpeed', (v) => `${v}`);
  bindToggle('natural', 'natural');
  bindToggle('haptic', 'haptic');

  const canFullscreen = Boolean(document.documentElement.requestFullscreen);
  $('fullscreenBtn').classList.toggle('hidden', !canFullscreen);
  $('fullscreenBtn').addEventListener('click', () => {
    closeSheet();
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  });

  $('disconnectBtn').addEventListener('click', () => leaveSession());

  $('forgetBtn').addEventListener('click', () => {
    const s = active;
    if (!s || !confirm(`Forget ${titleOf(s)}? You will need its pairing code to connect again.`)) return;
    removeSession(s); // unpair dulu selagi koneksi masih hidup
    leaveSession();
  });

  // ================================================================ mulai
  const hashCode = (location.hash.match(/code=(\d{6})/) || [])[1];
  if (location.hash) history.replaceState(null, '', location.pathname);

  const resume = findSession(tabStore.get(CURRENT_KEY));
  if (hashCode) {
    // QR dari CLI membawa kode pairing PC ini
    showPair({ url: HERE });
    codeInput.value = hashCode;
    renderSlots();
    pair();
  } else if (resume) {
    openSession(resume);
  } else if (!sessions.length) {
    showPair({ url: HERE });
  } else {
    showHome();
  }
})();
