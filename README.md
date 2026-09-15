# OpenWrt EasyMode

A simpler way to run an OpenWrt router: pick one of four setups (Router, Access Point,
Wireless Repeater, Phone Hotspot) and see what the router is doing — without touching
bridges, firewall zones or DHCP internals.

**Current state: all ten phases built, none yet run against real hardware.** Connect to
a router, see its live state, switch it between Router, Access Point, Wireless Repeater
and Phone Hotspot, and manage Wi-Fi, addresses, bandwidth and backups.

Two deliberate gaps, documented rather than faked: per-device speed limits (phase 9)
and full `sysupgrade` archives (phase 10). Both are explained in
[docs/architecture.md](docs/architecture.md).

Before trusting this on a router you care about, work through the on-hardware
verification list in the architecture doc — especially the failure cases, where the
rollback behaviour is the whole point.

Mode changes are applied with OpenWrt's `uci apply` rollback timer: if the new settings
leave the router unreachable, it restores the previous configuration by itself within
90 seconds. If it stays reachable but the connection does not work, EasyMode rolls back
explicitly and says so.

## Run it

```bash
npm install
npm start           # http://127.0.0.1:8787
npm run check       # assertions for the mode/CPU/lease logic
```

Open the page, enter the router address, username and password.

### Demo mode

No router handy? Click **Explore with a simulated router** on the login page (or enter
`demo` as the address). A simulated OpenWrt device runs in memory: all four modes,
Wi-Fi, addresses, bandwidth and backups work, and the interface is marked as a demo
throughout.

The simulation is a swapped transport, not a second code path — the same status,
capability, mode, Wi-Fi and DHCP modules run against it, so a bug there is a bug on
real hardware too. It found two while it was being built. It is not a substitute for
testing on a router: it cannot reproduce timing, driver quirks or a device that stops
answering mid-apply.

There are two simulated routers: `demo` is fully equipped, and `demo-minimal` is a
freshly flashed one with no optional packages, used to check that every page degrades
gracefully on a first-time login.

Set `EASYMODE_DEMO=0` to remove the option entirely.

## On the router

EasyMode needs ubus over HTTP. On a stock OpenWrt install:

```sh
opkg update && opkg install uhttpd-mod-ubus rpcd rpcd-mod-file
/etc/init.d/uhttpd restart
```

`root` works immediately. For a least-privilege account instead, copy `router-agent/`
to the router and run `sh router-agent/install.sh` — it installs the ACL in
`router-agent/acl.d/` and creates an `easymode` rpcd user.

Without `rpcd-mod-file` the app still works; CPU usage, connected-device counts and the
internet ping test report themselves as unavailable.

## Settings

| Variable | Default | Purpose |
|---|---|---|
| `EASYMODE_PORT` | `8787` | Listen port |
| `EASYMODE_BIND` | `127.0.0.1` | Listen address |
| `EASYMODE_DEFAULT_ROUTER` | `192.168.1.1` | Prefilled router address |
| `EASYMODE_ROUTER_SCHEME` | `http` | `https` for routers with TLS |
| `EASYMODE_ALLOW_PUBLIC_ROUTER` | off | Allow non-private router addresses |
| `EASYMODE_INTERNET_PROBE_HOST` | `1.1.1.1` | Ping target for the internet test |

See `config/easymode.env.example`.

## Security notes

* The router password is used once to open a ubus session and is never stored.
* The ubus token lives in backend memory; the browser only gets an `httpOnly` cookie.
* The frontend cannot ask for arbitrary ubus objects or run shell commands.
* Router addresses are restricted to private ranges unless explicitly overridden.

Details in [docs/architecture.md](docs/architecture.md).
