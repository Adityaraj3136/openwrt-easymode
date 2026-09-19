import { api } from '../api.js';
import { errorState, skeletonCards } from '../components.js';
import { icon } from '../icons.js';
import {
  badge,
  card,
  clear,
  dash,
  disclosure,
  el,
  errorAlert,
  formatBytes,
  formatMbps,
  kv,
  panel,
  ring,
} from '../ui.js';

/** Plain-language names for the four setups. */
const MODE_COPY = {
  router: { title: 'Router Mode', plain: 'Your internet arrives on a cable plugged into this router.' },
  ap: { title: 'Access Point Mode', plain: 'This router extends your main router’s network over a cable.' },
  repeater: { title: 'Wi-Fi Repeater Mode', plain: 'This router joins another Wi-Fi network and extends it.' },
  hotspot: { title: 'Mobile Hotspot Mode', plain: 'This router shares your phone’s hotspot with your devices.' },
  unknown: { title: 'Custom Setup', plain: 'This router is configured in a way EasyMode did not set up.' },
};

const SOURCE_GLYPH = { router: 'globe', ap: 'router', repeater: 'wifi', hotspot: 'smartphone', unknown: 'globe' };
const SOURCE_LABEL = { router: 'Internet', ap: 'Main router', repeater: 'Main Wi-Fi', hotspot: 'Phone hotspot', unknown: 'Internet' };

const deviceIcon = (name = '') => {
  const n = String(name || '').toLowerCase();
  if (/phone|iphone|pixel|galaxy|mobile/.test(n)) return 'smartphone';
  if (/tv|roku|chromecast|firestick/.test(n)) return 'devices';
  if (/laptop|macbook|notebook|pc|desktop/.test(n)) return 'laptop';
  return 'devices';
};

/* ============================================================
   Level 1 — the network map
   ============================================================ */
function topology({ mode, network, internet, wifi, bandwidth }) {
  const online = internet.online !== false;
  // Prefer the accurate wired/wireless split computed server-side (available after this fix).
  // Fall back to the legacy subtraction for older sessions.
  const wifiClients = network.lan.clients.wirelessCount
    ?? wifi.radios.reduce((sum, radio) => sum + (radio.clients ?? 0), 0);
  const totalDevices = network.lan.clients.available ? network.lan.clients.count : null;
  const wiredClients = network.lan.clients.wiredCount
    ?? (totalDevices == null ? null : Math.max(0, totalDevices - wifiClients));

  const down = formatMbps(bandwidth?.total?.rxRate);
  const up = formatMbps(bandwidth?.total?.txRate);

  const sourceNode = el('div', { class: 'topo-node' }, [
    el('div', { class: `topo-glyph ${online ? 'live' : 'offline'}` }, [
      icon(SOURCE_GLYPH[mode.id] ?? 'globe', { size: 34 }),
      el('span', { class: `mark ${online ? '' : 'bad'}` }, [icon(online ? 'check' : 'close', { size: 12 })]),
    ]),
    el('span', { class: 'topo-label', text: SOURCE_LABEL[mode.id] ?? 'Internet' }),
    el('span', { class: 'topo-sub', text: online ? 'Connected' : 'Not connected' }),
  ]);

  const uplink = el('div', { class: 'topo-link' }, [
    el('div', { class: `topo-wire ${online ? 'live' : 'down'}` }),
    down || up
      ? el('div', { class: 'topo-rate' }, [
          el('span', {}, [icon('arrowDown', { size: 13 }), el('b', { text: `${down ?? dash} Mbps` })]),
          el('span', {}, [icon('arrowUp', { size: 13 }), el('b', { text: `${up ?? dash} Mbps` })]),
        ])
      : null,
  ]);

  const routerNode = el('div', { class: 'topo-node' }, [
    el('div', { class: 'topo-glyph router' }, [
      icon('router', { size: 36 }),
      el('span', { class: 'mark' }, [icon('check', { size: 12 })]),
    ]),
    el('span', { class: 'topo-label', text: 'This router' }),
    el('span', { class: 'topo-sub', text: network.lan.ip ?? dash }),
  ]);

  const paused = wifi?.repeaterPaused === true;
  const branchLink = el('div', { class: 'topo-link' }, [el('div', { class: `topo-wire ${paused ? 'down' : 'live'}` })]);

  const branch = el('div', { class: 'topo-branch' }, [
    el('div', { class: 'topo-node' }, [
      el('div', { class: `topo-glyph ${wifi.radios.some((radio) => radio.enabled) ? 'live' : ''}` }, [icon('wifi', { size: 24 })]),
      el('div', {}, [
        el('div', { class: 'topo-label', text: 'Wi-Fi' }),
        el('div', { class: 'topo-sub' }, [
          el('strong', { text: String(wifiClients) }),
          el('span', { text: wifiClients === 1 ? ' device' : ' devices' }),
        ]),
      ]),
    ]),
    el('div', { class: 'topo-node' }, [
      el('div', { class: 'topo-glyph' }, [icon('cable', { size: 24 })]),
      el('div', {}, [
        el('div', { class: 'topo-label', text: 'Wired' }),
        el('div', { class: 'topo-sub' }, [
          el('strong', { text: wiredClients == null ? dash : String(wiredClients) }),
          el('span', { text: wiredClients === 1 ? ' device' : ' devices' }),
        ]),
      ]),
    ]),
  ]);

  return el('section', { class: 'card topology-card' }, [
    el('div', { class: 'topology' }, [sourceNode, uplink, routerNode, branchLink, branch]),
  ]);
}

