/**
 * An in-memory OpenWrt router.
 *
 * It implements the same surface as UbusClient, so every module above it - status,
 * capabilities, mode plans, Wi-Fi, DHCP, bandwidth, backup - runs completely unchanged.
 * Demo mode is a swapped transport, not a second code path, which is the only way it
 * stays honest: if a mode plan is broken here, it is broken on real hardware too.
 */

const clone = (value) => JSON.parse(JSON.stringify(value));

const INITIAL_UCI = {
  system: {
    cfg01system: { '.type': 'system', hostname: 'EasyMode-Demo', timezone: 'UTC' },
  },
  network: {
    loopback: { '.type': 'interface', device: 'lo', proto: 'static', ipaddr: '127.0.0.1', netmask: '255.0.0.0' },
    br_lan: { '.type': 'device', name: 'br-lan', type: 'bridge', ports: ['eth0'] },
    lan: { '.type': 'interface', device: 'br-lan', proto: 'static', ipaddr: '192.168.1.1', netmask: '255.255.255.0' },
    wan: { '.type': 'interface', device: 'eth1', proto: 'dhcp' },
    wan6: { '.type': 'interface', device: 'eth1', proto: 'dhcpv6' },
  },
  wireless: {
    radio0: { '.type': 'wifi-device', band: '2g', channel: '6', htmode: 'HT20', country: 'DE', disabled: '0' },
    default_radio0: {
      '.type': 'wifi-iface',
      device: 'radio0',
      mode: 'ap',
      ssid: 'Demo Home',
      encryption: 'psk2',
      key: 'demo-password',
      network: 'lan',
    },
    radio1: { '.type': 'wifi-device', band: '5g', channel: '36', htmode: 'VHT80', country: 'DE', disabled: '0' },
    default_radio1: {
      '.type': 'wifi-iface',
      device: 'radio1',
      mode: 'ap',
      ssid: 'Demo Home 5G',
      encryption: 'psk2',
      key: 'demo-password',
      network: 'lan',
    },
  },
  dhcp: {
    lan: { '.type': 'dhcp', interface: 'lan', start: '100', limit: '150', leasetime: '12h' },
    cfg05host: { '.type': 'host', name: 'printer', mac: '3c:2a:f4:11:22:33', ip: '192.168.1.60' },
  },
  firewall: {
    cfg01zone: { '.type': 'zone', name: 'lan', input: 'ACCEPT', output: 'ACCEPT', forward: 'ACCEPT', network: ['lan'] },
    cfg02zone: {
      '.type': 'zone',
      name: 'wan',
      input: 'REJECT',
      output: 'ACCEPT',
      forward: 'REJECT',
      masq: '1',
      mtu_fix: '1',
      network: ['wan', 'wan6'],
    },
    cfg03forward: { '.type': 'forwarding', src: 'lan', dest: 'wan' },
  },
  sqm: {
    eth1: { '.type': 'queue', interface: 'eth1', enabled: '0', qdisc: 'cake', script: 'piece_of_cake.qos' },
  },
  nlbwmon: { nlbwmon: { '.type': 'nlbwmon', database_directory: '/var/lib/nlbwmon' } },
};

// The demo upstreams are chosen to exercise the interesting paths: the wired main
// router sits on a different subnet, while the neighbour Wi-Fi shares 192.168.1.0/24
// with the default LAN, so a repeater setup really does trigger the subnet move.
const WIRED_UPSTREAM = { ip: '192.168.0.23', mask: '24', gateway: '192.168.0.1', dns: ['192.168.0.1'] };
const WIRELESS_UPSTREAM = { ip: '192.168.1.87', mask: '24', gateway: '192.168.1.1', dns: ['192.168.1.1'] };
const ISP_UPSTREAM = { ip: '203.0.113.45', mask: '24', gateway: '203.0.113.1', dns: ['203.0.113.1', '1.1.1.1'] };

