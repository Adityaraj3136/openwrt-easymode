import { parseDhcpLeases } from '../derive.js';

/**
 * Fetches DHCP leases using whichever method is available.
 * Returns an array of { mac, ip, hostname, active } objects — same shape as parseDhcpLeases().
 */
export async function fetchLeases(client, session) {
  // Primary: read /tmp/dhcp.leases directly (fastest, always accurate).
  if (session.capabilities?.features?.fileRead) {
    return parseDhcpLeases(await client.readFile('/tmp/dhcp.leases')).filter((l) => l.active);
  }

  // Fallback: query dhcp ubus object. OpenWrt 21.02+ exposes dhcp.ipv4leases.
  // Response format: { "device": { "<mac>": { "hostname": "...", "ipaddr": "...", "expires": N } } }
  const leaseData =
    (await client.tryCall('dhcp', 'ipv4leases', {}, null)) ??
    (await client.tryCall('dhcp', 'leases', {}, null));

  if (leaseData) {
    const deviceMap = leaseData.device ?? leaseData;
    if (typeof deviceMap === 'object' && !Array.isArray(deviceMap)) {
      return Object.entries(deviceMap).flatMap(([mac, entry]) => {
        // Some builds put an array of leases per MAC, others a single object.
        const entries = Array.isArray(entry) ? entry : [entry];
        return entries.map((e) => ({
          mac: mac.toLowerCase(),
          ip: e.ipaddr ?? e.ip ?? null,
          hostname: e.hostname && e.hostname !== '*' ? e.hostname : null,
          expiresAt: e.expires ? Number(e.expires) * 1000 : null,
          active: true,
        }));
      }).filter((l) => l.ip);
    }
    if (Array.isArray(deviceMap)) {
      return deviceMap.map((e) => ({
        mac: (e.mac ?? '').toLowerCase(),
        ip: e.ipaddr ?? e.ip ?? null,
        hostname: e.hostname && e.hostname !== '*' ? e.hostname : null,
        active: true,
      })).filter((l) => l.ip);
    }
  }

  // Final fallback: luci-rpc getDHCPLeases
  const luciLeases = await client.tryCall('luci-rpc', 'getDHCPLeases', {}, null);
  if (luciLeases && Array.isArray(luciLeases.dhcp_leases)) {
    return luciLeases.dhcp_leases.map((e) => ({
      mac: (e.macaddr ?? '').toLowerCase(),
      ip: e.ipaddr ?? null,
      hostname: e.hostname && e.hostname !== '*' ? e.hostname : null,
      expiresAt: e.expires ? Date.now() + (Number(e.expires) * 1000) : null,
      active: true,
    })).filter((l) => l.ip);
  }

  return [];
}

/**
 * Fetches wired-only clients by cross-referencing the ARP table with Wi-Fi assoclists.
 * Returns { wiredMacs: Set<string>, arpEntries: Array<{mac, ip}> }.
 */
export async function fetchWiredClients(client, wifiMacs = new Set()) {
  // Try reading the ARP table — works when fileRead is enabled.
  const arpFile = await client.readFile('/proc/net/arp').catch(() => null);
  const arpEntries = [];
  if (typeof arpFile === 'string') {
    for (const line of arpFile.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;
      const ip = parts[0];
      const mac = parts[3]?.toLowerCase();
      const flags = parseInt(parts[2], 16);
      // Flag 0x2 = ATF_COM (complete/reachable ARP entry); skip incomplete ones.
      if (mac && mac !== '00:00:00:00:00:00' && ip && (flags & 0x2)) {
        arpEntries.push({ ip, mac });
      }
    }
  }

  const wiredMacs = new Set(
    arpEntries.filter((e) => !wifiMacs.has(e.mac)).map((e) => e.mac),
  );

  return { wiredMacs, arpEntries };
}

const defaultRouteOf = (iface) =>
  (iface.route ?? []).find((route) => route.target === '0.0.0.0' && Number(route.mask) === 0) ?? null;

const firstIpv4 = (iface) => (iface['ipv4-address'] ?? [])[0] ?? null;

