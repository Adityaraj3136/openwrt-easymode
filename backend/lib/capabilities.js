import { listRadios } from './wireless.js';

/**
 * Runs once at login. Everything the UI hides or disables is decided from here,
 * so features are never shown as broken controls.
 */
export async function detectCapabilities(client, board) {
  const objects = await client.listObjects();
  const has = (name) => Object.prototype.hasOwnProperty.call(objects, name);

  const devices = (await client.tryCall('network.device', 'status', {}, null)) ?? {};
  const interfaces = (await client.tryCall('network.interface', 'dump', {}, { interface: [] }))?.interface ?? [];

  const ethernet = Object.entries(devices)
    .filter(([name, device]) => {
      if (device.type && device.type !== 'Network device') return false;
      return /^(eth|lan|wan|swp|sfp)/i.test(name) && !name.includes('.');
    })
    .map(([name, device]) => ({
      name,
      up: Boolean(device.up),
      carrier: Boolean(device.carrier),
      speed: device.speed ?? null,
      mac: device.macaddr ?? null,
    }));

  const wanInterface = interfaces.find((iface) => /^wan/i.test(iface.interface) && iface.proto !== 'none');
  const lanInterface = interfaces.find((iface) => iface.interface === 'lan');

  const radios = await listRadios(client, { withClients: false });
  const bands = radios.map((radio) => radio.band).filter(Boolean);

  // SQM / traffic accounting are optional packages; presence decides whether the
  // Bandwidth page can do anything real (phase 9).
  const sqmConfig = await client.uciGet('sqm');
  const hasFileRead = has('file') && (await client.readFile('/proc/uptime')) !== null;

  return {
    router: {
      model: board?.model ?? null,
      board: board?.board_name ?? null,
      hostname: board?.hostname ?? null,
      kernel: board?.kernel ?? null,
      release: board?.release ?? null,
    },
    ubusObjects: Object.keys(objects).sort(),
    ethernet,
    wan: wanInterface
      ? { interface: wanInterface.interface, device: wanInterface.l3_device ?? wanInterface.device ?? null, proto: wanInterface.proto }
      : null,
    lan: lanInterface
      ? { interface: lanInterface.interface, device: lanInterface.l3_device ?? lanInterface.device ?? null }
      : null,
    radios: radios.map((radio) => ({ id: radio.id, band: radio.band, label: radio.label })),
    bands: {
      has24: bands.includes('2.4'),
      has5: bands.includes('5'),
      has6: bands.includes('6'),
      count: radios.length,
    },
    features: {
      iwinfo: has('iwinfo'),
      // Some vendor OpenWrt builds (e.g. JioRouter AX6000) don't advertise
      // 'network.wireless' in the ubus object list even though Wi-Fi is fully
      // functional. Accept the capability if hostapd objects or iwinfo are
      // present as a fallback, since those only exist on wireless-capable hardware.
      wirelessControl:
        has('network.wireless') ||
        Object.keys(objects).some((name) => name.startsWith('hostapd')) ||
        (has('iwinfo') && radios.length > 0),
      uci: has('uci'),
      fileRead: hasFileRead,
      cpuUsage: hasFileRead,
      dhcpLeases: hasFileRead || has('dhcp'),
      hostapdControl: Object.keys(objects).some((name) => name.startsWith('hostapd')),
      sqm: sqmConfig !== null,
      luci: true,
    },
  };
}
