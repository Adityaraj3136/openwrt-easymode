import { AppError } from '../errors.js';
import { bitsToMask, isIpv4, maskToBits, pickManagementAddress, subnetsOverlap } from '../net.js';
import { canReach, isAddressFree, leaseFacts, readInterface, waitForLease } from '../probe.js';
import { checkInternet } from '../status/connectivity.js';
import { findSection } from '../uci.js';
import { addPortToLanBridge, portsWithCarrier, stageWifiSettings } from './shared.js';
import { detectWanDevice } from './router.js';
import {
  optionalIpv4,
  requireIpv4,
  requireNetmask,
  requireOneOf,
  requireSsid,
  requireWifiKey,
  str,
} from '../validate.js';

const PROBE_IFACE = 'emprobe';

export function parseApOptions(body = {}) {
  const uplink = requireOneOf(body.uplink ?? 'wan', ['wan', 'lan'], 'uplink');
  const options = { uplink, wifi: { enabled: false }, manual: null };

  // Optional escape hatch for networks with no DHCP server upstream.
  if (body.manual?.ip) {
    options.manual = {
      ip: requireIpv4(body.manual.ip, 'manual.ip'),
      netmask: requireNetmask(body.manual.netmask, 'manual.netmask'),
      gateway: requireIpv4(body.manual.gateway, 'manual.gateway'),
      dns: optionalIpv4(body.manual.dns, 'manual.dns'),
    };
  }
  if (body.managementIp) options.managementIp = requireIpv4(body.managementIp, 'managementIp');

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

export async function apPreflightInfo(client) {
  const ports = await portsWithCarrier(client);
  const { device: wanDevice } = await detectWanDevice(client);
  const wanPort = ports.find((port) => port.name === wanDevice) ?? null;
  const otherLive = ports.filter((port) => port.carrier && port.name !== wanDevice);

  return {
    wanDevice,
    wanCarrier: wanPort ? wanPort.carrier : null,
    livePorts: ports.filter((port) => port.carrier).map((port) => port.name),
    suggestedUplink: wanPort?.carrier ? 'wan' : otherLive.length ? 'lan' : null,
    ready: Boolean(wanPort?.carrier) || otherLive.length > 0,
    reason:
      wanPort?.carrier || otherLive.length
        ? null
        : 'No network cable detected. Connect this router to your main router first.',
  };
}

/**
 * Asks the main router for an address so we learn its subnet, gateway and DNS, and
 * prove a DHCP server is actually there.
 *
 * Two shapes: a cable in the WAN port uses the existing `wan` interface; a cable in a
 * LAN port gets a temporary interface on the LAN bridge. Both are committed with the
 * rollback timer armed, and both are undone during staging.
 */
async function probeUpstream(ctx) {
  const { client, uci, options } = ctx;

  if (options.uplink === 'wan') {
    const existing = leaseFacts(await readInterface(client, 'wan'));
    if (existing?.gateway) return { facts: existing, via: 'wan', probeAdded: false };

    const { device } = await detectWanDevice(client);
    if (!device) throw new AppError('NO_WAN_PORT', 'This router has no WAN port.', { status: 409 });
    await uci.ensure('network', 'wan', 'interface', { proto: 'dhcp', device });
    await uci.clearOptions('network', 'wan', ['ipaddr', 'netmask', 'gateway', 'username', 'password']);
    await uci.apply(60);
    await uci.confirm();
    ctx.noteInterimApply();

    const facts = await waitForLease(client, 'wan');
    return { facts, via: 'wan', probeAdded: false, device };
  }

  const network = (await client.uciGet('network')) ?? {};
  const lanDevice = network.lan?.device ?? 'br-lan';

  // Our own dnsmasq answers on this bridge, so without switching it off first the
  // probe would lease an address from this very router and report it as "upstream".
  const dhcpConfig = (await client.uciGet('dhcp')) ?? {};
  const lanDhcp = findSection(dhcpConfig, 'dhcp', (section, name) => section.interface === 'lan' || name === 'lan');
  if (lanDhcp) await uci.set('dhcp', lanDhcp.name, { ignore: '1' });

  await uci.ensure('network', PROBE_IFACE, 'interface', { proto: 'dhcp', device: lanDevice });
  await uci.apply(60);
  await uci.confirm();
  ctx.noteInterimApply();

  const facts = await waitForLease(client, PROBE_IFACE);
  const ourLanIp = network.lan?.ipaddr ?? null;
  if (facts?.gateway && ourLanIp && facts.gateway === ourLanIp) {
    throw new AppError(
      'UPSTREAM_IS_SELF',
      'The address came from this router itself, not from your main router. Check that the cable really goes to the main router.',
      { status: 409 },
    );
  }
  return { facts, via: 'lan', probeAdded: true, device: lanDevice };
}

export const apModePlan = {
  label: 'Access Point Mode',

  async preflight(ctx) {
    const info = await apPreflightInfo(ctx.client);
    if (!info.ready) {
      throw new AppError('NO_UPLINK_LINK', info.reason, { status: 409 });
    }
    if (ctx.options.uplink === 'wan' && info.wanCarrier === false) {
      throw new AppError(
        'NO_UPLINK_LINK',
        'No cable detected in the WAN port. Plug it into your main router, or choose the LAN port option.',
        { status: 409 },
      );
    }

    ctx.facts.uplinkPort = ctx.options.uplink === 'wan' ? info.wanDevice : null;

    if (ctx.options.manual) {
      ctx.facts.upstream = {
        ip: ctx.options.manual.ip,
        mask: ctx.options.manual.netmask,
        gateway: ctx.options.manual.gateway,
        dns: ctx.options.manual.dns ? [ctx.options.manual.dns] : [ctx.options.manual.gateway],
      };
      ctx.facts.managementIp = ctx.options.manual.ip;
      ctx.facts.preflightDetail = `Using the address you entered (${ctx.options.manual.ip})`;
      return;
    }

    const probe = await probeUpstream(ctx);
    ctx.facts.probeAdded = probe.probeAdded;
    if (!probe.facts?.gateway) {
      throw new AppError(
        'NO_UPSTREAM_DHCP',
        'Your main router did not answer with an address. Check the cable, or enter the settings manually.',
        { status: 409 },
      );
    }

    ctx.facts.upstream = probe.facts;
    ctx.facts.preflightDetail = `Main router found at ${probe.facts.gateway}`;

    // The lease is only borrowed: give the address back and take a fixed one outside
    // the pool, so the main router never hands it to someone else.
    const management =
      ctx.options.managementIp ??
      pickManagementAddress(
        { ip: probe.facts.ip, mask: probe.facts.mask, gateway: probe.facts.gateway },
        [probe.facts.ip],
      );
    if (!management) {
      throw new AppError('NO_FREE_ADDRESS', 'Could not find a free address on your main router’s network.', { status: 409 });
    }

    const free = await isAddressFree(ctx.client, management);
    ctx.facts.managementIp = management;
    ctx.facts.managementVerified = free === true;
    if (free === false) {
      const alternative = pickManagementAddress(
        { ip: probe.facts.ip, mask: probe.facts.mask, gateway: probe.facts.gateway },
        [probe.facts.ip, management],
      );
      if (!alternative) {
        throw new AppError('NO_FREE_ADDRESS', 'The addresses EasyMode tried are all in use.', { status: 409 });
      }
      ctx.facts.managementIp = alternative;
    }
  },

  async stageNetwork(ctx) {
    const { uci, client } = ctx;
    const upstream = ctx.facts.upstream;
    const managementIp = ctx.facts.managementIp;
    // A lease reports the mask as prefix bits ("24"); UCI wants a dotted quad.
    const bits = maskToBits(upstream.mask);
    const netmask = isIpv4(upstream.mask) ? upstream.mask : bits != null ? bitsToMask(bits) : '255.255.255.0';

    if (ctx.facts.probeAdded) await uci.delete('network', PROBE_IFACE);

    // The uplink becomes part of the LAN bridge; this device stops routing entirely.
    if (ctx.facts.uplinkPort) {
      const bridged = await addPortToLanBridge(ctx, ctx.facts.uplinkPort);
      ctx.facts.bridgeStyle = bridged.style;
      await uci.ensure('network', 'wan', 'interface', { proto: 'none' });
      await uci.clearOptions('network', 'wan', ['ipaddr', 'netmask', 'gateway', 'username', 'password', 'device']);
      const network = (await client.uciGet('network')) ?? {};
      if (network.wan6) await uci.set('network', 'wan6', { proto: 'none' });
    }

    await uci.set('network', 'lan', {
      proto: 'static',
      ipaddr: managementIp,
      netmask,
      gateway: upstream.gateway,
      dns: upstream.dns?.length ? upstream.dns : [upstream.gateway],
    });
    if (managementIp !== ctx.session.host) ctx.facts.newLanIp = managementIp;

    // Invariant: exactly one DHCP server on this network, and it is the main router's.
    const dhcp = (await client.uciGet('dhcp')) ?? {};
    const lanDhcp = findSection(dhcp, 'dhcp', (section, name) => section.interface === 'lan' || name === 'lan');
    if (lanDhcp) await uci.set('dhcp', lanDhcp.name, { ignore: '1' });
    else await uci.ensure('dhcp', 'lan', 'dhcp', { interface: 'lan', ignore: '1' });

    // Nothing is routed here, so no masquerading; keep the LAN open so the router
    // stays reachable and LuCI keeps working.
    const firewall = (await client.uciGet('firewall')) ?? {};
    const lanZone = findSection(firewall, 'zone', (section) => section.name === 'lan');
    if (lanZone) {
      await uci.set('firewall', lanZone.name, { input: 'ACCEPT', output: 'ACCEPT', forward: 'ACCEPT' });
      if (lanZone.section.masq === '1') await uci.set('firewall', lanZone.name, { masq: '0' });
    }

    ctx.facts.networkDetail = `This router will answer at ${managementIp}; addresses come from ${upstream.gateway}`;
  },

  stageWifi: (ctx) => stageWifiSettings(ctx, { network: 'lan' }),

  async verify(ctx) {
    const client = ctx.client;
    const upstream = ctx.facts.upstream;

    const lan = await readInterface(client, 'lan');
    const address = lan?.['ipv4-address']?.[0];
    if (!lan?.up || address?.address !== ctx.facts.managementIp) {
      return { ok: false, reason: 'The router did not take its new address on your main router’s network.' };
    }

    if (subnetsOverlap({ ip: ctx.facts.managementIp, mask: upstream.mask }, { ip: upstream.gateway, mask: upstream.mask }) === false) {
      return { ok: false, reason: 'The chosen address is not on the same network as your main router.' };
    }

    const reachable = await canReach(client, upstream.gateway);
    if (reachable === false) {
      return { ok: false, reason: 'Your main router stopped answering after the change.' };
    }

    const internet = await checkInternet(client, {
      wan: { up: true, gateway: upstream.gateway, dns: upstream.dns ?? [] },
    });

    return {
      ok: true,
      detail:
        internet.online === true
          ? `Main router reachable, internet working`
          : `Main router reachable at ${upstream.gateway}. ${internet.detail ?? ''}`.trim(),
      summary: {
        managementIp: ctx.facts.managementIp,
        upstreamGateway: upstream.gateway,
        dhcpDisabled: true,
        internetVerified: internet.online === true,
      },
    };
  },
};
