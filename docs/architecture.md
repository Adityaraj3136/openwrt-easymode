# OpenWrt EasyMode — architecture

## Layering

```
Browser (frontend/)            plain ES modules, no build step
        │  fetch /api/*, cookie session, X-EasyMode header
        ▼
EasyMode backend (backend/)    Node + Express, holds the router session
        │  JSON-RPC POST http://<router>/ubus
        ▼
uhttpd-mod-ubus → rpcd (ACL)   router-agent/acl.d/easymode-{read,write}.json
        ▼
ubus objects: system, network.interface, network.device, network.wireless,
              iwinfo, uci, file  →  netifd, hostapd, dnsmasq, firewall4
```

The browser never speaks to the router. It never receives the router password back,
and the ubus session token stays in backend memory.

## Why a backend at all

* The ubus session token never reaches the browser; only an opaque `httpOnly` cookie does.
* The frontend can only trigger the named operations in `backend/routes/`, never an
  arbitrary `object.method`. There is no shell-exec path exposed to the browser.
* Router addresses are validated and restricted to private ranges, so the backend
  cannot be used as a general-purpose proxy.

## Directory map

| Path | Responsibility |
|---|---|
| `backend/server.js` | Express wiring, static hosting |
| `backend/config.js` | Environment-driven settings |
| `backend/lib/ubus.js` | JSON-RPC client, ubus status codes, `call`/`tryCall`/`listObjects` |
| `backend/lib/session.js` | Server-side session store, ubus client factory |
| `backend/lib/host.js` | Router address validation + reachability probe |
| `backend/lib/capabilities.js` | One-shot feature detection at login |
| `backend/lib/wireless.js` | Radio/interface normalization (band labels, STA uplink) |
| `backend/lib/derive.js` | Pure derivations (mode detection, CPU delta, lease parsing) |
| `backend/lib/net.js` | IPv4 maths: subnet overlap, safe-LAN and management-address selection |
| `backend/lib/probe.js` | DHCP lease waiting, address-in-use and reachability probes |
| `backend/lib/modes/shared.js` | Wi-Fi staging, LAN-bridge port add/remove, carrier scan |
| `backend/lib/validate.js` | Input validation for everything the browser sends |
| `backend/lib/uci.js` | UCI writer: stage, apply-with-rollback, confirm, section helpers |
| `backend/lib/backup.js` | Config snapshot and restore |
| `backend/lib/apply.js` | Commit → reconnect → verify → confirm, shared by every page that writes |
| `backend/lib/dhcp.js` | Range planning, reservations, lease reading |
| `backend/lib/bandwidth.js` | Counter sampling, accounting output, SQM limits |
| `backend/lib/wifi-config.js` | Per-radio capabilities and settings |
| `backend/lib/modes/engine.js` | Staged mode-change job runner, reconnect, recovery |
| `backend/lib/modes/*.js` | One file per mode: preflight, staging, verification |
| `backend/lib/status/*` | System, network, connectivity, mode, dashboard composition |
| `backend/routes/*` | HTTP surface |
| `frontend/js/*` | Views, API client, DOM helpers |
| `router-agent/` | rpcd ACL + on-router installer |
| `scripts/check.mjs` | Runnable assertions for the pure logic |

`lib/derive.js` is deliberately I/O-free so the tricky parts (mode detection, CPU
sampling, lease parsing) are checkable without a router.