const NEIGHBOURS = [
  { ssid: 'Main Router', bssid: '02:1a:11:00:00:01', channel: 6, frequency: 2437, signal: -52, wpa: [2] },
  { ssid: 'Main Router', bssid: '02:1a:11:00:00:02', channel: 11, frequency: 2462, signal: -64, wpa: [2] },
  { ssid: 'Pixel Hotspot', bssid: '02:1a:11:00:00:03', channel: 11, frequency: 2462, signal: -61, wpa: [2] },
  { ssid: 'FRITZ!Box 7590', bssid: '02:1a:11:00:00:04', channel: 6, frequency: 2437, signal: -70, wpa: [2, 3] },
  { ssid: 'Cafe Free WiFi', bssid: '02:1a:11:00:00:05', channel: 1, frequency: 2412, signal: -78, wpa: [] },
  { ssid: 'TP-Link_A2F1', bssid: '02:1a:11:00:00:06', channel: 3, frequency: 2422, signal: -81, wpa: [2] },
  { ssid: 'Vodafone-3344', bssid: '02:1a:11:00:00:07', channel: 1, frequency: 2412, signal: -74, wpa: [2] },
  { ssid: 'JioFiber_721', bssid: '02:1a:11:00:00:08', channel: 9, frequency: 2452, signal: -77, wpa: [2] },
  { ssid: '', bssid: '02:1a:11:00:00:09', channel: 13, frequency: 2472, signal: -83, wpa: [2] },
  { ssid: 'Neighbour 5G', bssid: '02:5a:11:00:00:01', channel: 36, frequency: 5180, signal: -66, wpa: [2] },
  { ssid: 'Main Router', bssid: '02:5a:11:00:00:02', channel: 44, frequency: 5220, signal: -58, wpa: [2] },
  { ssid: 'FRITZ!Box 7590', bssid: '02:5a:11:00:00:03', channel: 100, frequency: 5500, signal: -75, wpa: [2, 3] },
  { ssid: 'Deco_M5', bssid: '02:5a:11:00:00:04', channel: 52, frequency: 5260, signal: -69, wpa: [2] },
];

const asList = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);

export class DemoRouterClient {
  constructor({ host = 'demo', profile = 'full' } = {}) {
    this.host = host;
    // 'minimal' simulates a freshly flashed router: no optional packages, no
    // wireless config, nothing EasyMode has ever written.
    this.profile = profile;
    this.minimal = profile === 'minimal';
    this.scheme = 'http';
    this.sid = 'demo-session';
    this.demo = true;

    const base = clone(INITIAL_UCI);
    if (this.minimal) {
      delete base.wireless;
      delete base.sqm;
      delete base.nlbwmon;
      delete base.dhcp.cfg05host;
    }
    this.committed = clone(base);
    this.staged = clone(base);
    this.rollbackCopy = null;
    this.bootedAt = Date.now() - 4 * 3600 * 1000;
    this.counters = { rx: 48_000_000_000, tx: 6_200_000_000, at: Date.now() };
    this.cpuJiffies = { total: 400_000, idle: 330_000 };
    this.anonCounter = 10;
  }

  // --- helpers --------------------------------------------------------------
  get uptimeSeconds() {
    return Math.floor((Date.now() - this.bootedAt) / 1000);
  }

  section(config, name) {
    return this.staged[config]?.[name] ?? null;
  }

  find(config, type, predicate = () => true) {
    const sections = this.staged[config] ?? {};
    for (const [name, section] of Object.entries(sections)) {
      if (section['.type'] === type && predicate(section, name)) return { name, section };
    }
    return null;
  }

  /** The wireless client interface, if a mode set one up. */
  get staIface() {
    return this.find('wireless', 'wifi-iface', (section) => section.mode === 'sta');
  }

  get lanIp() {
    return this.section('network', 'lan')?.ipaddr ?? '192.168.1.1';
  }

