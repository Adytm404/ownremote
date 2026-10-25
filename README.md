<div align="center">

# OwnRemote

**Control your Windows PC from your phone**: trackpad, live keyboard and an opt-in screen preview,
over your Wi-Fi or from anywhere through Cloudflare Tunnel. No app to install on the phone, no account, no native modules.

[![npm](https://img.shields.io/npm/v/ownremote?color=c6f45b&labelColor=0d0f14)](https://www.npmjs.com/package/ownremote) ![platform](https://img.shields.io/badge/platform-Windows-0d0f14?labelColor=0d0f14) [![license](https://img.shields.io/badge/license-MIT-0d0f14?labelColor=0d0f14)](https://github.com/Adytm404/ownremote/blob/main/LICENSE)

### 🚀 Install in one line

```bash
npm i -g ownremote
```

Then just type **`ownremote`** in Command Prompt, PowerShell or Windows Terminal.<br>
<sub>Requires Windows 10/11 and Node.js 18+</sub>

<a href="https://github.com/Adytm404/ownremote/blob/main/docs/ownremote-trailer.mp4"><img src="https://raw.githubusercontent.com/Adytm404/ownremote/main/docs/trailer-preview.gif" alt="OwnRemote trailer" width="820"></a>

[▶ Watch the full trailer (48 s, MP4)](https://github.com/Adytm404/ownremote/blob/main/docs/ownremote-trailer.mp4)

</div>

---

## Features

| | |
|---|---|
| 🖱️ **Trackpad** | Move, tap to click, two-finger tap for right click, two-finger scroll, hold-and-drag, physical-style Left / Middle / Right buttons. |
| ⌨️ **Live keyboard** | Everything you type appears on the PC letter by letter, including emoji, accents, autocorrect and swipe typing. Sticky Ctrl / Alt / Shift / Win, arrows, Esc, Tab, F-keys, shortcuts (Ctrl+C/V/X/Z/A/S, Alt+Tab, Win+D) and media keys. |
| 🖥️ **Screen preview** | Off by default. Turn it on to see your PC screen with a **virtual cursor** that sits exactly where the real one is (measured error ≈ 0.05 px), zoom 1× / 2× / 3× that follows the cursor, 1–15 fps, adjustable resolution and quality, and identical frames skipped so a still screen costs ≈ 0 KB/s. |
| 🧑‍💻 **CLI dashboard** | Numbered menus to run in the terminal or in the background, manage paired devices, change settings and set up the tunnel. |
| 🪟 **Windows integration** | Background mode with a tray icon, start with Windows (with an optional delay), Windows Firewall helper. |
| 🌍 **Cloudflare Tunnel** | Quick tunnel (random `*.trycloudflare.com` URL, no account) or a named tunnel on your own domain. |
| 🔐 **Pairing & sessions** | 6-digit pairing code, per-device tokens, revoke any device, lock pairing, per-IP and global brute-force limits. |

## Screenshots

<table>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/Adytm404/ownremote/main/docs/screenshots/phone-pair.png" width="190"><br><sub>Pair with a code</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/Adytm404/ownremote/main/docs/screenshots/phone-trackpad.png" width="190"><br><sub>Trackpad</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/Adytm404/ownremote/main/docs/screenshots/phone-keyboard.png" width="190"><br><sub>Live keyboard</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/Adytm404/ownremote/main/docs/screenshots/phone-screen.png" width="190"><br><sub>Screen preview</sub></td>
  </tr>
</table>

<p align="center"><img src="https://raw.githubusercontent.com/Adytm404/ownremote/main/docs/screenshots/cli-main.png" width="640" alt="CLI dashboard"></p>

<table>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/Adytm404/ownremote/main/docs/screenshots/cli-sessions.png" width="420"><br><sub>Session / device management</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/Adytm404/ownremote/main/docs/screenshots/cli-tunnel.png" width="420"><br><sub>Cloudflare Tunnel</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/Adytm404/ownremote/main/docs/screenshots/cli-advanced.png" width="420"><br><sub>Advanced settings</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/Adytm404/ownremote/main/docs/screenshots/cli-settings.png" width="420"><br><sub>Settings</sub></td>
  </tr>
</table>

<sub>Screenshots use demo data.</sub>

## Requirements

- Windows 10 or 11 (uses the built-in Windows PowerShell 5.1 and .NET Framework, nothing to compile)
- [Node.js](https://nodejs.org) 18 or newer
- A phone with a modern browser (Chrome, Safari, Samsung Internet, Firefox) on the same Wi-Fi, or anywhere with Cloudflare Tunnel
- Optional: [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) for internet access (`winget install --id Cloudflare.cloudflared`)

## Quick start

```bash
npm i -g ownremote
ownremote
```

That's it: `ownremote` opens the dashboard from any Command Prompt, PowerShell or Windows Terminal window.
Update later with `npm i -g ownremote@latest`.

<details>
<summary>Run from source instead</summary>

```bat
git clone https://github.com/Adytm404/ownremote.git
cd ownremote
npm install
npm start
```

Or double-click **`start.bat`** (it installs dependencies on the first run).

</details>

1. Choose **[1] Run in this terminal** or **[2] Run in the background**.
2. On your phone, open the address shown under **Open on phone** (or scan the QR code in *Session management*; it fills the code in for you).
3. Enter the 6-digit code. The phone is remembered, so next time it connects straight away.

If the phone cannot open the page, use **Settings → Allow port in Windows Firewall**.

## Using it

### Trackpad

| Gesture | Action |
|---|---|
| Slide one finger | Move the cursor |
| Tap | Left click |
| Two-finger tap | Right click |
| Three-finger tap | Middle click |
| Slide two fingers / the strip on the right | Scroll (vertical and horizontal) |
| Hold ~0.5 s, then slide | Drag |
| Left / Right buttons | Click; hold a button while sliding on the pad to drag |

Speed, acceleration, scroll speed, natural scrolling and haptics are in the ⚙ panel.

### Keyboard

Tap ⌨. Type in the box and the text appears on the PC live. Tap **Ctrl / Alt / Shift / Win** once, then a key or letter, for a shortcut (Ctrl, then `c` = Ctrl+C). Hold arrows, Backspace or Del to repeat.

### Screen preview

Tap 🖥. The preview only streams while it is on and pauses automatically when the phone screen turns off.

| Preset | Frames | Width | Typical data while the screen changes |
|---|---|---|---|
| Saver | 2 fps | 640 px | ≈ 30–60 KB/s |
| **Normal** (default) | 5 fps | 960 px | ≈ 100–200 KB/s |
| Sharp | 8 fps | 1280 px | ≈ 300–500 KB/s |

Fine-tune frames per second (1–15), resolution and image quality in ⚙ → *PC screen preview*. The cursor position is sent separately about 60 times a second and predicted locally while your finger moves, so the virtual cursor stays smooth even at low frame rates. When the page is opened over the internet, it starts on the saver preset.

## CLI

```text
ownremote              interactive menu
ownremote run          run the server in this terminal
ownremote start        run the server in the background
ownremote stop         stop the server
ownremote status       show status, address and pairing code
ownremote --help       all commands and the data folder
```

Main menu: run in terminal / background, session & device management, stop, and **Settings** (port, pairing code, firewall rule, server log, data folder, **Advanced settings** and **Cloudflare Tunnel**).

### Advanced settings

| Setting | What it does |
|---|---|
| Start with Windows | Runs the server in the background at every sign-in (a hidden launcher in the Startup folder) |
| Startup delay | Waits 0–600 s after sign-in, e.g. for Wi-Fi to connect |
| Show tray icon | Tray icon in background mode: address and code (click to copy), open the menu, new code, lock pairing, stop |
| Notify when a device connects | Windows notification when a phone connects or starts viewing the screen |
| Auto-lock pairing after a new device | Rejects further devices as soon as one has paired |
| Allow screen preview on phone | Turns the screen preview feature off completely |
| Reset all devices & pairing code | Every phone has to pair again |

## Cloudflare Tunnel

Use OwnRemote from mobile data or any other network, over HTTPS, without port forwarding.

- **Quick tunnel**: *Settings → Cloudflare Tunnel → Quick tunnel*. A random `https://*.trycloudflare.com` URL appears in the dashboard, the tray menu and as a QR code. A new URL can take up to a minute before it opens, and it changes every time the server starts.
- **Named tunnel** (your own domain): in the Cloudflare dashboard, *Zero Trust → Networks → Tunnels → Create a tunnel*, choose *Cloudflared*, copy the token, and add a public hostname pointing to `http://localhost:8787`. Then set the token and public URL in the CLI and pick *Named tunnel*.

OwnRemote starts and supervises `cloudflared` itself (restarting it with back-off if it exits).

## Security

- New devices need the 6-digit pairing code. After 5 wrong codes an IP is blocked for 60 s; after 20 wrong codes from any addresses within 10 minutes, pairing is blocked for 10 minutes (a new code lifts it).
- Each phone gets its own random token; only a SHA-256 hash is stored. Revoke devices any time from *Session management*.
- The admin API used by the CLI only answers on `127.0.0.1`, requires a secret token, and **rejects anything that arrives through Cloudflare or another proxy**.
- Behind the tunnel, the real client IP comes from `CF-Connecting-IP` (trusted only for connections from localhost).
- On your LAN the connection is plain HTTP, so use it on networks you trust, or use the tunnel (HTTPS). When the PC is reachable from the internet, enable **Auto-lock pairing**.
- The screen preview is off until the phone turns it on, the tray shows a notification when it starts, the CLI marks the device with `◉ screen`, and you can disable the feature entirely.

## How it works

```text
phone browser  ──HTTP + WebSocket──►  Express server (Node.js)
                                         ├─ input-helper.ps1   SetCursorPos / mouse_event / SendInput (C# via Add-Type)
                                         ├─ screen-helper.ps1  CopyFromScreen → JPEG, cursor position at ~60 Hz
                                         ├─ tray-helper.ps1    WinForms NotifyIcon (background mode)
                                         └─ cloudflared        optional tunnel
CLI (cli.js)  ──localhost admin API──►  status, sessions, settings
```

The helpers are long-running PowerShell processes that compile small C# classes at start-up, so there are no native Node modules and no Visual Studio Build Tools. They are DPI-aware per monitor, so coordinates are physical pixels even with display scaling.

## Configuration

Settings, paired devices and the log live in `%APPDATA%\OwnRemote` (`config.json`, `devices.json`, `server.log`), so updating the package keeps your phones paired. A source checkout that already has a `data/` folder keeps using it. Set `OWNREMOTE_DATA_DIR` to use another folder (for a second instance, for example). `ownremote --help` prints the folder in use.

## Troubleshooting

- **The phone cannot open the page**: allow the port in the firewall (Settings → 3). If you once pressed *Cancel* on the Node.js firewall prompt, Windows created a *Block* rule for `node.exe`; remove it in *Windows Defender Firewall → Advanced settings → Inbound Rules*. Guest Wi-Fi networks often isolate clients.
- **Input does not reach a window**: windows running as Administrator (and UAC prompts) ignore input from normal processes; run OwnRemote as Administrator to control them.
- **The screen preview says the screen cannot be captured**: Windows does not allow capturing the lock screen or a UAC prompt; it resumes when you unlock. DRM-protected video shows black.
- **The address changed**: the current address is always on the main menu and in the tray menu.

## Project structure

```text
cli.js                  CLI menus
start.bat               double-click launcher
public/                 phone web app (trackpad, keyboard, screen preview)
src/server.js           Express + WebSocket server, admin API
src/input.js            mouse & keyboard controller   (input-helper.ps1)
src/screen.js           screen streaming               (screen-helper.ps1)
src/tray.js             tray icon                      (tray-helper.ps1)
src/tunnel.js           Cloudflare Tunnel manager
src/startup.js          Start with Windows / hidden background launcher
src/daemon.js           background entry point
src/logo.js             ASCII logo
docs/                   screenshots and trailer
```


## License

[MIT](https://github.com/Adytm404/ownremote/blob/main/LICENSE)