## API surface (phases 1–2)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/auth/config` | Default router address for the login form |
| `POST` | `/api/auth/login` | `{host, username, password}` → session cookie + capabilities |
| `GET` | `/api/auth/session` | Current session, 401 when expired |
| `POST` | `/api/auth/logout` | Destroys the ubus session too |
| `GET` | `/api/status` | Whole dashboard payload |
| `GET` | `/api/system`, `/api/network`, `/api/wifi` | Individual slices |
| `GET` | `/api/mode` | Current mode, per-mode availability, form defaults, WAN preflight |
| `POST` | `/api/mode/router` | Validated Router Mode options → background job |
| `POST` | `/api/mode/ap` | Validated Access Point options → background job |
| `POST` | `/api/mode/repeater`, `/api/mode/hotspot` | Validated wireless-uplink options → background job |
| `GET` | `/api/wifi` | Radios with live state and per-radio hardware capabilities |
| `GET` | `/api/wifi/scan?radio=` | Nearby access points, joinable names, per-channel congestion |
| `GET` | `/api/wifi/clients` | Connected wireless devices |
| `POST` | `/api/wifi/radio/:id` | Validated radio settings, applied with rollback |
| `GET` | `/api/dhcp` | Server state, range, leases, reservations, mode lock |
| `POST` | `/api/dhcp` | Range, lease time, DNS, enable/disable |
| `POST` | `/api/dhcp/reservations` | Reserve an address for a device |
| `DELETE` | `/api/dhcp/reservations/:section` | Remove a reservation |
| `POST` | `/api/dhcp/blocked` | Stop a device reaching the internet |
| `DELETE` | `/api/dhcp/blocked/:mac` | Let it back on |
| `GET` | `/api/bandwidth` | Live rates, per-device usage, limits, capability reasons |
| `POST` | `/api/bandwidth/limits` | Whole-connection speed limit via SQM |
| `GET` | `/api/system/overview` | Router details plus detected capabilities |
| `GET` | `/api/system/backup` | JSON snapshot of the managed configs |
| `POST` | `/api/system/restore` | Validated backup, applied with rollback |
| `POST` | `/api/system/reboot` | Restart the router |
| `GET` | `/api/mode/job/:id` | Step-by-step progress, result and recovery status |

Later phases add the remaining write operations (`set_access_point_mode`,
`update_wifi`, `add_static_lease`, …) as equally narrow, validated endpoints.

## Login sequence

1. Validate the address (format + private range).
2. `GET http://<host>/` — separates "unreachable" from "wrong password".
3. `session.login` over ubus — a `PERMISSION_DENIED` here means bad credentials.
4. `system board` — the firmware must report OpenWrt/LEDE, otherwise refuse.
5. Detect capabilities.
6. Store the session server-side, return an `httpOnly` cookie.

## Capability detection

`ubus list` plus a handful of probes decide what the UI may show:

* Ethernet ports and their carrier state (`network.device status`).
* WAN/LAN interfaces (`network.interface dump`).
* Radios and bands — derived from the live frequency first, then `band`/`hwmode`,
  never from the name `radio0`/`radio1`.
* `rpcd-mod-file` read access → CPU usage and DHCP lease counts; without it those
  cards say the data is unavailable instead of inventing numbers.
* `sqm` config presence → whether the Bandwidth page (phase 9) can do anything.

## Mode detection

A wireless repeater and a phone-hotspot uplink are the same configuration on the
wire, so EasyMode records its own intent in `uci easymode.state.mode` when it applies
a mode (from phase 3). Detection rules, in order:

1. A wireless STA interface exists → `repeater` (refined to `hotspot` by stored intent).
2. WAN is up on an Ethernet device → `router`.
3. LAN DHCP is disabled → `ap`.
4. Otherwise `unknown` — shown as "Custom setup" rather than guessed.

Stored intent never overrules what the router is actually doing; the payload exposes
`detected`, `storedMode` and `matchesStored` so drift is visible.

The uplink interface is chosen with the LAN explicitly excluded. In Access Point mode
the LAN carries the default route to the main router, and counting that as a WAN would
make an access point report itself as a router.

## WAN vs internet

`network.wan.up` says the link is configured and up. Internet reachability is a
separate ping through `file exec` (`/bin/ping`, allow-listed in the ACL). Without
that permission the payload reports `online: null`, `method: "heuristic"` and an
explanation — it never claims a connection it did not test.