/* ============================================================
   Level 2 — mode, internet, health
   ============================================================ */
function modeStrip(mode, onChangeMode) {
  const copy = MODE_COPY[mode.id] ?? MODE_COPY.unknown;
  return el('section', { class: 'card', style: 'padding:15px 18px' }, [
    el('div', { class: 'mode-strip' }, [
      el('div', { class: 'card-icon' }, [icon('router', { size: 20 })]),
      el('div', { class: 'mode-copy' }, [
        el('div', { class: 'eyebrow', text: 'Current mode' }),
        el('h2', { style: 'font-size:17px;margin-top:1px', text: copy.title }),
      ]),
      el('button', { class: 'btn btn-ghost', onclick: onChangeMode }, ['Change mode']),
    ]),
  ]);
}

function internetPanel(network, internet, bandwidth) {
  const wan = network.wan;
  const viaMain = !wan.up && Boolean(network.lan.gateway);
  const online = internet.online === true;
  const tone = online ? 'ok' : internet.online === false ? 'bad' : 'warn';
  const label = online ? 'Connected' : internet.online === false ? 'No internet' : 'Not verified';

  const connectionWord = wan.kind === 'wireless' ? 'Wi-Fi' : wan.kind === 'ethernet' ? 'WAN Ethernet' : viaMain ? 'Main router' : 'None';
  const setupWord = { dhcp: 'Automatic IP', pppoe: 'Provider sign-in', static: 'Fixed address' }[wan.proto] ?? null;

  return panel(
    { icon: icon('globe', { size: 19 }), title: 'Internet', trailing: badge(label, tone) },
    [
      el('div', { class: 'stat-row' }, [
        el('div', { class: 'stat' }, [
          el('span', { class: 'label' }, [icon('arrowDown', { size: 14 }), el('span', { text: 'Download' })]),
          el('div', { class: 'value' }, [
            el('span', { text: formatMbps(bandwidth?.total?.rxRate) ?? dash }),
            el('small', { text: 'Mbps' }),
          ]),
        ]),
        el('div', { class: 'stat' }, [
          el('span', { class: 'label' }, [icon('arrowUp', { size: 14 }), el('span', { text: 'Upload' })]),
          el('div', { class: 'value' }, [
            el('span', { text: formatMbps(bandwidth?.total?.txRate) ?? dash }),
            el('small', { text: 'Mbps' }),
          ]),
        ]),
        el('div', { class: 'stat' }, [
          el('span', { class: 'label', text: 'Comes in through' }),
          el('div', { class: 'value', style: 'font-size:18px', text: connectionWord }),
        ]),
      ]),
      disclosure('View connection details', [
        kv([
          ['Connection', setupWord],
          ['WAN IP address', wan.ip ?? network.lan.ip, 'mono'],
          ['Gateway', wan.gateway ?? network.lan.gateway, 'mono'],
          ['DNS', wan.dns?.length ? wan.dns.join(', ') : null, 'mono'],
          ['Network port', wan.device],
          ['Cable plugged in', wan.carrier == null ? null : wan.carrier ? 'Yes' : 'No'],
          ['Checked by', internet.method === 'ping' ? 'Connection test' : 'Settings only'],
        ]),
        internet.detail ? el('p', { class: 'empty', style: 'margin-top:10px', text: internet.detail }) : null,
      ], { key: 'dash.internet' }),
    ],
  );
}

