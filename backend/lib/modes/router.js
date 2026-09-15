import { AppError } from '../errors.js';
import { pickSafeLan, subnetsOverlap } from '../net.js';
import { checkInternet } from '../status/connectivity.js';
import { asList, findSection } from '../uci.js';
import { removePortFromLanBridge, stageWifiSettings } from './shared.js';
import {
  optionalDnsList,
  requireIpv4,
  requireLeaseTime,
  requireNetmask,
  requireOneOf,
  requireSsid,
  requireWifiKey,
  str,
} from '../validate.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function parseRouterOptions(body = {}) {
  const connection = requireOneOf(body.connection ?? 'auto', ['auto', 'pppoe', 'static'], 'connection');

  const options = { connection, lan: {}, wifi: { enabled: false } };

  if (body.macaddr) {
    const mac = String(body.macaddr).trim().toLowerCase();
    if (!/^([0-9a-f]{2}[:-]){5}([0-9a-f]{2})$/.test(mac)) {
      throw new AppError('INVALID_SETTINGS', 'MAC address must be in the format 00:11:22:33:44:55', { status: 400 });
    }
    options.macaddr = mac.replace(/-/g, ':');
  }

  if (connection === 'pppoe') {
    const username = str(body.pppoe?.username);
    if (!username) throw new AppError('INVALID_SETTINGS', 'Enter the username your provider gave you.', { status: 400 });
    options.pppoe = { username, password: typeof body.pppoe?.password === 'string' ? body.pppoe.password : '' };
  }

  if (connection === 'static') {
    options.static = {
      ip: requireIpv4(body.static?.ip, 'static.ip'),
      netmask: requireNetmask(body.static?.netmask, 'static.netmask'),
      gateway: requireIpv4(body.static?.gateway, 'static.gateway'),
      dns: optionalDnsList(body.static?.dns, 'static.dns'),
    };
  }

  if (body.lan?.ip) options.lan.ip = requireIpv4(body.lan.ip, 'lan.ip');
  options.lan.netmask = body.lan?.netmask ? requireNetmask(body.lan.netmask, 'lan.netmask') : null;
  options.lan.leasetime = requireLeaseTime(body.lan?.leasetime ?? '12h', 'lan.leasetime');

  if (body.wifi?.enabled) {
    const encryption = requireOneOf(body.wifi.encryption ?? 'psk2', ['psk2', 'sae-mixed', 'none'], 'wifi.encryption');
    options.wifi = {
      enabled: true,
      ssid: requireSsid(body.wifi.ssid, 'wifi.ssid'),
      key: requireWifiKey(body.wifi.key, encryption, 'wifi.key'),
      encryption,
    };
  }

  return options;
}

/** Finds the physical WAN port: uci first, then the board description, then a name guess. */
export async function detectWanDevice(client) {
  const network = await client.uciGet('network');
  const wan = network?.wan;
  if (wan?.device || wan?.ifname) return { device: wan.device ?? wan.ifname, source: 'uci' };

  const boardRaw = await client.readFile('/etc/board.json');
  if (boardRaw) {
    try {
      const board = JSON.parse(boardRaw);
      const device = board?.network?.wan?.device ?? board?.network?.wan?.ports?.[0];
      if (device) return { device, source: 'board.json' };
    } catch {
      /* fall through to the guess below */
    }
  }

  const devices = (await client.tryCall('network.device', 'status', {}, null)) ?? {};
  const guess = Object.keys(devices).find((name) => /^wan/i.test(name)) ?? (devices.eth1 ? 'eth1' : null);
  return guess ? { device: guess, source: 'guess' } : { device: null, source: 'none' };
}

export async function routerPreflight(client) {
  const { device, source } = await detectWanDevice(client);
  const devices = (await client.tryCall('network.device', 'status', {}, null)) ?? {};
  const physical = device ? devices[device] ?? null : null;

  return {
    wanDevice: device,
    deviceSource: source,
    carrier: physical ? Boolean(physical.carrier) : null,
    speed: physical?.speed ?? null,
    ready: Boolean(device) && (physical ? Boolean(physical.carrier) : true),
    reason: !device
      ? 'No WAN port found on this router.'
      : physical && !physical.carrier
        ? 'No cable detected in the WAN port.'
        : null,
  };
}

