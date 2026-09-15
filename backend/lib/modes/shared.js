import { asList, findSection, findSections } from '../uci.js';

/** Applies the user's SSID/password to every AP interface and attaches them to a network. */
export async function stageWifiSettings(ctx, { network = 'lan' } = {}) {
  const wireless = (await ctx.client.uciGet('wireless')) ?? {};
  const radios = findSections(wireless, 'wifi-device');
  const apSections = findSections(wireless, 'wifi-iface', (section) => (section.mode ?? 'ap') === 'ap');
  if (!apSections.length) return 'This router has no Wi-Fi to configure';

  const wifi = ctx.options.wifi;
  if (!wifi?.enabled) {
    // Even when the names stay as they are, AP interfaces must sit on the right network.
    for (const ap of apSections) {
      if (asList(ap.section.network).join() !== network) {
        await ctx.uci.set('wireless', ap.name, { network });
      }
    }
    return 'Wi-Fi names left unchanged';
  }

  for (const radio of radios) {
    await ctx.uci.set('wireless', radio.name, { disabled: '0' });
  }
  for (const ap of apSections) {
    await ctx.uci.set('wireless', ap.name, {
      ssid: wifi.ssid,
      encryption: wifi.encryption,
      network,
      mode: 'ap',
      disabled: '0',
      ...(wifi.encryption === 'none' ? {} : { key: wifi.key }),
    });
    if (wifi.encryption === 'none') await ctx.uci.clearOptions('wireless', ap.name, ['key']);
  }
  return `Wi-Fi name set to "${wifi.ssid}" on ${apSections.length} network${apSections.length > 1 ? 's' : ''}`;
}

/**
 * Adds a port to the LAN bridge. Handles both layouts: a `device` section of type
 * bridge (OpenWrt 21.02+) and the older `network.lan.ifname` list.
 */
export async function addPortToLanBridge(ctx, device) {
  const network = (await ctx.client.uciGet('network')) ?? {};
  // Match the bridge the LAN actually uses; a router may have several.
  const lanDevice = network.lan?.device ?? 'br-lan';
  const bridge =
    findSection(network, 'device', (section) => section.type === 'bridge' && section.name === lanDevice) ??
    findSection(network, 'device', (section) => section.type === 'bridge' && section.name === 'br-lan');

  if (bridge) {
    const ports = asList(bridge.section.ports);
    if (ports.includes(device)) return { changed: false, style: 'device-section' };
    await ctx.uci.set('network', bridge.name, { ports: [...ports, device] });
    return { changed: true, style: 'device-section' };
  }

  const lan = network.lan ?? {};
  const legacy = asList(lan.ifname);
  if (legacy.length) {
    if (legacy.includes(device)) return { changed: false, style: 'ifname' };
    await ctx.uci.set('network', 'lan', { ifname: [...legacy, device].join(' ') });
    return { changed: true, style: 'ifname' };
  }

  // No bridge at all (single-port device): put the uplink straight on the LAN interface.
  await ctx.uci.set('network', 'lan', { device });
  return { changed: true, style: 'direct' };
}

/** Takes a port back out of the LAN bridge, e.g. when leaving Access Point mode. */
export async function removePortFromLanBridge(ctx, device) {
  const network = (await ctx.client.uciGet('network')) ?? {};
  const bridge = findSection(network, 'device', (section) => section.type === 'bridge' && asList(section.ports).includes(device));
  if (bridge) {
    await ctx.uci.set('network', bridge.name, {
      ports: asList(bridge.section.ports).filter((port) => port !== device),
    });
    return true;
  }

  const legacy = asList(network.lan?.ifname);
  if (legacy.includes(device)) {
    await ctx.uci.set('network', 'lan', { ifname: legacy.filter((port) => port !== device).join(' ') });
    return true;
  }
  return false;
}

/** Ethernet ports that currently have a cable in them. */
export async function portsWithCarrier(client) {
  const devices = (await client.tryCall('network.device', 'status', {}, null)) ?? {};
  return Object.entries(devices)
    .filter(([name, device]) => /^(eth|lan|wan|swp|sfp)/i.test(name) && !name.includes('.') && device.type !== 'bridge')
    .map(([name, device]) => ({
      name,
      carrier: Boolean(device.carrier),
      up: Boolean(device.up),
      speed: device.speed ?? null,
    }));
}