## Applying a mode safely (phase 3+)

Every mode change runs through `lib/modes/engine.js` as a background job the frontend
polls. The order is deliberate:

1. **Snapshot** `network`, `wireless`, `dhcp`, `firewall` (`lib/backup.js`).
2. **Preflight** — refuse early on a missing WAN port or an unplugged cable.
3. **Stage** all UCI changes; nothing is committed yet, so an error here costs nothing.
4. **Apply** with `uci apply {rollback:true, timeout:90}`. This is OpenWrt's own
   anti-lockout mechanism: without a `uci confirm` within the timeout, the router
   restores the previous configuration on its own — including when the mistake is bad
   enough that EasyMode can never talk to it again.
5. **Reconnect** — if the LAN address changed, the backend follows the router to its
   new address (the ubus token stays valid) and updates the session.
6. **Verify** — poll for a WAN address, check for a LAN/WAN subnet clash, then test the
   internet. Verification failure is treated as failure, not success.
7. **Confirm** on success, or `uci rollback` + snapshot restore on failure.

The two failure modes are covered separately: *router unreachable* is handled by the
router's timer, *router reachable but the configuration is wrong* by the explicit
rollback. Job objects carry a `recovery` message saying which one ran.

Mode plans (`lib/modes/router.js`) only supply `preflight`, `stageNetwork`,
`stageWifi` and `verify`. Access Point, Repeater and Hotspot plug into the same engine.

### Router Mode specifics

* WAN port from UCI → `/etc/board.json` → name guess, in that order.
* `auto` (DHCP), `pppoe` (with credentials) or `static`; options from the previous
  protocol are deleted rather than left behind.
* LAN gets a static address, the DHCP server is enabled, `wan` firewall zone gets
  `masq`, and `lan → wan` forwarding is created if missing.
* A static WAN in the LAN's range moves the LAN to a free one (`lib/net.js`); a DHCP
  lease that clashes fails verification with the suggested replacement, rather than
  silently leaving a broken router.

## Safety invariants

These hold in every phase. Anything that would break one is a bug, not a trade-off.

1. **No arbitrary execution from the browser.** The frontend picks from named
   operations; it never names a ubus object, a UCI path or a shell command.
2. **Nothing is committed before it is fully staged.** A validation error costs nothing.
3. **Every write goes through the rollback timer** (`uci apply` + `confirm`), so a
   change that loses contact with the router undoes itself.
4. **Never two DHCP servers on one network.** AP mode disables the local one and the
   DHCP page refuses to re-enable it without an explicit advanced override.
5. **Never the same subnet on both sides of the router.** Checked before applying and
   again after the uplink gets its address.
6. **Never claim unverified facts.** If the router cannot be asked, the UI says the
   value is unavailable and why.
7. **LuCI stays reachable.** No mode removes the web interface or its firewall rule.
8. **Destructive actions are confirmed** and, where possible, reversible.

## Roadmap

Phases 1–3 are built. The rest are planned below in enough detail to implement
directly: each lists what it changes on the router, how it is verified, and how it
fails safely. Every mode phase reuses `lib/modes/engine.js` and only supplies
`preflight`, `stageNetwork`, `stageWifi` and `verify`.

### Phase 1 — Authentication and router communication ✅

Delivered: `lib/ubus.js`, `lib/session.js`, `lib/host.js`, `lib/capabilities.js`,
`routes/auth.js`, login screen.

### Phase 2 — Dashboard with real router data ✅

Delivered: `lib/status/*`, `lib/wireless.js`, `lib/derive.js`, dashboard view with
router info, health, WAN, LAN, per-radio Wi-Fi and current mode.

### Phase 3 — Router Mode ✅

Delivered: `lib/modes/engine.js`, `lib/modes/router.js`, `lib/backup.js`, `lib/uci.js`,
`lib/net.js`, `lib/validate.js`, Mode Setup page with staged progress.

