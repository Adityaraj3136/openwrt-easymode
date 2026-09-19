# OpenWrt EasyMode

A friendly management interface for OpenWrt routers — available as a **Node.js web app (PC)** and a **native Android app**. Switch between Router, Access Point, Wireless Repeater, and Hotspot modes, manage Wi-Fi, DHCP, bandwidth, diagnostics, and system settings — without touching bridges, firewall zones, or ubus directly.

---

## Table of Contents

- [Architecture](#architecture)
- [Features](#features)
- [PC Version (Node.js)](#pc-version-nodejs)
  - [Requirements](#requirements)
  - [Installation](#installation)
  - [Configuration](#configuration)
  - [Auto-start on Windows](#auto-start-on-windows)
- [Android App](#android-app)
  - [How it works](#how-it-works)
  - [Building the APK](#building-the-apk)
  - [APK Signing](#apk-signing)
  - [Installing the APK](#installing-the-apk)
  - [Session & Persistence](#session--persistence)
- [Router Setup (Required for both versions)](#router-setup-required-for-both-versions)
- [Dependencies](#dependencies)
  - [PC Version](#pc-version-dependencies)
  - [Android App](#android-app-dependencies)
- [Limitations](#limitations)
- [Known Issues](#known-issues)
- [Security Notes](#security-notes)
- [Project Structure](#project-structure)

---

## Architecture

```
┌─────────────────────────────────────────┐
│  PC Version                             │
│  Node.js (Express) on port 8787         │
│  Browser → localhost:8787 → Router ubus │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│  Android App                            │
│  Kotlin + NanoHTTPD on port 8080        │
│  WebView → localhost:8080 → Router ubus │
│  Runs as a Foreground Service           │
└─────────────────────────────────────────┘

Both versions share the same frontend (HTML/CSS/JS in frontend/)
and talk to the same OpenWrt ubus JSON-RPC endpoint.
```

The two codebases are **completely independent**. The PC version uses Node.js. The Android app uses Kotlin + NanoHTTPD and bundles the frontend as Android assets. Changes to `frontend/` are manually synced to the Android assets folder before each build.

---

## Features

| Section | PC | Android |
|---|---|---|
| Dashboard (system, network, Wi-Fi, mode) | ✅ | ✅ |
| Mode switching (Router / AP / Repeater) | ✅ | ✅ |
| Wi-Fi management (SSID, password, channel) | ✅ | ✅ |
| Wi-Fi scanning | ✅ | ✅ |
| DHCP settings & reservations | ✅ | ✅ |
| DNS server configuration | ✅ | ✅ |
| Client blocking (MAC firewall rule) | ✅ | ✅ |
| LAN IP / netmask configuration | ✅ | ✅ |
| Diagnostics (ping, traceroute) | ✅ | ✅ |
| System overview & reboot | ✅ | ✅ |
| Bandwidth monitoring (live bytes/sec) | ✅ | ✅ |
| Dark mode | ✅ | ✅ |
| IPv4 only (IPv6 removed) | ✅ | ✅ |
| Router password change | ✅ | ❌ Not yet |
| Auto-reboot scheduling | ✅ | ❌ Not yet |
| System backup / restore | ✅ | ❌ (blocked by Android sandbox) |
| Demo mode (simulated router) | ✅ | ❌ |

---

## PC Version (Node.js)

### Requirements

- **Node.js** v18 or later
- Router running **OpenWrt** with `uhttpd-mod-ubus` and `rpcd` installed
- PC on the **same network** as the router

### Installation

```bash
# 1. Clone the repo
git clone https://github.com/Adityaraj3136/openwrt-easymode.git
cd openwrt-easymode

# 2. Install dependencies
npm install

# 3. Start the server
npm start
# Opens at http://127.0.0.1:8787
```

Open `http://127.0.0.1:8787` in your browser, enter the router's IP, username (`root`), and password.

### Configuration

Copy and edit the example config:

```bash
cp config/easymode.env.example .env
```

| Variable | Default | Purpose |
|---|---|---|
| `EASYMODE_PORT` | `8787` | Listen port |
| `EASYMODE_BIND` | `127.0.0.1` | Listen address (`0.0.0.0` to expose on LAN) |
| `EASYMODE_DEFAULT_ROUTER` | `192.168.1.1` | Pre-filled router IP on login page |
| `EASYMODE_ROUTER_SCHEME` | `http` | Use `https` if router has TLS |
| `EASYMODE_DEMO` | `1` | Set to `0` to hide the demo login button |

### Auto-start on Windows

To start the server automatically when Windows boots:

1. Create `start-easymode.bat`:
```bat
@echo off
cd /d "E:\Website html\claude Projects\noteshub"
node backend/server.js
```

2. Press `Win+R` → type `shell:startup` → press Enter
3. Place a shortcut to `start-easymode.bat` in that folder

Or use **Task Scheduler** → Create Basic Task → trigger "At startup" → action "Start a program" → point to `node.exe` with arguments `backend/server.js`.

---

## Android App

### How it works

The Android app embeds:
- A **NanoHTTPD HTTP server** (runs on `localhost:8080` as a Foreground Service)
- A full-screen **WebView** pointing to `http://localhost:8080/`
- The entire **frontend** (HTML/CSS/JS) bundled as Android assets
- A **Kotlin ubus client** (OkHttp) that talks directly to the router

No internet connection is required. The app talks to the router over local Wi-Fi only.

```
Phone → WebView → localhost:8080 (NanoHTTPD) → 192.168.x.1 (Router ubus)
```

### Building the APK

The APK is built automatically via **GitHub Actions** on every push to `main`.

1. Go to your repo on GitHub
2. Click **Actions** tab
3. Click the latest **Android CI** workflow run
4. Download **EasyMode-APK** from the Artifacts section

The APK is a **release build** (not debug) and is self-signed by the CI.

#### Manual build (optional)

Requires Android Studio with SDK 36 and JDK 17:

```bash
# Sync frontend assets first (REQUIRED before every build)
Copy-Item -Path "frontend\*" -Destination "android-app\app\src\main\assets\frontend\" -Recurse -Force

cd android-app
./gradlew assembleRelease
# Output: app/build/outputs/apk/release/app-release.apk
```

### APK Signing

> **Important:** The APK is signed automatically by GitHub Actions CI. No manual keystore setup is needed.

**How the signing works:**

The CI generates a release keystore on every build using `keytool` with a **fixed Distinguished Name (DN)**:

```
CN=EasyMode, OU=Android, O=Personal, L=IN, ST=IN, C=IN
Password: EasyMode2025!
Alias: easymode
```

Because the DN and password are always the same, the generated keystore produces a **consistent signing identity** across all builds. This means:

- ✅ You can install updates without uninstalling the previous version
- ✅ No keystore file to manage or back up
- ✅ Builds are reproducibly signed

> **Note:** If you fork this repo, the signing identity will be identical. This is intentional for a personal/private project. For a public release, replace the hardcoded credentials in `.github/workflows/android.yml` with GitHub Secrets.

**If you want to add proper secret-based signing:**

1. Generate a keystore: `keytool -genkey -v -keystore release.jks -alias mykey -keyalg RSA -keysize 2048 -validity 10000`
2. Convert to base64: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("release.jks")) | Out-File key_b64.txt`
3. Add 4 GitHub Secrets: `KEYSTORE_BASE64`, `KEY_ALIAS`, `KEY_PASSWORD`, `STORE_PASSWORD`
4. Update `android.yml` to use `${{ secrets.* }}` variables instead of hardcoded values

### Installing the APK

1. On your Android phone, go to **Settings → Apps → Special app access → Install unknown apps**
2. Allow your file manager or Chrome to install APKs
3. Transfer the downloaded APK to your phone (via USB, WhatsApp, email, etc.)
4. Tap the APK file to install

> **First install:** If you previously had the debug version installed, uninstall it first (debug and release APKs have different signing identities). After the first swap, all future updates install cleanly without uninstalling.

### Session & Persistence

The Android app stores the following in `SharedPreferences` (survives app restarts and process kills):

| Key | What it stores |
|---|---|
| `routerIp` | Last connected router IP address |
| `sessionId` | Active ubus session token |

On app relaunch, the stored session is validated against the router. If the router session has expired (router was rebooted), the user is taken to the login screen automatically.

**Session is cleared when:**
- The user taps "Sign out"
- The phone switches to a different Wi-Fi network (detected via `BroadcastReceiver`)
- The router reboots (ubus session expires — detected on next API call)

---

## Router Setup (Required for both versions)

The app communicates with OpenWrt via **ubus JSON-RPC over HTTP**. Run these commands on the router:

```sh
opkg update
opkg install uhttpd-mod-ubus rpcd rpcd-mod-file
/etc/init.d/uhttpd restart
```

**Packages explained:**

| Package | Required | Purpose |
|---|---|---|
| `uhttpd-mod-ubus` | ✅ Yes | Exposes ubus over HTTP at `/ubus` |
| `rpcd` | ✅ Yes | RPC daemon — handles session/login |
| `rpcd-mod-file` | Optional | Enables `file/exec` for ping, traceroute |

Without `rpcd-mod-file`, diagnostics (ping/traceroute) will not work. Everything else functions normally.

**Access control:** `root` login works by default. The ubus session is authenticated on every login — the password is never stored anywhere.

---

## Dependencies

### PC Version Dependencies

| Package | Version | Purpose |
|---|---|---|
| `express` | ^4 | HTTP server and routing |
| `node-fetch` / `undici` | built-in | Proxy ubus calls to router |
| `cookie-parser` | ^1 | Session cookie handling |
| `dotenv` | ^16 | Environment config loading |

Install with `npm install`. See `package.json` for exact versions.

### Android App Dependencies

| Library | Version | Purpose |
|---|---|---|
| `nanohttpd` | 2.3.1 | Embedded HTTP server (serves frontend + bridges API calls) |
| `okhttp3` | 4.12.0 | HTTP client for ubus JSON-RPC calls to router |
| `org.json` | 20240303 | JSON parsing for ubus responses |
| `androidx.compose` (BOM) | latest | Jetpack Compose UI |
| `androidx.core.ktx` | latest | Android Kotlin extensions |
| `androidx.activity.compose` | latest | Activity/Compose integration |
| `material3` | latest | Material You UI components |

**Build requirements:**

| Tool | Version |
|---|---|
| Android SDK compileSdk | 36 |
| Android SDK minSdk | 24 (Android 7.0+) |
| Android SDK targetSdk | 36 |
| JDK | 17 |
| Gradle | 9.1.0 |
| Kotlin | 2.x (via compose compiler plugin) |

**GitHub Actions runner:** `ubuntu-latest` with `actions/setup-java@v4` (Temurin JDK 17).

---

## Limitations

### Android App

| Limitation | Reason | Workaround |
|---|---|---|
| **Backup / restore not supported** | Android sandbox prevents writing to filesystem paths that sysupgrade needs | Use LuCI (Advanced settings button in the app) |
| **CPU usage always unavailable** | Requires `rpcd-mod-file` to read `/proc/stat` — blocked by NanoHTTPD serving layer | Will show "unavailable" on dashboard |
| **Per-device bandwidth limits not implemented** | Requires `tc` (traffic control) kernel module — OpenWrt-version-dependent | Not planned |
| **Router password change not implemented** | Requires `rpc-sys` or `file/exec` with `passwd` | Use LuCI directly |
| **Auto-reboot scheduling not implemented** | Requires writing a cron entry via `file/write` ubus call | Use LuCI directly |
| **Wi-Fi channel optimization approximate** | `iwinfo scan` gives nearby channels but not interference scores | Manual channel selection via Wi-Fi settings |
| **Guest network limited** | Returns stub — full guest network requires bridge config | Use LuCI |
| **System backup returns error** | Android assets are read-only, can't stream backup file | Use LuCI |

### PC Version

| Limitation | Reason |
|---|---|
| **Must run on same machine as browser** | Bound to `127.0.0.1` by default — intentional security boundary |
| **No auto-start** | Must be manually started or set up via Task Scheduler / PM2 |
| **IPv6 disabled** | Hardcoded off — router-specific implementation was causing issues |

### Both Versions

| Limitation | Detail |
|---|---|
| **Hotspot mode not implemented** | Would require USB tethering kernel modules not present on most routers |
| **No HTTPS to router** | Communicates with router over plain HTTP (local network only — acceptable risk) |
| **uci apply rollback timer** | Mode changes have a 10-second rollback window. If the router becomes unreachable after applying, it will revert automatically |
| **Single-router only** | The app manages one router at a time. Multi-router / mesh not supported |

---

## Known Issues

| Issue | Status | Notes |
|---|---|---|
| Repeater mode: connecting to hidden SSIDs | Not tested | Hidden network scanning not supported |
| Very large DHCP lease tables (200+ entries) | May be slow | NanoHTTPD serves JSON synchronously |
| iOS / Safari not supported | Out of scope | Android WebView only |
| Router model not shown in dashboard header if `system/board` ubus call fails | Shows IP instead | Fallback is safe |

---

## Security Notes

- **Password never stored.** The router password is sent once to `ubus session/login` and is never written to disk or memory after that.
- **Session token is HttpOnly.** The ubus session ID is stored in an `HttpOnly` cookie — inaccessible to JavaScript.
- **Local network only.** The Android app talks to `192.168.x.x` (private range) only. The PC version restricts router addresses to private ranges by default.
- **No outbound internet from the app.** Both versions make zero external network requests during normal operation (fonts are system-native, no CDN calls).
- **APK signing credentials in CI YAML.** The keystore password (`EasyMode2025!`) is visible in the public `.github/workflows/android.yml`. This is intentional for a personal project — for a distribution build, move these to GitHub Secrets.
- **Cleartext HTTP to router.** `android:usesCleartextTraffic="true"` is set because router management interfaces (`http://192.168.x.x/ubus`) do not use TLS. This applies only to local private network traffic.

---

## Project Structure

```
openwrt-easymode/
│
├── frontend/                    # Shared web UI (HTML/CSS/JS)
│   ├── index.html               # Entry point
│   ├── css/
│   │   ├── app.css              # Design tokens, layout, components, dark mode
│   │   └── mobile.css          # Mobile-specific overrides, bottom nav
│   └── js/
│       ├── app.js               # Shell, routing, nav, session
│       ├── api.js               # API client (fetch wrapper)
│       ├── ui.js                # Shared UI components (el, badge, panel...)
│       ├── icons.js             # SVG icon factory
│       └── views/
│           ├── login.js         # Login page
│           ├── dashboard.js     # Dashboard (system/network/wifi overview)
│           ├── mode.js          # Mode setup wizard
│           ├── wifi.js          # Wi-Fi management
│           ├── dhcp.js          # DHCP / LAN / device management
│           ├── bandwidth.js     # Bandwidth monitor
│           ├── diagnostics.js   # Ping / traceroute
│           └── system.js        # System info / reboot / backup
│
├── backend/                     # PC version — Node.js server
│   ├── server.js                # Express entry point
│   ├── routes/                  # API route handlers
│   │   ├── auth.js
│   │   ├── wifi.js
│   │   ├── dhcp.js
│   │   ├── bandwidth.js
│   │   ├── diagnostics.js
│   │   └── system.js
│   └── lib/
│       ├── ubus.js              # ubus JSON-RPC client
│       ├── uci.js               # UCI helper
│       ├── status/              # Dashboard data aggregators
│       └── modes/               # Mode switching logic (router/ap/repeater)
│
├── android-app/                 # Android app — completely separate codebase
│   └── app/src/main/
│       ├── AndroidManifest.xml  # Permissions: INTERNET, WIFI, FOREGROUND_SERVICE
│       ├── assets/frontend/     # Synced copy of frontend/ (sync before every build)
│       └── java/com/example/easymode/
│           ├── MainActivity.kt  # Activity: starts service, WebView, back button
│           ├── EasyModeService.kt # Foreground service: keeps NanoHTTPD alive
│           ├── EasyModeServer.kt  # NanoHTTPD server: all 30+ API endpoints
│           └── UbusClient.kt    # OkHttp ubus JSON-RPC client
│
├── .github/workflows/
│   └── android.yml              # CI: generates keystore, builds signed release APK
│
├── config/
│   └── easymode.env.example     # PC version environment variable template
│
├── docs/
│   └── architecture.md          # Detailed design decisions and failure modes
│
└── package.json                 # PC version Node.js dependencies
```

### Syncing frontend to Android

**Every time you edit `frontend/`**, run this before committing:

```powershell
Copy-Item -Path "frontend\*" -Destination "android-app\app\src\main\assets\frontend\" -Recurse -Force
```

The GitHub Actions CI does **not** do this automatically — the synced files must be committed to the repo.

---

## Quick Reference

### Android app — common operations

| Task | How |
|---|---|
| Get latest APK | GitHub → Actions → latest run → Artifacts → EasyMode-APK |
| First install | Uninstall old APK first if switching from debug → release |
| App stuck / can't connect | Force-close app → reopen (foreground service restarts automatically) |
| Switch Wi-Fi networks | App detects change and asks you to log in again |
| Router rebooted | Log in again (ubus session expires with router reboot) |
| Advanced settings | Tap account icon → "Advanced settings" (opens LuCI in browser) |

### PC version — common operations

| Task | How |
|---|---|
| Start server | `npm start` in project root |
| Change port | Set `EASYMODE_PORT=9000` in `.env` |
| Expose on LAN | Set `EASYMODE_BIND=0.0.0.0` in `.env` |
| Run checks | `npm run check` |