  /** Runtime name of the client interface, when one exists. */
  staIfname() {
    for (const radio of Object.values(this.wirelessStatus())) {
      const sta = radio.interfaces.find((iface) => iface.config.mode === 'sta');
      if (sta) return sta.ifname;
    }
    return null;
  }

  /** Derives live interface state from the configuration, the way netifd would. */
  interfaceState(name) {
    const section = this.section('network', name);
    if (!section || section['.type'] !== 'interface') return null;
    const proto = section.proto ?? 'none';

    if (name === 'lan') {
      const lease = {
        ip: section.ipaddr ?? '192.168.1.1',
        mask: Number(section.netmask === '255.255.0.0' ? 16 : 24),
      };
      const routes = section.gateway
        ? [{ target: '0.0.0.0', mask: 0, nexthop: section.gateway, source: '' }]
        : [];
      return {
        interface: 'lan',
        up: true,
        pending: false,
        available: true,
        proto: 'static',
        device: section.device ?? 'br-lan',
        l3_device: section.device ?? 'br-lan',
        uptime: this.uptimeSeconds,
        'ipv4-address': [{ address: lease.ip, mask: lease.mask }],
        route: routes,
        'dns-server': asList(section.dns),
      };
    }

    if (proto === 'none') {
      return { interface: name, up: false, pending: false, available: true, proto: 'none', device: section.device ?? null, route: [], 'ipv4-address': [] };
    }

    // Which upstream answers depends on how the interface is wired, exactly as it
    // would on a real network.
    let upstream = null;
    if (name === 'wan' || name === 'emprobe') {
      upstream = name === 'emprobe' ? WIRED_UPSTREAM : proto === 'pppoe' || proto === 'static' ? ISP_UPSTREAM : WIRED_UPSTREAM;
    } else if (name === 'wwan') {
      upstream = this.staIface ? WIRELESS_UPSTREAM : null;
    }
    if (!upstream) {
      return { interface: name, up: false, pending: false, available: true, proto, device: section.device ?? null, route: [], 'ipv4-address': [] };
    }

    if (proto === 'static') {
      upstream = { ip: section.ipaddr, mask: '24', gateway: section.gateway, dns: asList(section.dns) };
    }

    // A wireless uplink is carried by the client interface, not by a cabled port.
    const staDevice = name === 'wwan' ? this.staIfname() : null;
    return {
      interface: name,
      up: true,
      pending: false,
      available: true,
      proto,
      device: section.device ?? staDevice ?? (proto === 'pppoe' ? 'pppoe-wan' : null),
      l3_device: proto === 'pppoe' ? 'pppoe-wan' : section.device ?? staDevice ?? null,
      uptime: Math.min(this.uptimeSeconds, 3600),
      'ipv4-address': [{ address: upstream.ip, mask: Number(upstream.mask) }],
      route: [{ target: '0.0.0.0', mask: 0, nexthop: upstream.gateway, source: '' }],
      'dns-server': upstream.dns ?? [],
    };
  }

  wirelessStatus() {
    const status = {};
    for (const [name, section] of Object.entries(this.staged.wireless ?? {})) {
      if (section['.type'] !== 'wifi-device') continue;
      const interfaces = Object.entries(this.staged.wireless)
        .filter(([, iface]) => iface['.type'] === 'wifi-iface' && iface.device === name)
        .map(([ifaceName, iface], index) => ({
          section: ifaceName,
          ifname: `${name === 'radio0' ? 'phy0' : 'phy1'}-${iface.mode === 'sta' ? 'sta' : 'ap'}${index}`,
          config: { ...iface },
        }));
      status[name] = {
        up: section.disabled !== '1',
        pending: false,
        autostart: true,
        disabled: section.disabled === '1',
        retry_setup_failed: false,
        config: { ...section },
        interfaces,
      };
    }
    return status;
  }