### Phase 4 — Access Point Mode ✅

Delivered: `lib/modes/ap.js`, `lib/modes/shared.js`, `lib/probe.js`,
`pickManagementAddress()` in `lib/net.js`, AP wizard in the Mode Setup page.

**Goal:** the router hangs off an existing router by cable and only adds Wi-Fi and
ports. The main router keeps handing out addresses.

**Preflight**

* An Ethernet port with carrier; the user says whether the cable went into the WAN
  port or a LAN port, prefilled from which ports actually have link.
* Detect the upstream network by asking it for an address. WAN-port uplinks reuse the
  existing `wan` interface (setting `proto dhcp` first if needed); LAN-port uplinks get
  a temporary `emprobe` interface on the LAN bridge, deleted again during staging.
  Either way the lease yields the gateway, subnet and DNS, and proves an upstream DHCP
  server exists. No lease → the wizard asks for the settings instead of guessing.

**Changes**

| Config | Change |
|---|---|
| `network` | Uplink device joined to the `br-lan` bridge ports; the `wan` interface is set to `proto none` (kept, not deleted, so Router Mode can restore it) |
| `network.lan` | `proto static`, an address inside the upstream subnet but outside its DHCP pool, `gateway` + `dns` = upstream |
| `dhcp.lan` | `ignore=1` — the local DHCP server is switched off |
| `firewall` | `lan` zone input/output/forward ACCEPT; no masquerading, since this device does not route |
| `wireless` | AP interfaces bridged to `lan`, SSID/password as chosen |

**Management address.** The leased address is only borrowed for detection; the router
then takes a fixed one from the high end of the upstream range (`.250`, `.251`, …),
clear of the gateway and of where pools normally start, and ping-verified free when
that is possible. The UI shows the new address in the result, because the user needs it
to open EasyMode again. The backend follows the move automatically.

**Leaving the mode.** Router Mode takes the uplink port back out of the LAN bridge and
clears the gateway/DNS this mode wrote onto the LAN interface, so switching back is a
complete reversal rather than a half-state.

**Verify:** the router answers at its new address; the upstream gateway responds; the
internet test passes through the main router.

**Failure:** unreachable → the rollback timer restores the previous configuration;
reachable but no upstream → explicit rollback with "the main router did not answer".

**UI:** states plainly "IP addresses are managed by your main router". The DHCP page
switches to read-only for as long as this mode is active.

### Phase 5 — Wireless Repeater Mode ✅

Delivered: `lib/modes/wireless-uplink.js`, `lib/wifi-scan.js`, `scanEncryption()` in
`lib/derive.js`, `GET /api/wifi/scan`, network-picker wizard.

**Goal:** join an existing Wi-Fi network and share it with local devices. Routed with
NAT (no `relayd`) — simpler and far more predictable.

**Preflight**

* `iwinfo scan` on the chosen radio, deduplicated by name, strongest first, with band,
  channel, security and signal bars.
* The client interface is brought up **on its own, before anything else changes**. That
  catches a wrong password while the router is still in its old working state, and it
  reveals the upstream subnet before the local network is decided.
* A single-radio router is told, in plain words, that the uplink and the local Wi-Fi
  share a channel and throughput roughly halves. Stated, not refused.

**Changes**

| Config | Change |
|---|---|
| `wireless` | New `wifi-iface` with `mode sta`, `network wwan`, chosen SSID/encryption/key |
| `network.wwan` | `proto dhcp` |
| `network.lan` | Static address in a subnet that does not clash with the upstream one |
| `dhcp.lan` | Enabled — local devices get addresses from this router |
| `firewall` | `wwan` added to the `wan` zone (masquerading on), `lan → wan` forwarding |

**Subnet clash** is the common failure here: the upstream is usually `192.168.1.0/24`
and so is the default LAN. `lib/net.js` moves the LAN to the first free range before
applying, and the UI reports the move rather than hiding it.