async function ensureFirewall(uci, client) {
  const firewall = (await client.uciGet('firewall')) ?? {};

  const wanZone = findSection(firewall, 'zone', (section) => section.name === 'wan');
  if (wanZone) {
    await uci.set('firewall', wanZone.name, {
      input: 'REJECT',
      output: 'ACCEPT',
      forward: 'REJECT',
      masq: '1',
      mtu_fix: '1',
      network: [...new Set([...asList(wanZone.section.network), 'wan', 'wan6'])],
    });
  } else {
    await uci.add('firewall', 'zone', {
      name: 'wan',
      input: 'REJECT',
      output: 'ACCEPT',
      forward: 'REJECT',
      masq: '1',
      mtu_fix: '1',
      network: ['wan', 'wan6'],
    });
  }

  const lanZone = findSection(firewall, 'zone', (section) => section.name === 'lan');
  if (lanZone) {
    await uci.set('firewall', lanZone.name, {
      input: 'ACCEPT',
      output: 'ACCEPT',
      forward: 'ACCEPT',
      network: [...new Set([...asList(lanZone.section.network), 'lan'])],
    });
  } else {
    await uci.add('firewall', 'zone', {
      name: 'lan',
      input: 'ACCEPT',
      output: 'ACCEPT',
      forward: 'ACCEPT',
      network: ['lan'],
    });
  }

  const forwarding = findSection(
    firewall,
    'forwarding',
    (section) => section.src === 'lan' && section.dest === 'wan',
  );
  if (!forwarding) await uci.add('firewall', 'forwarding', { src: 'lan', dest: 'wan' });
}