  ifaceConfigFor(device) {
    for (const radio of Object.values(this.wirelessStatus())) {
      for (const iface of radio.interfaces) {
        if (iface.ifname === device) return { radio, iface };
      }
    }
    return null;
  }

  // --- ubus surface ---------------------------------------------------------
  async call(object, method, args = {}) {
    const key = `${object}.${method}`;

    // A stock router without rpcd-mod-file or wireless answers 'not found' here.
    if (this.minimal && /^(file|iwinfo|network.wireless)/.test(object)) throw new DemoUbusError(4);

    switch (key) {
      case 'system.board':
        return {
          kernel: '6.6.63',
          hostname: this.section('system', 'cfg01system')?.hostname ?? 'EasyMode-Demo',
          system: 'MediaTek MT7621 ver:1 eco:3',
          model: 'Demo Router AX3000 (simulated)',
          board_name: 'easymode,demo-ax3000',
          release: {
            distribution: 'OpenWrt',
            version: '24.10.0',
            revision: 'r28427-demo',
            target: 'ramips/mt7621',
            description: 'OpenWrt 24.10.0 r28427-demo',
          },
        };

      case 'system.info': {
        const drift = Math.sin(Date.now() / 30000);
        return {
          uptime: this.uptimeSeconds,
          localtime: Math.floor(Date.now() / 1000),
          load: [Math.round((0.35 + drift * 0.2) * 65536), Math.round(0.3 * 65536), Math.round(0.25 * 65536)],
          memory: {
            total: 268_435_456,
            free: 138_000_000 + Math.round(drift * 6_000_000),
            available: 171_000_000 + Math.round(drift * 6_000_000),
            buffered: 12_800_000,
            cached: 42_000_000,
            shared: 1_200_000,
          },
          swap: { total: 0, free: 0 },
        };
      }

      case 'system.reboot':
        this.bootedAt = Date.now();
        return {};

      case 'session.destroy':
        return {};

      case 'network.interface.dump': {
        const names = Object.entries(this.staged.network ?? {})
          .filter(([, section]) => section['.type'] === 'interface')
          .map(([name]) => name);
        return { interface: names.map((name) => this.interfaceState(name)).filter(Boolean) };
      }

      case 'network.device.status': {
        const lanPorts = asList(this.find('network', 'device', (section) => section.type === 'bridge')?.section.ports);
        const uplinkBridged = lanPorts.includes('eth1');
        const rate = this.sampleCounters();
        const wireless = {};
        for (const radio of Object.values(this.wirelessStatus())) {
          for (const iface of radio.interfaces) {
            wireless[iface.ifname] = {
              up: true,
              carrier: true,
              type: 'Network device',
              macaddr: '02:aa:bb:cc:dd:10',
              statistics: { rx_bytes: rate.rx, tx_bytes: rate.tx },
            };
          }
        }
        return {
          ...wireless,
          'br-lan': { up: true, carrier: true, type: 'bridge', macaddr: '02:11:22:33:44:00', statistics: { rx_bytes: rate.rx, tx_bytes: rate.tx } },
          eth0: { up: true, carrier: true, speed: '1000F', type: 'Network device', macaddr: '02:11:22:33:44:01', statistics: { rx_bytes: rate.rx, tx_bytes: rate.tx } },
          eth1: {
            up: true,
            carrier: true,
            speed: '1000F',
            type: 'Network device',
            macaddr: '02:11:22:33:44:02',
            statistics: { rx_bytes: rate.rx, tx_bytes: rate.tx },
            bridge: uplinkBridged ? 'br-lan' : undefined,
          },
        };
      }

      case 'network.wireless.status':
        return this.wirelessStatus();

      case 'network.reload':
        return {};

      case 'iwinfo.devices':
        return { devices: Object.values(this.wirelessStatus()).flatMap((radio) => radio.interfaces.map((iface) => iface.ifname)) };

      case 'iwinfo.info': {
        const found = this.ifaceConfigFor(args.device);
        if (!found) throw new DemoUbusError(4);
        const { radio, iface } = found;
        const is5 = radio.config.band === '5g';
        const isSta = iface.config.mode === 'sta';
        return {
          phy: is5 ? 'phy1' : 'phy0',
          ssid: isSta ? iface.config.ssid : iface.config.ssid,
          bssid: is5 ? '02:aa:bb:cc:dd:51' : '02:aa:bb:cc:dd:21',
          country: radio.config.country ?? 'DE',
          mode: isSta ? 'Client' : 'Master',
          channel: Number(radio.config.channel === 'auto' ? (is5 ? 36 : 6) : radio.config.channel),
          frequency: is5 ? 5180 : 2437,
          txpower: Number(radio.config.txpower ?? 20),
          quality: isSta ? 48 : 62,
          quality_max: 70,
          signal: isSta ? -58 : -42,
          noise: -95,
          bitrate: is5 ? 866000 : 144400,
          encryption: { enabled: iface.config.encryption !== 'none', wpa: [2], authentication: ['psk'] },
          hwmodes: is5 ? ['a', 'n', 'ac', 'ax'] : ['b', 'g', 'n', 'ax'],
          htmodes: is5 ? ['HT20', 'HT40', 'VHT20', 'VHT40', 'VHT80', 'HE20', 'HE40', 'HE80'] : ['HT20', 'HT40', 'HE20', 'HE40'],
          hardware: { name: 'MediaTek MT7915E' },
        };
      }

      case 'iwinfo.assoclist': {
        const found = this.ifaceConfigFor(args.device);
        if (!found) return { results: [] };
        if (found.iface.config.mode === 'sta') {
          return { results: [{ mac: '02:aa:bb:cc:dd:01', signal: -58, noise: -95, inactive: 120, connected_time: 3600 }] };
        }
        const is5 = found.radio.config.band === '5g';
        return {
          results: is5
            ? [
                { mac: '9c:b6:d0:11:22:01', signal: -47, noise: -95, inactive: 60, connected_time: 8400 },
                { mac: 'a4:83:e7:44:55:02', signal: -58, noise: -95, inactive: 20, connected_time: 1200 },
              ]
            : [
                { mac: '3c:2a:f4:11:22:33', signal: -63, noise: -95, inactive: 300, connected_time: 40000 },
                { mac: 'dc:a6:32:99:88:77', signal: -71, noise: -95, inactive: 90, connected_time: 5400 },
              ],
        };
      }

      case 'iwinfo.scan': {
        const found = this.ifaceConfigFor(args.device);
        const is5 = found?.radio.config.band === '5g';
        return {
          results: NEIGHBOURS.filter((entry) => (is5 ? entry.frequency > 5000 : entry.frequency < 3000)).map((entry) => ({
            ssid: entry.ssid,
            bssid: entry.bssid,
            channel: entry.channel,
            frequency: entry.frequency,
            signal: entry.signal,
            quality: 70 + entry.signal,
            quality_max: 70,
            encryption: entry.wpa.length
              ? { enabled: true, wpa: entry.wpa, authentication: entry.wpa.includes(3) ? ['psk', 'sae'] : ['psk'] }
              : { enabled: false },
          })),
        };
      }

      case 'iwinfo.freqlist': {
        const found = this.ifaceConfigFor(args.device);
        const is5 = found?.radio.config.band === '5g';
        const channels = is5 ? [36, 40, 44, 48, 52, 56, 100, 104] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
        return {
          results: channels.map((channel) => ({
            channel,
            mhz: is5 ? 5000 + channel * 5 : 2407 + channel * 5,
            restricted: false,
          })),
        };
      }

      case 'iwinfo.txpowerlist':
        return { results: [0, 3, 6, 9, 12, 15, 17, 20].map((dbm) => ({ dbm, mw: Math.round(10 ** (dbm / 10)) })) };

      case 'uci.get': {
        const config = this.staged[args.config];
        if (!config) throw new DemoUbusError(4);
        if (args.section) {
          const section = config[args.section];
          if (!section) throw new DemoUbusError(4);
          return args.option ? { value: section[args.option] } : { values: { ...section, '.name': args.section } };
        }
        const values = {};
        for (const [name, section] of Object.entries(config)) values[name] = { ...section, '.name': name };
        return { values };
      }

      case 'uci.set': {
        this.staged[args.config] ??= {};
        const existing = this.staged[args.config][args.section];
        if (!existing && !args.type) throw new DemoUbusError(4);
        this.staged[args.config][args.section] = {
          ...(existing ?? { '.type': args.type }),
          ...(args.values ?? {}),
        };
        return {};
      }

      case 'uci.add': {
        this.staged[args.config] ??= {};
        const name = args.name ?? `cfg${this.anonCounter++}`;
        this.staged[args.config][name] = { '.type': args.type, ...(args.values ?? {}) };
        return { section: name };
      }

      case 'uci.delete': {
        const section = this.staged[args.config]?.[args.section];
        if (!section) return {};
        if (args.option) delete section[args.option];
        else if (args.options) for (const option of args.options) delete section[option];
        else delete this.staged[args.config][args.section];
        return {};
      }

      case 'uci.changes':
        return { changes: {} };

      case 'uci.revert':
        this.staged[args.config] = clone(this.committed[args.config] ?? {});
        return {};

      case 'uci.commit':
        this.committed[args.config] = clone(this.staged[args.config] ?? {});
        return {};

      case 'uci.apply':
        this.rollbackCopy = clone(this.committed);
        this.committed = clone(this.staged);
        return {};

      case 'uci.confirm':
        this.rollbackCopy = null;
        return {};

      case 'uci.rollback':
        if (this.rollbackCopy) {
          this.committed = clone(this.rollbackCopy);
          this.staged = clone(this.rollbackCopy);
          this.rollbackCopy = null;
        }
        return {};

      case 'file.read':
        return { data: this.readFileSync(args.path) };

      case 'file.write':
        // Writing a config file makes that config exist, as it would on the router.
        if (args.path?.startsWith('/etc/config/')) {
          const name = args.path.slice('/etc/config/'.length);
          this.staged[name] ??= { state: { '.type': 'state' } };
          this.committed[name] ??= clone(this.staged[name]);
        }
        return {};

      case 'file.exec':
        return this.exec(args.command, args.params ?? []);

      default:
        throw new DemoUbusError(3);
    }
  }

