import { commitWithRollback } from './apply.js';
import { Uci, findSection } from './uci.js';

/** odhcpd serves IPv6 to the LAN when RA or DHCPv6 is in server/relay mode. */
export function lanServesIpv6(section) {
  const on = (value) => ['server', 'relay'].includes(String(value ?? '').toLowerCase());
  return Boolean(section) && (on(section.ra) || on(section.dhcpv6));
}

const lanDhcpKey = (dhcpConfig) =>
  findSection(dhcpConfig ?? {}, 'dhcp', (s) => s.interface === 'lan')?.name ?? 'lan';

const uplink6Keys = (networkConfig) =>
  Object.keys(networkConfig ?? {}).filter((key) => networkConfig[key]?.proto === 'dhcpv6');

const DESCRIPTIONS = {
  global: 'IPv6 is on. Devices get internet IPv6 addresses from your provider.',
  local: 'IPv6 is on. Your provider has no IPv6, so devices get router-local (ULA) addresses only.',
  off: 'IPv6 is off. All devices use IPv4 only.',
};

/** Same shape the Android backend returns, so the shared frontend panel works on both. */
export async function getIpv6Status(client) {
  const dhcpConfig = (await client.uciGet('dhcp')) ?? {};
  const networkConfig = (await client.uciGet('network')) ?? {};
  const enabled = lanServesIpv6(dhcpConfig[lanDhcpKey(dhcpConfig)]);
  const mode = !enabled ? 'off' : uplink6Keys(networkConfig).length ? 'global' : 'local';
  return { enabled, mode, supported: true, description: DESCRIPTIONS[mode] };
}

async function setWanZoneMember(uci, firewallConfig, network, member) {
  const zone = findSection(firewallConfig ?? {}, 'zone', (s) => s.name === 'wan');
  if (!zone) return;
  const current = [].concat(zone.section.network ?? []).flatMap((n) => String(n).split(/\s+/)).filter(Boolean);
  const next = member ? [...new Set([...current, network])] : current.filter((n) => n !== network);
  if (next.length !== current.length) await uci.set('firewall', zone.name, { network: next });
}

/**
 * On: LAN serves RA + DHCPv6, plus a wan6 client when a wired wan exists.
 * Off: full revert to IPv4 - stop RA/DHCPv6, kernel IPv6 off on LAN, drop dhcpv6 uplinks.
 * The LAN IPv4 address never moves, so the rollback timer covers a lock-out.
 */
export async function updateIpv6(client, session, body = {}) {
  const enable = body.enabled === true;
  const uci = new Uci(client);
  const dhcpConfig = (await client.uciGet('dhcp')) ?? {};
  const networkConfig = (await client.uciGet('network')) ?? {};
  const firewallConfig = (await client.uciGet('firewall')) ?? {};
  const lanKey = lanDhcpKey(dhcpConfig);

  await uci.set('network', 'lan', { ipv6: enable ? '1' : '0' });
  await uci.set('dhcp', lanKey, {
    ra: enable ? 'server' : 'disabled',
    dhcpv6: enable ? 'server' : 'disabled',
    ndp: 'disabled',
  });

  if (enable && networkConfig.wan) {
    const wanDevice = networkConfig.wan.device || networkConfig.wan.ifname || '@wan';
    await uci.ensure('network', 'wan6', 'interface', {
      proto: 'dhcpv6', device: wanDevice, reqaddress: 'try', reqprefix: 'auto',
    });
    await setWanZoneMember(uci, firewallConfig, 'wan6', true);
  }
  if (!enable) {
    for (const key of uplink6Keys(networkConfig)) {
      await uci.delete('network', key);
      await setWanZoneMember(uci, firewallConfig, key, false);
    }
  }

  const live = await commitWithRollback({ client, session, uci });
  // RA/DHCPv6 changes only reach clients once odhcpd re-announces.
  await live.tryCall('file', 'exec', { command: '/etc/init.d/odhcpd', params: ['restart'] }, null);
  return getIpv6Status(live);
}