**Verify:** the client interface is still associated, `wwan` still has a lease, and the
internet test passes. Signal strength is reported in the result and on the dashboard.

**Failure:** no association within the timeout produces "The Wi-Fi password was not
accepted, or the network is out of range" — not a generic failure. Associated but no
lease, and associated but no internet, are separate messages again.

**Leaving other modes:** staging pulls the WAN port back out of the LAN bridge and
clears the gateway/DNS that Access Point mode wrote, so repeater is reachable from any
previous mode.

### Phase 6 — Phone Hotspot Mode ✅

Delivered: `hotspotModePlan` in `lib/modes/wireless-uplink.js`, `POST /api/mode/hotspot`,
hotspot variant of the network picker, uplink signal on the dashboard.

Same machinery as phase 5; the differences are intent and wording.

* The wizard starts by asking the user to switch the hotspot on, then scans.
* `easymode.state.mode` is stored as `hotspot`, which is the only thing that separates
  it from a repeater afterwards (identical configuration on the wire).
* Phone hotspots hand out `192.168.43.0/24` and similar ranges, so the clash check
  matters more; the LAN is moved automatically when needed.
* The local Wi-Fi keeps broadcasting — devices connect to the router as usual and are
  never asked to join the phone directly.
* The dashboard shows hotspot signal strength and flags a weak uplink.

### Phase 7 — Wi-Fi Management ✅

Delivered: `lib/wifi-config.js`, `routes/wifi.js`, `channelCongestion()` in
`lib/derive.js`, Wi-Fi page with per-radio forms and a scanner.

Radios are discovered, never assumed: `radio0` is not "the 2.4 GHz one" until the live
frequency says so.

**Per radio:** enable/disable, SSID, password, security (`psk2`, `sae-mixed`, open),
channel (including "automatic"), channel width, transmit power, hidden SSID, connected
client count. Capabilities from `iwinfo freqlist`/`hwmodes` decide which controls exist
at all — unsupported ones are hidden, not shown broken.

**Scanner:** nearby networks with signal, channel and band, plus a simple congestion
read ("busy channel — 6 networks here"). Channels are never changed silently: the user
is told what will change and that devices reconnect.

**Writes** use the same rollback timer. The consequence is stated on the page rather
than hidden: if EasyMode is reached over the Wi-Fi being renamed, the confirm never
arrives and the router restores the old settings. That is correct behaviour — a Wi-Fi
change that locks you out should undo itself — and the advice is to use a cable.

An applied change is also verified: if the radio does not come back up (a channel or
width the hardware refuses), the previous wireless configuration is restored
immediately instead of waiting for the timer.

**Passwords** are never sent to the browser. An empty password field means "keep the
current one"; only a non-empty value is written.

**Guard:** the client interface used by repeater/hotspot mode is never edited here —
the page says which network it carries and points at Mode Setup.

### Phase 8 — DHCP Management ✅

Delivered: `lib/dhcp.js`, `routes/dhcp.js`, `lib/apply.js` (shared commit helper),
Addresses page.

**Reads:** server on/off, router address, range start/end, lease time, DNS, active
leases from `/tmp/dhcp.leases` (hostname, IP, MAC, expiry) and static leases from
`config host` sections.

**Writes:** change the range and lease time, reserve an address for a device (creating
a `host` section from a lease in one click), delete a reservation, set a friendly name.

**Validation** (`planRange`, `validateReservation` — both pure, both checked): the
range must fit inside the LAN subnet, must stop short of the broadcast address, and
must never contain the router's own address. Reservations must sit on the LAN, avoid
the router, and not duplicate an IP or MAC — while still allowing an existing
reservation to be edited without clashing with itself.

**Mode awareness:** Router/Repeater/Hotspot → enabled. Access Point → the controls are
locked and the page explains that the main router is handing out addresses. The API
enforces this too: enabling DHCP in AP mode is refused unless `force: true` is sent
deliberately. That is invariant 4, held on both sides.