  sampleCounters() {
    const now = Date.now();
    const seconds = (now - this.counters.at) / 1000;
    // Roughly 12 Mbit/s down, 2 Mbit/s up, with some movement so the graph lives.
    const wobble = 1 + Math.sin(now / 8000) * 0.6;
    this.counters = {
      at: now,
      rx: Math.round(this.counters.rx + seconds * 1_500_000 * wobble),
      tx: Math.round(this.counters.tx + seconds * 260_000 * wobble),
    };
    return this.counters;
  }

  readFileSync(path) {
    if (path === '/proc/uptime') return `${this.uptimeSeconds}.00 ${this.uptimeSeconds * 2}.00\n`;
    if (path === '/proc/stat') {
      // Advance both counters so consecutive reads produce a plausible busy figure.
      const busy = 900 + Math.round(Math.abs(Math.sin(Date.now() / 20000)) * 900);
      this.cpuJiffies.total += 4000;
      this.cpuJiffies.idle += 4000 - busy;
      const idle = this.cpuJiffies.idle;
      const user = Math.round((this.cpuJiffies.total - idle) * 0.6);
      const system = this.cpuJiffies.total - idle - user;
      return `cpu  ${user} 0 ${system} ${idle} 0 0 0 0 0 0\ncpu0 ${user} 0 ${system} ${idle} 0 0 0 0 0 0\n`;
    }
    if (path === '/tmp/dhcp.leases') {
      const soon = Math.floor(Date.now() / 1000) + 3600;
      // Leases follow the LAN, so moving the network re-numbers the devices too.
      const prefix = this.lanIp.split('.').slice(0, 3).join('.');
      return [
        `${soon} 9c:b6:d0:11:22:01 ${prefix}.112 laptop-anna *`,
        `${soon + 1800} a4:83:e7:44:55:02 ${prefix}.145 iphone *`,
        `${soon + 600} 3c:2a:f4:11:22:33 ${prefix}.60 printer *`,
        `${soon + 2400} dc:a6:32:99:88:77 ${prefix}.173 livingroom-tv *`,
        `${soon + 900} b8:27:eb:aa:bb:cc ${prefix}.201 * *`,
      ].join('\n');
    }
    if (path === '/etc/board.json') {
      return JSON.stringify({ network: { lan: { ports: ['eth0'], device: 'br-lan' }, wan: { device: 'eth1' } } });
    }
    return null;
  }