export const routerModePlan = {
  label: 'Router Mode',

  async preflight(ctx) {
    const preflight = await routerPreflight(ctx.client);
    if (!preflight.wanDevice) {
      throw new AppError('NO_WAN_PORT', 'This router has no WAN port that EasyMode can use.', { status: 409 });
    }
    if (preflight.carrier === false) {
      throw new AppError(
        'NO_WAN_LINK',
        'Plug the cable from your modem or main router into the WAN port, then try again.',
        { status: 409 },
      );
    }
    ctx.facts.wanDevice = preflight.wanDevice;
    ctx.facts.preflightDetail = `WAN port ${preflight.wanDevice}${preflight.speed ? ` at ${preflight.speed}` : ''}`;
  },

  async stageNetwork(ctx) {
    const { uci, client, options } = ctx;
    const network = (await client.uciGet('network')) ?? {};
    const lan = network.lan ?? {};

    const currentLanIp = lan.ipaddr ?? ctx.session.host;
    const lanNetmask = options.lan.netmask ?? lan.netmask ?? '255.255.255.0';

    // A static WAN in the same range as the LAN cannot route; move the LAN out of the way.
    let lanIp = options.lan.ip ?? currentLanIp;
    if (options.connection === 'static') {
      const wanNet = { ip: options.static.ip, mask: options.static.netmask };
      if (subnetsOverlap({ ip: lanIp, mask: lanNetmask }, wanNet)) {
        const safe = pickSafeLan([wanNet], null, lanNetmask);
        if (!safe) {
          throw new AppError('SUBNET_CONFLICT', 'Your home network and internet connection use the same address range, and no free range was found.', { status: 409 });
        }
        lanIp = safe;
        ctx.facts.lanMoved = { from: currentLanIp, to: safe, reason: 'conflict with the internet connection' };
      }
    }

    // Coming from Access Point mode the WAN port sits in the LAN bridge; take it back
    // and drop the upstream gateway/DNS that mode left on the LAN interface.
    await removePortFromLanBridge(ctx, ctx.facts.wanDevice);
    await uci.clearOptions('network', 'lan', ['gateway', 'dns']);

    await uci.ensure('network', 'wan', 'interface', { device: ctx.facts.wanDevice });

    if (options.connection === 'auto') {
      await uci.clearOptions('network', 'wan', ['username', 'password', 'ipaddr', 'netmask', 'gateway', 'dns']);
      await uci.set('network', 'wan', { proto: 'dhcp' });
    } else if (options.connection === 'pppoe') {
      await uci.clearOptions('network', 'wan', ['ipaddr', 'netmask', 'gateway', 'dns']);
      await uci.set('network', 'wan', {
        proto: 'pppoe',
        username: options.pppoe.username,
        password: options.pppoe.password,
      });
    } else {
      await uci.clearOptions('network', 'wan', ['username', 'password']);
      await uci.set('network', 'wan', {
        proto: 'static',
        ipaddr: options.static.ip,
        netmask: options.static.netmask,
        gateway: options.static.gateway,
        ...(options.static.dns.length ? { dns: options.static.dns } : {}),
      });
    }

    if (options.macaddr) {
      await uci.set('network', 'wan', { macaddr: options.macaddr });
    } else {
      await uci.clearOptions('network', 'wan', ['macaddr']);
    }

    await uci.set('network', 'lan', { proto: 'static', ipaddr: lanIp, netmask: lanNetmask });
    if (lanIp !== ctx.session.host) ctx.facts.newLanIp = lanIp;
    ctx.facts.lanIp = lanIp;
    ctx.facts.lanNetmask = lanNetmask;

    const dhcp = (await client.uciGet('dhcp')) ?? {};
    const lanDhcp = findSection(dhcp, 'dhcp', (section, name) => section.interface === 'lan' || name === 'lan');
    const dhcpValues = {
      interface: 'lan',
      start: lanDhcp?.section.start ?? '100',
      limit: lanDhcp?.section.limit ?? '150',
      leasetime: ctx.options.lan.leasetime,
      ignore: '0',
    };
    if (lanDhcp) await uci.set('dhcp', lanDhcp.name, dhcpValues);
    else await uci.ensure('dhcp', 'lan', 'dhcp', dhcpValues);

    await ensureFirewall(uci, client);

    ctx.facts.networkDetail = ctx.facts.lanMoved
      ? `Home network moved to ${lanIp} to avoid a clash`
      : `Internet via ${options.connection === 'auto' ? 'automatic (DHCP)' : options.connection.toUpperCase()}, home network ${lanIp}`;
  },

  stageWifi: (ctx) => stageWifiSettings(ctx, { network: 'lan' }),

  async verify(ctx) {
    const client = ctx.client;
    let wan = null;

    // A DHCP lease or a PPPoE session needs a moment; poll instead of guessing.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const dump = await client.call('network.interface', 'dump');
      wan = (dump.interface ?? []).find((iface) => iface.interface === 'wan');
      const address = wan?.['ipv4-address']?.[0];
      if (wan?.up && address) break;
      await sleep(3000);
    }

    const address = wan?.['ipv4-address']?.[0];
    if (!wan?.up || !address) {
      return {
        ok: false,
        reason:
          ctx.options.connection === 'pppoe'
            ? 'The router could not sign in to your provider. Check the username and password.'
            : 'The internet connection did not come up. Check the cable, or try a different connection type.',
      };
    }

    const lanNet = { ip: ctx.facts.lanIp, mask: ctx.facts.lanNetmask ?? '255.255.255.0' };
    const wanNet = { ip: address.address, mask: String(address.mask) };
    if (subnetsOverlap(lanNet, wanNet)) {
      const suggestion = pickSafeLan([wanNet]);
      return {
        ok: false,
        reason: `Your internet connection uses the same address range as your home network (${address.address}). Set the home network to ${suggestion ?? 'another range'} and try again.`,
      };
    }

    const gateway = (wan.route ?? []).find((route) => route.target === '0.0.0.0')?.nexthop ?? null;
    const network = { wan: { up: true, gateway, dns: wan['dns-server'] ?? [] } };
    const internet = await checkInternet(client, network);

    if (internet.online === false) {
      return { ok: false, reason: 'The connection came up but the internet is not reachable.' };
    }

    return {
      ok: true,
      detail:
        internet.online === true
          ? `Internet reachable, address ${address.address}`
          : `Address ${address.address} received. ${internet.detail ?? ''}`.trim(),
      summary: {
        wanIp: address.address,
        gateway,
        lanIp: ctx.facts.lanIp,
        internetVerified: internet.online === true,
        lanMoved: ctx.facts.lanMoved ?? null,
      },
    };
  },
};