### Phase 9 — Bandwidth Manager ✅ (with one deliberate gap)

Delivered: `lib/bandwidth.js`, `routes/bandwidth.js`, Bandwidth page.

The only page whose usefulness depends on optional packages, so capability detection
comes first and honesty matters most.

| Feature | Needs | Status |
|---|---|---|
| Live total throughput | interface counters | Built — sampled from the uplink device, rate computed between polls |
| Per-device usage | `nlbwmon` | Built — `nlbw -c json` parsed by column name; absent package is named in the UI |
| Whole-connection speed limit | `sqm-scripts` | Built — writes an SQM `queue` for the uplink (`cake` / `piece_of_cake.qos`) |
| Per-device limits and priority | a shaping service EasyMode can configure through UCI | **Not built** — see below |

**Writes:** download/upload capacity in Mbps, stored as kbit/s on the uplink's SQM
queue, applied behind the rollback timer like everything else. Presets are offered, and
the page explains *why* setting slightly below the real line speed is what stops a
download from making everything else stutter.

**The gap, stated plainly.** Per-device limits are not implemented. SQM shapes an
interface, not a host; doing it per device needs `tc`/`nft` rules that cannot be
expressed in UCI, and exposing shell execution to do it would break invariant 1. The
page says exactly that instead of showing controls that quietly do nothing. Revisit
when a UCI-configurable per-host shaper (e.g. `qosify`) can be detected and verified on
real hardware.

**Never faked:** counters come from the kernel, per-device rows come from the
accounting service or not at all. `parseNlbwJson` returns nothing rather than guessing
when the output is unparseable or missing its counter columns.

### Phase 10 — System, backup and polish ✅

Delivered: `lib/system.js`, `routes/system.js`, System page, accessibility and shell
polish.

* **Backup:** a JSON snapshot of the configs EasyMode manages (`network`, `wireless`,
  `dhcp`, `firewall`, `sqm`), downloaded through the browser. Chosen over the router's
  `sysupgrade -b` archive because that needs shell execution plus binary file reads —
  neither of which this design grants. LuCI still offers the full archive.
* **Restore:** a backup file is untrusted input, so `validateBackup()` checks the format
  marker, rejects damaged structures, and **refuses any config outside the managed
  set** — without that, a crafted file could rewrite `rpcd` and hand out router access.
  The restore then runs through the same commit → verify → confirm path, and is undone
  if the network does not come back.
* **Reboot / Sign out / Open LuCI:** reboot behind a confirmation naming the
  consequence; LuCI linked for everything EasyMode deliberately does not cover.
* **Capability panel:** shows what this particular router supports, so "why is that
  control missing" has a visible answer.
* **Polish:** the placeholder view is gone now that every page is real; a skip link,
  `aria-current` on the active nav item, visible focus rings, `prefers-reduced-motion`
  support, and per-view document titles.

## Scanning, the way LuCI does it

A single `iwinfo scan` pass misses neighbours: the radio is busy serving clients and
catches only the beacons that happen to land in its listening windows. LuCI solves this
by keeping a cache keyed by **BSSID** and merging every pass into it. EasyMode does the
same in `lib/wifi-scan.js`, per session, with a five-minute expiry.

Two consequences, both deliberate:

* **Every access point is listed separately.** Collapsing by network name hid exactly
  what the list exists to show - two routers sharing a name usually sit on different
  channels, and that is congestion the user needs to see.
* **Hidden networks are kept and labelled**, matching LuCI, rather than silently
  dropped. They are excluded only from the join picker, where a name is required.

The joinable list (`joinable` in the payload) is the deduplicated one, used by the
repeater and hotspot wizards where the user picks a *name*, not a radio.

## Blocking a device

`lib/clients.js` writes the same UCI shape LuCI's firewall page writes for a MAC rule:

```
config rule
    option name     'easymode_block_<mac>'
    option src      'lan'
    option src_mac  '<mac>'
    option dest     '*'
    option target   'REJECT'
```

The name prefix is how EasyMode finds its own rules again without touching anything the
user wrote in LuCI. Device names are resolved from the lease list at read time rather
than stored on the rule, so the rule stays a plain firewall rule and the names stay
current.

Blocking works by refusing to **forward** traffic, so it is offered only when the router
actually routes. In access point mode traffic is bridged straight past the firewall, and
the API refuses with an explanation rather than writing a rule that would do nothing.

## Demo mode

`lib/demo-router.js` implements the `UbusClient` surface against an in-memory router:
UCI store with staged/committed layers and a working `apply`/`confirm`/`rollback`,
derived interface and wireless state, `iwinfo` scan/assoc/freqlist results, moving
byte counters, `/proc/stat`, DHCP leases and `nlbw` output.

It is wired in at exactly three seams — `clientFor()` returns it for a demo session,
`reconnect()` knows it is always reachable, and the login route builds it when the
address is `demo`. Nothing else in the codebase is aware of it, so every module runs
unchanged. That is the point: the simulation exercises the real logic rather than
standing in for it. It caught a broken mode record and a wireless-uplink counter gap
during development.

Two profiles exist. `demo` is a fully equipped router. **`demo-minimal` is a freshly
flashed one**: no `rpcd-mod-file`, no `iwinfo`, no wireless configuration, no `sqm` or
`nlbwmon`, and nothing EasyMode has ever written. It exists to prove the first-run path
on real hardware - every page must degrade with an explanation instead of breaking.

Its upstreams are chosen to hit the interesting paths: the wired main router sits on
`192.168.0.0/24`, while the neighbouring Wi-Fi shares `192.168.1.0/24` with the default
LAN, so joining it genuinely triggers the subnet move.

What it cannot do: timing, driver behaviour, hardware that refuses a channel, or a
router that stops answering mid-apply. Those still need the list below.

## Verification strategy

Two layers, because a router cannot be mocked honestly.

**Automatic (`npm run check`).** Everything derivable without a router: subnet overlap
and safe-LAN selection, mode detection including stale stored intent, CPU sampling,
lease parsing, address and option validation, UCI section helpers. Each new phase adds
its pure logic here — this is why planning code lives in `lib/net.js`, `lib/derive.js`
and `lib/validate.js` rather than inside the I/O modules.

**Manual, on hardware.** Per mode phase, in order: apply from a known-good state;
confirm the router comes back and the internet works; then deliberately break it (wrong
PPPoE password, wrong Wi-Fi key, clashing subnet, cable pulled mid-apply) and confirm
the rollback path restores service. A mode phase is not done until its failure cases
have been exercised on a real device.

## Router requirements

| Package | Needed for | Without it |
|---|---|---|
| `uhttpd-mod-ubus` | everything | EasyMode cannot connect and says so |
| `rpcd` | everything | as above |
| `rpcd-mod-file` | CPU%, lease lists, internet ping, board detection | Those specific values report themselves unavailable |
| `sqm-scripts` | phase 9 speed limits | Bandwidth controls hidden |
| traffic accounting | phase 9 per-device usage | Per-device table hidden |

## Vocabulary

The UI never shows the left column.

| OpenWrt | EasyMode |
|---|---|
| `radio0` / `radio1` | 2.4 GHz Wi-Fi / 5 GHz Wi-Fi |
| STA interface | Internet Wi-Fi |
| masquerading / NAT | Internet sharing |
| upstream DHCP | Your main router manages addresses |
| WAN interface, `proto dhcp` | Internet connection, set up automatically |
| DHCP pool | Range of addresses for your devices |
| static lease | Reserved address for this device |
| firewall zone / forwarding | (not shown — handled for the user) |