function healthPanel(system) {
  const cpu = system.cpu.percent;
  const memory = system.memory.percent;

  return panel({ icon: icon('gauge', { size: 19 }), title: 'Router health' }, [
    el('div', { class: 'ring-row' }, [
      el('div', { class: 'ring-item' }, [
        ring(cpu),
        el('div', { class: 'caption' }, [
          el('strong', { text: system.processor || 'Processor' }), 
          el('span', { text: cpu == null ? 'Load only' : 'In use' })
        ]),
      ]),
      el('div', { class: 'ring-item' }, [
        ring(memory),
        el('div', { class: 'caption' }, [
          el('strong', { text: 'Memory' }),
          el('span', { text: system.memory.total ? `${formatBytes(system.memory.used)} used` : 'Not available' }),
        ]),
      ]),
    ]),
    el('div', { class: 'stat-row', style: 'margin-top:20px' }, [
      el('div', { class: 'stat' }, [
        el('span', { class: 'label' }, [icon('clock', { size: 14 }), el('span', { text: 'Running for' })]),
        el('div', { class: 'value', style: 'font-size:18px', text: system.uptime ?? dash }),
      ]),
      el('div', { class: 'stat' }, [
        el('span', { class: 'label' }, [icon('shield', { size: 14 }), el('span', { text: 'Firmware' })]),
        el('div', { class: 'value', style: 'font-size:18px', text: system.version ? `OpenWrt ${system.version}` : dash }),
      ]),
    ]),
    disclosure('View router details', [
      kv([
        ['Model', system.model],
        ['Router name', system.hostname],
        ['Full firmware', system.firmware],
        ['Load (1m / 5m / 15m)', system.load ? system.load.join(' / ') : null],
        ['Memory total', system.memory.total ? formatBytes(system.memory.total) : null],
      ]),
      system.cpu.percent == null && system.cpu.reason
        ? el('p', { class: 'empty', style: 'margin-top:10px', text: system.cpu.reason })
        : null,
    ], { key: 'dash.health' }),
  ]);
}

/* ============================================================
   Level 3 — Wi-Fi and devices
   ============================================================ */
