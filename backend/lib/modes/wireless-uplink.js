import { encryptionLabel } from '../derive.js';
import { AppError } from '../errors.js';
import { pickSafeLan, subnetsOverlap } from '../net.js';
import { leaseFacts, readInterface, waitForLease } from '../probe.js';
import { checkInternet } from '../status/connectivity.js';
import { asList, findSection } from '../uci.js';
import {
  optionalIpv4,
  requireOneOf,
  requireSsid,
  requireWifiKey,
  str,
} from '../validate.js';
import { detectWanDevice } from './router.js';
import { removePortFromLanBridge, stageWifiSettings } from './shared.js';

const UPLINK_NETWORK = 'wwan';
const STA_SECTION = 'easymode_sta';
const ENCRYPTIONS = ['psk2', 'psk', 'sae-mixed', 'sae', 'none'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Shared by Wireless Repeater and Phone Hotspot: the wire-level setup is identical. */
export function parseWirelessUplinkOptions(body = {}) {
  const radio = str(body.radio);
  if (!radio) throw new AppError('INVALID_SETTINGS', 'Choose which Wi-Fi radio should connect.', { status: 400 });

  const encryption = requireOneOf(body.encryption ?? 'psk2', ENCRYPTIONS, 'encryption');
  const options = {
    radio,
    ssid: requireSsid(body.ssid, 'ssid'),
    key: requireWifiKey(body.key, encryption, 'key'),
    encryption,
    lan: { ip: optionalIpv4(body.lan?.ip, 'lan.ip') },
    wifi: { enabled: false },
  };

  if (body.wifi?.enabled) {
    const localEncryption = requireOneOf(body.wifi.encryption ?? 'psk2', ['psk2', 'sae-mixed', 'none'], 'wifi.encryption');
    options.wifi = {
      enabled: true,
      ssid: requireSsid(body.wifi.ssid, 'wifi.ssid'),
      key: requireWifiKey(body.wifi.key, localEncryption, 'wifi.key'),
      encryption: localEncryption,
    };
  }
  return options;
}

/** Live association state of the client interface. */
export async function getStaState(client, radioId) {
  const status = await client.tryCall('network.wireless', 'status', {}, null);
  const radio = status?.[radioId];

  if (radio) {
    const sta = (radio.interfaces ?? []).find((iface) => iface.config?.mode === 'sta');
    if (!sta?.ifname) return { ifname: null, associated: false, ssid: null, signal: null };
    const info = await client.tryCall('iwinfo', 'info', { device: sta.ifname }, null);
    return {
      ifname: sta.ifname,
      associated: Boolean(info?.ssid),
      ssid: info?.ssid ?? null,
      signal: info?.signal ?? null,
    };
  }

  // Fallback: derive STA ifname from UCI. Convention: radio0 → phy0-sta0, radio1 → phy1-sta0.
  const uciWireless = (await client.uciGet('wireless')) ?? {};
  const staSection = Object.values(uciWireless).find(
    (s) => s['.type'] === 'wifi-iface' && s.device === radioId && s.mode === 'sta',
  );
  if (!staSection) return { ifname: null, associated: false, ssid: null, signal: null };

  const index = radioId.replace(/\D/g, '');
  const ifname = staSection.ifname ?? (index !== '' ? `phy${index}-sta0` : null);
  if (!ifname) return { ifname: null, associated: false, ssid: null, signal: null };

  const info = await client.tryCall('iwinfo', 'info', { device: ifname }, null);
  return {
    ifname,
    associated: Boolean(info?.ssid),
    ssid: info?.ssid ?? null,
    signal: info?.signal ?? null,
  };
}

async function waitForAssociation(client, radioId, { attempts = 10, delayMs = 3000 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const state = await getStaState(client, radioId);
    if (state.associated) return state;
    await sleep(delayMs);
  }
  return null;
}

/**
 * Stages the client interface and brings it up on its own, before the rest of the
 * mode is configured. Two reasons: a wrong Wi-Fi password is caught while the router
 * is still in its old working state, and the upstream subnet is known before we
 * decide where the local network should live.
 */
async function connectUplink(ctx) {
  const { client, uci, options } = ctx;

  const wireless = (await client.uciGet('wireless')) ?? {};
  const existing = findSection(wireless, 'wifi-iface', (section) => section.mode === 'sta');
  const values = {
    device: options.radio,
    mode: 'sta',
    network: UPLINK_NETWORK,
    ssid: options.ssid,
    encryption: options.encryption,
    disabled: '0',
    ...(options.encryption === 'none' ? {} : { key: options.key }),
  };

  if (existing) {
    await uci.set('wireless', existing.name, values);
    if (options.encryption === 'none') await uci.clearOptions('wireless', existing.name, ['key']);
    ctx.facts.staSection = existing.name;
  } else {
    await uci.ensure('wireless', STA_SECTION, 'wifi-iface', values);
    ctx.facts.staSection = STA_SECTION;
  }

  // A radio carrying both the uplink and the local Wi-Fi must follow the upstream channel.
  await uci.set('wireless', options.radio, { disabled: '0', channel: 'auto' });
  await uci.ensure('network', UPLINK_NETWORK, 'interface', { proto: 'dhcp' });

  await uci.apply(60);
  await uci.confirm();
  // Live from here on: if anything below fails, recovery must restore, not just revert.
  ctx.noteInterimApply();

  const association = await waitForAssociation(client, options.radio);
  if (!association) {
    throw new AppError(
      'UPLINK_NOT_ASSOCIATED',
      options.encryption === 'none'
        ? `Could not join "${options.ssid}". It may be out of range.`
        : `Could not join "${options.ssid}". The Wi-Fi password was not accepted, or the network is out of range.`,
      { status: 409 },
    );
  }

  const lease = await waitForLease(client, UPLINK_NETWORK);
  if (!lease?.gateway) {
    throw new AppError(
      'UPLINK_NO_ADDRESS',
      `Joined "${options.ssid}" but it did not give this router an address.`,
      { status: 409 },
    );
  }

  return { association, lease };
}

export function createWirelessUplinkPlan({ mode, label, sourceNoun }) {
  return {
    label,

    async preflight(ctx) {
      // Verify the selected radio actually exists. network.wireless.status is tried first;
      // if it doesn't include the radio (vendor firmware quirk), fall back to UCI config.
      const status = (await ctx.client.tryCall('network.wireless', 'status', {}, null)) ?? {};
      if (!status[ctx.options.radio]) {
        const uciWireless = (await ctx.client.uciGet('wireless')) ?? {};
        const uciRadio = Object.values(uciWireless).find(
          (s) => s['.type'] === 'wifi-device' && s['.name'] === ctx.options.radio,
        );
        if (!uciRadio) {
          throw new AppError('NO_SUCH_RADIO', 'That Wi-Fi radio does not exist on this router.', { status: 404 });
        }
      }

      const { association, lease } = await connectUplink(ctx);
      ctx.facts.uplink = { ...association, ...lease };
      ctx.facts.preflightDetail = `Joined "${association.ssid}"${
        association.signal ? ` at ${association.signal} dBm` : ''
      }`;
    },

    async stageNetwork(ctx) {
      const { uci, client, options } = ctx;
      const upstream = ctx.facts.uplink;

      const network = (await client.uciGet('network')) ?? {};
      const lan = network.lan ?? {};
      const lanNetmask = lan.netmask ?? '255.255.255.0';
      let lanIp = options.lan.ip ?? lan.ipaddr ?? ctx.session.host;

      // The upstream is very often 192.168.1.0/24 - and so is the default LAN.
      if (subnetsOverlap({ ip: lanIp, mask: lanNetmask }, { ip: upstream.ip, mask: upstream.mask })) {
        const safe = pickSafeLan([{ ip: upstream.ip, mask: upstream.mask }], null, lanNetmask);
        if (!safe) {
          throw new AppError('SUBNET_CONFLICT', `Your ${sourceNoun} uses the same address range as this router, and no free range was found.`, { status: 409 });
        }
        ctx.facts.lanMoved = { from: lanIp, to: safe };
        lanIp = safe;
      }

      // Coming from Access Point mode: stop bridging the wired uplink and route again.
      const { device: wanDevice } = await detectWanDevice(client);
      if (wanDevice) {
        await removePortFromLanBridge(ctx, wanDevice);
        if (network.wan) await uci.set('network', 'wan', { proto: 'none' });
      }
      await uci.clearOptions('network', 'lan', ['gateway', 'dns']);

      await uci.set('network', 'lan', { proto: 'static', ipaddr: lanIp, netmask: lanNetmask });
      if (lanIp !== ctx.session.host) ctx.facts.newLanIp = lanIp;
      ctx.facts.lanIp = lanIp;

      // Local devices get their addresses from this router.
      const dhcp = (await client.uciGet('dhcp')) ?? {};
      const lanDhcp = findSection(dhcp, 'dhcp', (section, name) => section.interface === 'lan' || name === 'lan');
      const dhcpValues = {
        interface: 'lan',
        start: lanDhcp?.section.start ?? '100',
        limit: lanDhcp?.section.limit ?? '150',
        leasetime: lanDhcp?.section.leasetime ?? '12h',
        ignore: '0',
      };
      if (lanDhcp) await uci.set('dhcp', lanDhcp.name, dhcpValues);
      else await uci.ensure('dhcp', 'lan', 'dhcp', dhcpValues);

      // Internet sharing: the wireless uplink is treated exactly like a WAN port.
      const firewall = (await client.uciGet('firewall')) ?? {};
      const wanZone = findSection(firewall, 'zone', (section) => section.name === 'wan');
      if (wanZone) {
        await uci.set('firewall', wanZone.name, {
          masq: '1',
          mtu_fix: '1',
          input: 'REJECT',
          output: 'ACCEPT',
          forward: 'REJECT',
          network: [...new Set([...asList(wanZone.section.network), UPLINK_NETWORK])],
        });
      } else {
        await uci.add('firewall', 'zone', {
          name: 'wan',
          input: 'REJECT',
          output: 'ACCEPT',
          forward: 'REJECT',
          masq: '1',
          mtu_fix: '1',
          network: [UPLINK_NETWORK],
        });
      }

      const lanZone = findSection(firewall, 'zone', (section) => section.name === 'lan');
      if (lanZone) {
        await uci.set('firewall', lanZone.name, { input: 'ACCEPT', output: 'ACCEPT', forward: 'ACCEPT' });
      }
      if (!findSection(firewall, 'forwarding', (section) => section.src === 'lan' && section.dest === 'wan')) {
        await uci.add('firewall', 'forwarding', { src: 'lan', dest: 'wan' });
      }

      ctx.facts.networkDetail = ctx.facts.lanMoved
        ? `Local network moved to ${lanIp} to avoid a clash with the ${sourceNoun}`
        : `Local network stays on ${lanIp}`;
    },

    stageWifi: (ctx) => stageWifiSettings(ctx, { network: 'lan' }),

    async verify(ctx) {
      const client = ctx.client;

      const state = await waitForAssociation(client, ctx.options.radio, { attempts: 6, delayMs: 3000 });
      if (!state) {
        return { ok: false, reason: `The connection to "${ctx.options.ssid}" dropped after the change.` };
      }

      const lease = leaseFacts(await readInterface(client, UPLINK_NETWORK));
      if (!lease?.gateway) {
        return { ok: false, reason: `"${ctx.options.ssid}" stopped giving this router an address.` };
      }

      const internet = await checkInternet(client, {
        wan: { up: true, gateway: lease.gateway, dns: lease.dns ?? [] },
      });
      if (internet.online === false) {
        return { ok: false, reason: `Joined "${ctx.options.ssid}", but there is no internet through it.` };
      }

      return {
        ok: true,
        detail: `Connected to "${state.ssid}"${state.signal ? ` at ${state.signal} dBm` : ''}`,
        summary: {
          uplinkSsid: state.ssid,
          uplinkSignal: state.signal,
          uplinkSecurity: encryptionLabel(ctx.options.encryption),
          lanIp: ctx.facts.lanIp,
          lanMoved: ctx.facts.lanMoved ?? null,
          internetVerified: internet.online === true,
          mode,
        },
      };
    },
  };
}

export const repeaterModePlan = createWirelessUplinkPlan({
  mode: 'repeater',
  label: 'Wireless Repeater Mode',
  sourceNoun: 'main Wi-Fi network',
});

// Identical configuration on the wire; only the stored intent and the wording differ.
// That stored intent is the only thing that lets the dashboard tell them apart later.
export const hotspotModePlan = createWirelessUplinkPlan({
  mode: 'hotspot',
  label: 'Phone Hotspot Mode',
  sourceNoun: 'phone hotspot',
});