  exec(command, params) {
    if (command.endsWith('ping')) {
      const target = params[params.length - 1];
      const reachableGateways = [WIRED_UPSTREAM.gateway, WIRELESS_UPSTREAM.gateway, ISP_UPSTREAM.gateway, '1.1.1.1'];
      const reachable = reachableGateways.includes(target);
      return { code: reachable ? 0 : 1, stdout: reachable ? `64 bytes from ${target}\n` : '', stderr: '' };
    }
    if (command.endsWith('nlbw')) {
      return {
        code: 0,
        stdout: JSON.stringify({
          columns: ['mac', 'ip', 'conns', 'rx_bytes', 'tx_bytes'],
          data: [
            ['dc:a6:32:99:88:77', '192.168.1.173', 42, 18_400_000_000, 420_000_000],
            ['9c:b6:d0:11:22:01', '192.168.1.112', 128, 6_100_000_000, 980_000_000],
            ['a4:83:e7:44:55:02', '192.168.1.145', 87, 2_300_000_000, 310_000_000],
            ['3c:2a:f4:11:22:33', '192.168.1.60', 3, 42_000_000, 8_000_000],
          ],
        }),
        stderr: '',
      };
    }
    return { code: 127, stdout: '', stderr: 'not found' };
  }

  // --- UbusClient-compatible wrappers ---------------------------------------
  async tryCall(object, method, args = {}, fallback = null) {
    try {
      return await this.call(object, method, args);
    } catch (error) {
      if (error instanceof DemoUbusError) return fallback;
      throw error;
    }
  }

  async listObjects() {
    if (this.minimal) {
      return {
        session: {},
        system: {},
        'network.interface': {},
        'network.device': {},
        network: {},
        uci: { apply: {}, confirm: {}, rollback: {}, get: {}, set: {}, add: {}, delete: {}, commit: {}, revert: {}, changes: {} },
      };
    }
    return {
      session: {},
      system: {},
      'network.interface': {},
      'network.device': {},
      'network.wireless': {},
      network: {},
      iwinfo: {},
      uci: { apply: {}, confirm: {}, rollback: {}, get: {}, set: {}, add: {}, delete: {}, commit: {}, revert: {}, changes: {} },
      file: {},
      'hostapd.phy0-ap0': {},
    };
  }

  async login() {
    return { sid: this.sid, timeout: 300, acls: {} };
  }

  async logout() {}

  async readFile(path) {
    return this.readFileSync(path);
  }

  async uciGet(config) {
    const result = await this.tryCall('uci', 'get', { config }, null);
    return result?.values ?? null;
  }
}

class DemoUbusError extends Error {
  constructor(status) {
    super(`demo ubus status ${status}`);
    this.status = status;
  }
}