function wifiPanel(wifi, handlers, repeaterPaused) {
  if (!wifi.supported) {
    return panel({ icon: icon('wifi', { size: 19 }), title: 'Wi-Fi' }, [
      el('p', { class: 'empty', text: 'This router has no wireless radios.' }),
    ]);
  }

  const bands = wifi.radios.map((radio) => {
    const sta = radio.interfaces?.find((iface) => iface.mode === 'sta');
    const mode = radio.mode ?? 'ap';

    if (mode === 'sta' || mode === 'repeater') {
      const onManageMode = () => handlers.onModeSetup?.(radio.id);
      
      const isConnected = sta?.up && !repeaterPaused;
      
      const statusBadge = repeaterPaused
        ? badge('Disconnected', 'warning')
        : radio.enabled 
          ? (isConnected ? badge('Connected', 'ok') : badge('Connecting...', 'warning'))
          : badge('Off', 'neutral');

      const toggleBtn = el('button', { 
        class: 'btn btn-ghost btn-small', 
        onclick: async () => {
          let confirmed = repeaterPaused;
          if (!confirmed) {
            const { confirmDialog } = await import('../components.js');
            confirmed = await confirmDialog({
              title: 'Disconnect from this network?',
              message: 'Internet access will be paused for all devices.',
              confirmLabel: 'Disconnect',
              tone: 'danger'
            });
          }

          if (confirmed) {
            toggleBtn.disabled = true;
            toggleBtn.textContent = repeaterPaused ? 'Connecting...' : 'Disconnecting...';
            try {
              if (repeaterPaused) {
                await api.connectRepeater();
              } else {
                await api.disconnectRepeater();
              }
              
              setTimeout(() => location.reload(), 1500);
            } catch (e) {
              alert('Failed: ' + e.message);
              toggleBtn.disabled = false;
              toggleBtn.textContent = repeaterPaused ? 'Connect' : 'Disconnect';
            }
          }
        }, 
        text: repeaterPaused ? 'Connect' : 'Disconnect' 
      });

      return el('div', { class: 'band' }, [
        el('div', { class: 'band-head' }, [
          icon('globe', { size: 17 }),
          el('strong', { text: 'Repeater' }),
          el('span', { style: 'flex:1' }),
          statusBadge,
        ]),
        el('div', { class: 'ssid', text: sta?.ssid ?? 'Unknown network' }),
        el('div', { class: 'meta', text: repeaterPaused ? 'Internet disconnected — click Connect to resume' : (isConnected ? 'Providing internet to your router' : 'Trying to connect or out of range') }),
        el('div', { style: 'display:flex; gap:8px; margin-top:12px;' }, [
          el('button', { class: 'btn btn-ghost btn-small', onclick: onManageMode, text: 'Manage' }),
          toggleBtn
        ])
      ]);
    }

    const onManageWifi = () => handlers.onManageWifi?.(radio.id);

    if (!radio.enabled) {
      return el('div', { class: 'band off' }, [
        el('div', { class: 'band-head' }, [
          icon('wifi', { size: 17 }),
          el('strong', { text: radio.label.replace(' Wi-Fi', '') }),
          el('span', { class: 'spacer', style: 'flex:1' }),
          badge('Wi-Fi off', 'neutral', { dot: false }),
        ]),
        el('button', { class: 'btn btn-ghost btn-small', onclick: onManageWifi, text: 'Turn on' }),
      ]);
    }
    const otherAps = (radio.interfaces ?? []).filter((iface) => iface.mode === 'ap' && iface.ssid !== radio.ssid);

    return el('div', { class: 'band' }, [
      el('div', { class: 'band-head' }, [
        icon('wifi', { size: 17 }),
        el('strong', { text: radio.label.replace(' Wi-Fi', '') }),
        el('span', { style: 'flex:1' }),
        badge('Active', 'ok'),
      ]),
      el('div', { class: 'ssid', text: radio.ssid ?? 'No network name' }),
      el('div', { class: 'meta', text: `Channel ${radio.channel ?? 'auto'} · ${radio.clients ?? 0} ${radio.clients === 1 ? 'device' : 'devices'}` }),
      ...otherAps.map((ap) => el('div', { class: 'meta', style: 'margin-top:8px;' }, [
        icon('shield', { size: 12 }), el('span', { text: ` ${ap.ssid} (Guest)` })
      ])),
      sta?.ssid ? el('div', { class: 'meta', style: 'margin-top:8px;' }, [
        icon('wifi', { size: 12 }), el('span', { text: ` Connected to "${sta.ssid}"` })
      ]) : null,
    ]);
  });

  return panel(
    {
      icon: icon('wifi', { size: 19 }),
      title: 'Wi-Fi',
      trailing: el('button', { class: 'btn btn-ghost btn-small', onclick: handlers.onManageWifi, text: 'Manage Wi-Fi' }),
    },
    [el('div', { class: 'split' }, bands)],
  );
}

function devicesPanel(network, wifi, leases, onViewDevices) {
  const wifiClients = network.lan.clients.wirelessCount
    ?? wifi.radios.reduce((sum, radio) => sum + (radio.clients ?? 0), 0);
  const total = network.lan.clients.available ? network.lan.clients.count : null;
  const wired = network.lan.clients.wiredCount
    ?? (total == null ? null : Math.max(0, total - wifiClients));

  return panel(
    {
      icon: icon('devices', { size: 19 }),
      title: 'Connected devices',
      trailing: el('button', { class: 'btn btn-ghost btn-small', onclick: onViewDevices, text: 'View devices' }),
    },
    [
      el('div', { class: 'device-total' }, [
        el('span', { class: 'n', text: total == null ? dash : String(total) }),
        el('span', { class: 't', text: 'devices on your network' }),
      ]),
      el('div', { class: 'device-split' }, [
        el('div', { class: 'chip-stat' }, [
          icon('wifi', { size: 18 }),
          el('div', {}, [el('span', { text: 'Wireless' }), el('strong', { text: String(wifiClients) })]),
        ]),
        el('div', { class: 'chip-stat' }, [
          icon('cable', { size: 18 }),
          el('div', {}, [el('span', { text: 'Wired' }), el('strong', { text: wired == null ? dash : String(wired) })]),
        ]),
      ]),
      network.lan.clients.devices?.length
        ? el(
            'div',
            { class: 'device-list' },
            network.lan.clients.devices.slice(0, 4).map((device) =>
              el('div', { class: 'device-row' }, [
                el('span', { class: 'ico' }, [icon(deviceIcon(device.hostname), { size: 18 })]),
                el('span', { class: 'dn', text: device.hostname ?? 'Unnamed device' }),
                el('span', { class: 'di', text: device.ip }),
              ]),
            ),
          )
        : network.lan.clients.available
          ? null
          : el('p', { class: 'empty', style: 'margin-top:12px', text: network.lan.clients.reason }),
    ],
  );
}