const cidrToMask = (bits) => {
  const value = bits >= 0 && bits <= 32 ? (0xffffffff << (32 - bits)) >>> 0 : 0;
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.');
};

/**
 * Picks the interface that actually carries the uplink.
 *
 * The LAN is excluded from the default-route fallback on purpose: in Access Point mode
 * the LAN holds the route to the main router, and treating that as a WAN would make
 * the router look like it is routing when it is not.
 */
function pickWan(interfaces) {
  const candidates = interfaces.filter(
    (iface) => iface.interface !== 'loopback' && iface.interface !== 'lan',
  );
  const named = candidates.find((iface) => iface.interface === 'wan' && iface.up);
  const wwan = candidates.find((iface) => /^(wwan|wan_sta|repeater)/i.test(iface.interface) && iface.up);
  const routed = candidates.find((iface) => iface.up && defaultRouteOf(iface));
  return named ?? wwan ?? routed ?? candidates.find((iface) => iface.interface === 'wan') ?? null;
}

export async function getNetworkStatus(client, session) {
  const dump = await client.call('network.interface', 'dump');
  const interfaces = dump.interface ?? [];
  const devices = (await client.tryCall('network.device', 'status', {}, null)) ?? {};
  const dhcpConfig = (await client.uciGet('dhcp')) ?? {};

  const wanIface = pickWan(interfaces);
  const lanIface = interfaces.find((iface) => iface.interface === 'lan') ?? null;

  const wanIp = wanIface ? firstIpv4(wanIface) : null;
  const wanDevice = wanIface?.l3_device ?? wanIface?.device ?? null;
  const wanIsWireless = Boolean(wanDevice && /^(wlan|phy|wl)/i.test(wanDevice));
  const wanPhysical = wanDevice ? devices[wanDevice] ?? null : null;

  const lanIp = lanIface ? firstIpv4(lanIface) : null;
  const lanDhcpSection = Object.values(dhcpConfig).find(
    (section) => section['.type'] === 'dhcp' && (section.interface === 'lan' || section['.name'] === 'lan'),
  );
  const lanDhcpDisabled = Boolean(
    lanDhcpSection && (lanDhcpSection.ignore === '1' || lanDhcpSection.ignore === 1),
  );

  const ethernetLinks = Object.entries(devices)
    .filter(([name, device]) => /^(eth|lan|wan|swp|sfp)/i.test(name) && !name.includes('.') && device.type !== 'bridge')
    .map(([name, device]) => ({
      name,
      up: Boolean(device.up),
      carrier: Boolean(device.carrier),
      speed: device.speed ?? null,
    }));

  // Gather all DHCP leases using the best available method.
  const leases = await fetchLeases(client, session);

  // Build a set of Wi-Fi client MACs by querying iwinfo assoclist on all known AP ifaces.
  // This lets us distinguish wired vs wireless among the DHCP lease list.
  const { listRadios } = await import('../wireless.js');
  const radios = await listRadios(client, { withClients: true });
  const wifiMacs = new Set();
  for (const radio of radios) {
    for (const iface of radio.interfaces ?? []) {
      for (const mac of iface.clientMacs ?? []) {
        wifiMacs.add(mac);
      }
    }
  }
  const arpByMac = new Map();
  const arpFile = await client.readFile('/proc/net/arp').catch(() => null);
  if (typeof arpFile === 'string') {
    for (const line of arpFile.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;
      const ip = parts[0];
      const mac = parts[3]?.toLowerCase();
      const flags = parseInt(parts[2], 16);
      if (mac && mac !== '00:00:00:00:00:00' && ip && (flags & 0x2)) {
        arpByMac.set(mac, ip);
      }
    }
  } else {
    // Fallback 1: ubus rpc-sys or luci-rpc for ARP table.
    const arpTable = (await client.tryCall('luci-rpc', 'getARPTable', {}, null))
      ?? (await client.tryCall('rpc-sys', 'net.arptable', {}, null));
    if (Array.isArray(arpTable)) {
      for (const entry of arpTable) {
        const ip = entry['IP address'] ?? entry.ipaddr ?? entry.ip;
        const mac = (entry['HW address'] ?? entry.macaddr ?? entry.mac)?.toLowerCase();
        const flags = entry.Flags ?? entry.flags;
        if (mac && mac !== '00:00:00:00:00:00' && ip) {
          if (flags !== undefined && (parseInt(flags, 16) & 0x2) === 0) continue;
          arpByMac.set(mac, ip);
        }
      }
    }
  }

  // Fallback 2: The network.interface dump always includes neighbor4 (ARP cache) for each interface!
  // This gives us precise states (reachable, stale, etc.) unlike the raw ARP table.
  let hasNeighbor4 = false;
  for (const iface of interfaces) {
    if (iface.neighbor4) hasNeighbor4 = true;
  }
  
  if (hasNeighbor4) {
    arpByMac.clear(); // We have precise data, discard the raw ARP table
    for (const iface of interfaces) {
      for (const neighbor of iface.neighbor4 ?? []) {
        const mac = neighbor.mac?.toLowerCase();
        // Exclude 'stale' so disconnected devices drop off immediately
        if (mac && mac !== '00:00:00:00:00:00' && neighbor.ip && (neighbor.state === 'reachable' || neighbor.state === 'delay' || neighbor.state === 'probe')) {
          arpByMac.set(mac, neighbor.ip);
        }
      }
    }
  }

  // Only consider devices currently connected via Wi-Fi or with an active ARP entry as "online".
  // Devices that only have a DHCP lease (but no active ARP/Wi-Fi) are disconnected.
  const activeMacs = new Set([...wifiMacs, ...arpByMac.keys()].filter(Boolean));
  const leaseByMac = new Map(leases.map((l) => [l.mac, l]));
  
  const connectedDevices = [...activeMacs].map((mac) => {
    const lease = leaseByMac.get(mac);
    return {
      mac,
      ip: arpByMac.get(mac) ?? lease?.ip ?? null,
      hostname: lease?.hostname ?? null,
      wired: !wifiMacs.has(mac),
    };
  });

  const wiredCount = connectedDevices.filter((d) => d.wired).length;
  const wirelessCount = connectedDevices.filter((d) => !d.wired).length;
  const totalCount = connectedDevices.length;

  const hasData = leases.length > 0 || arpByMac.size > 0;
  const clients = {
    count: hasData ? totalCount : null,
    wiredCount: hasData ? wiredCount : null,
    wirelessCount: hasData ? wirelessCount : null,
    available: hasData,
    reason: hasData ? null : 'Device list not available on this router',
    devices: connectedDevices,
  };

  return {
    wan: {
      present: Boolean(wanIface),
      interface: wanIface?.interface ?? null,
      up: Boolean(wanIface?.up),
      kind: wanIface ? (wanIsWireless ? 'wireless' : 'ethernet') : 'none',
      proto: wanIface?.proto ?? null,
      device: wanDevice,
      carrier: wanPhysical ? Boolean(wanPhysical.carrier) : null,
      address: wanIp ? `${wanIp.address}/${wanIp.mask}` : null,
      ip: wanIp?.address ?? null,
      gateway: wanIface ? defaultRouteOf(wanIface)?.nexthop ?? null : null,
      dns: wanIface?.['dns-server'] ?? [],
      uptimeSeconds: wanIface?.uptime ?? null,
    },
    lan: {
      present: Boolean(lanIface),
      up: Boolean(lanIface?.up),
      ip: lanIp?.address ?? null,
      netmask: lanIp ? cidrToMask(Number(lanIp.mask)) : null,
      cidr: lanIp ? `${lanIp.address}/${lanIp.mask}` : null,
      device: lanIface?.l3_device ?? lanIface?.device ?? null,
      dhcpEnabled: lanDhcpSection ? !lanDhcpDisabled : null,
      dhcpStart: lanDhcpSection?.start ?? null,
      dhcpLimit: lanDhcpSection?.limit ?? null,
      gateway: lanIface ? defaultRouteOf(lanIface)?.nexthop ?? null : null,
      clients,
    },
    ethernetLinks,
    _raw: { lanDhcpDisabled, lanHasGateway: Boolean(lanIface && defaultRouteOf(lanIface)) },
  };
}