function homeNetworkPanel(network, dhcp) {
  return panel({ icon: icon('network', { size: 19 }), title: 'Home network' }, [
    el('div', { class: 'stat-row' }, [
      el('div', { class: 'stat' }, [
        el('span', { class: 'label', text: 'Router address' }),
        el('div', { class: 'value', style: 'font-size:19px', text: network.lan.ip ?? dash }),
      ]),
      el('div', { class: 'stat' }, [
        el('span', { class: 'label', text: 'Addresses' }),
        el('div', { class: 'value', style: 'font-size:19px' }, [
          network.lan.dhcpEnabled == null
            ? el('span', { text: dash })
            : badge(network.lan.dhcpEnabled ? 'DHCP active' : 'Main router', network.lan.dhcpEnabled ? 'ok' : 'accent'),
        ]),
      ]),
    ]),
    disclosure('View network details', [
      kv([
        ['Network range', network.lan.cidr, 'mono'],
        // The address range comes from the DHCP endpoint, which works it out from the
        // router's real netmask instead of assuming a /24.
        ['Addresses given out', dhcp?.rangeStart ? `${dhcp.rangeStart} – ${dhcp.rangeEnd}` : null, 'mono'],
        ['Lease time', dhcp?.leasetime],
        ['Gateway', network.lan.gateway, 'mono'],
        ['Network device', network.lan.device],
      ]),
    ], { key: 'dash.network' }),
  ]);
}

/* ============================================================
   Page
   ============================================================ */
function render(container, { status, bandwidth, dhcp }, handlers) {
  clear(container);

  const online = status.internet.online !== false;
  const mode = status.mode;
  const copy = MODE_COPY[mode.id] ?? MODE_COPY.unknown;

  container.append(
    el('div', { class: 'hero' }, [
      el('div', {}, [
        el('h1', { text: 'Welcome back' }),
        el('p', {
          text: online
            ? `Your router is working normally in ${copy.title.toLowerCase()}.`
            : 'Your router is running, but the internet is not reachable right now.',
        }),
      ]),
    ]),
    topology({ ...status, bandwidth }),
    el('div', { style: 'height:16px' }),
    modeStrip(mode, handlers.onChangeMode),
    el('div', { style: 'height:16px' }),
    el('div', { class: 'grid halves' }, [
      internetPanel(status.network, status.internet, bandwidth),
      healthPanel(status.system),
    ]),
    el('div', { style: 'height:16px' }),
    el('div', { class: 'grid halves' }, [
      wifiPanel(status.wifi, handlers, status.wifi?.repeaterPaused),
      devicesPanel(status.network, status.wifi, dhcp?.leases ?? [], handlers.onViewDevices),
    ]),
    el('div', { style: 'height:16px' }),
    el('div', { class: 'grid halves' }, [homeNetworkPanel(status.network, dhcp)]),
  );
}

export function renderDashboard(container, { onChangeMode, onUnauthorized, onReachability }) {
  const body = el('div', {}, [skeletonCards(2, 5)]);
  container.append(body);

  const handlers = {
    onChangeMode,
    onManageWifi: () => {
      location.hash = '#/wifi';
    },
    onViewDevices: () => {
      location.hash = '#/dhcp';
    },
  };

  let stopped = false;
  let timer = null;
  let ticks = 0;
  let dhcpStatus = null;

  const tick = async () => {
    try {
      // Throughput and device names come from the same real endpoints the other
      // pages use; nothing here is synthesised. Leases change slowly, so they are
      // refreshed every sixth pass rather than every five seconds.
      const wantLeases = ticks % 6 === 0;
      const [status, bandwidth, dhcp] = await Promise.all([
        api.status(),
        api.bandwidth().catch(() => null),
        wantLeases ? api.dhcp().catch(() => null) : Promise.resolve(null),
      ]);
      ticks += 1;
      if (dhcp) dhcpStatus = dhcp;
      if (stopped) return;
      onReachability?.(true);
      render(body, { status, bandwidth, dhcp: dhcpStatus }, handlers);
    } catch (error) {
      if (stopped) return;
      if (error.status === 401) return onUnauthorized();
      onReachability?.(false);
      clear(body).append(errorState(error, () => tick()));
    }
    if (!stopped) timer = setTimeout(tick, 5000);
  };

  tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
