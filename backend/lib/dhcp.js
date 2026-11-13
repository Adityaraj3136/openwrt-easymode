import { commitWithRollback } from './apply.js';
import { blockingSupport, listBlocks } from './clients.js';
import { snapshotConfigs } from './backup.js';
import { parseDhcpLeases } from './derive.js';
import { AppError } from './errors.js';
import { bitsToMask, hostInSubnet, ipToInt, isIpv4, networkAddress, subnetsOverlap } from './net.js';
import { lanServesIpv6 } from './ipv6.js';
import { fetchLeases } from './status/network.js';
import { Uci, findSection, findSections } from './uci.js';
import { requireIpv4, requireLeaseTime, requireRange, str } from './validate.js';

const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

export function normalizeMac(value, field = 'mac') {
  const mac = str(value).toLowerCase().replace(/-/g, ':');
  if (!MAC_RE.test(mac)) {
    throw new AppError('INVALID_SETTINGS', `"${value}" is not a valid device address (MAC).`, {
      status: 400,
      details: `Field: ${field}`,
    });
  }
  return mac;
}

/**
 * Turns dnsmasq's start/limit into real first and last addresses, and refuses ranges
 * that leave the subnet or swallow the router itself.
 */
export function planRange({ routerIp, netmask, start, limit }) {
  const net = networkAddress(routerIp, netmask);
  if (!net) throw new AppError('INVALID_SETTINGS', 'The router address or network mask is not valid.', { status: 400 });

  const size = 2 ** (32 - net.bits);
  const first = Number(start);
  const count = Number(limit);
  if (!Number.isInteger(first) || first < 1 || !Number.isInteger(count) || count < 1) {
    throw new AppError('INVALID_SETTINGS', 'The address range must start at 1 or higher and contain at least one address.', { status: 400 });
  }
  const last = first + count - 1;
  if (last >= size - 1) {
    throw new AppError(
      'INVALID_SETTINGS',
      'That range does not fit in your home network. Reduce the number of addresses.',
      { status: 400 },
    );
  }

  const firstIp = hostInSubnet(routerIp, netmask, first);
  const lastIp = hostInSubnet(routerIp, netmask, last);
  const routerOffset = ipToInt(routerIp) - net.base;
  if (routerOffset >= first && routerOffset <= last) {
    throw new AppError(
      'INVALID_SETTINGS',
      `That range includes the router's own address (${routerIp}). Start the range after it.`,
      { status: 400 },
    );
  }

  return { firstIp, lastIp, start: first, limit: count };
}

/** Reservations must sit in the LAN, avoid the router, and not double up. */
export function validateReservation({ ip, mac, routerIp, netmask, existing = [], section = null }) {
  const address = requireIpv4(ip, 'ip');
  const macAddress = normalizeMac(mac);

  if (!subnetsOverlap({ ip: address, mask: netmask }, { ip: routerIp, mask: netmask })) {
    throw new AppError('INVALID_SETTINGS', `${address} is not on your home network.`, { status: 400 });
  }
  if (address === routerIp) {
    throw new AppError('INVALID_SETTINGS', 'That is the router’s own address.', { status: 400 });
  }
  for (const entry of existing) {
    if (entry.section === section) continue;
    if (entry.ip === address) {
      throw new AppError('DUPLICATE_RESERVATION', `${address} is already reserved for another device.`, { status: 409 });
    }
    if (entry.mac === macAddress) {
      throw new AppError('DUPLICATE_RESERVATION', 'That device already has a reserved address.', { status: 409 });
    }
  }
  return { ip: address, mac: macAddress };
}

const lanDhcpSection = (dhcpConfig) =>
  findSection(dhcpConfig, 'dhcp', (section, name) => section.interface === 'lan' || name === 'lan');

export async function getDhcpStatus(client, session) {
  const network = (await client.uciGet('network')) ?? {};
  const dhcpConfig = (await client.uciGet('dhcp')) ?? {};
  const easymode = (await client.uciGet('easymode')) ?? {};

  const lan = network.lan ?? {};
  const [routerIp, prefix] = String(lan.ipaddr ?? session.host).split('/');
  const netmask = lan.netmask ?? (prefix ? bitsToMask(Number(prefix)) : '255.255.255.0');
  const lanDhcp = lanDhcpSection(dhcpConfig);
  const section = lanDhcp?.section ?? {};
  const enabled = section.ignore !== '1' && section.ignore !== 1;

  const start = Number(section.start ?? 100);
  const limit = Number(section.limit ?? 150);

  const reservations = findSections(dhcpConfig, 'host').map(({ name, section: host }) => ({
    section: name,
    name: host.name ?? null,
    mac: Array.isArray(host.mac) ? host.mac[0] : host.mac ?? null,
    ip: host.ip ?? null,
  }));

  // First use: EasyMode has never recorded a mode, so read it off the live config instead
  // of assuming "router" - otherwise an existing access point gets a second DHCP server.
  const recordedMode = Object.values(easymode).find((entry) => entry['.type'] === 'state')?.mode ?? null;
  const looksLikeAp = lan.proto === 'dhcp' || (!enabled && Boolean(lan.gateway));
  const storedMode = recordedMode ?? (network.wwan ? 'repeater' : looksLikeAp ? 'ap' : null);
  const leases = await fetchLeases(client, session);

  const dnsOption = []
    .concat(section.dhcp_option ?? [])
    .find((option) => String(option).startsWith('6,'));

  // Device names are resolved from the lease and reservation lists rather than stored
  // on the firewall rule, so the rules stay exactly the shape LuCI writes.
  const nameFor = (mac) =>
    leases.find((lease) => lease.mac === mac)?.hostname ??
    reservations.find((entry) => entry.mac === mac)?.name ??
    null;
  const blocked = listBlocks(await client.uciGet('firewall')).map((entry) => ({ ...entry, label: nameFor(entry.mac) }));
  const blockedMacs = new Set(blocked.map((entry) => entry.mac));

  const ipv6Enabled = lanServesIpv6(lanDhcp?.section);

  return {
    enabled,
    ipv6Enabled,
    routerIp,
    netmask,
    start,
    limit,
    leasetime: section.leasetime ?? '12h',
    rangeStart: hostInSubnet(routerIp, netmask, start),
    rangeEnd: hostInSubnet(routerIp, netmask, start + limit - 1),
    dns: dnsOption ? String(dnsOption).slice(2).split(',').filter(Boolean) : [],
    // Access Point mode must not run a second DHCP server on the main router's network.
    managedElsewhere: storedMode === 'ap',
    mode: storedMode,
    leases: leases.map((lease) => ({
      ...lease,
      reserved: reservations.some((entry) => entry.mac === lease.mac),
      blocked: blockedMacs.has(lease.mac),
    })),
    leasesAvailable: session.capabilities?.features?.fileRead || session.capabilities?.features?.dhcpLeases,
    reservations,
    blocked,
    blocking: blockingSupport(storedMode),
  };
}

function guardMode(status, force) {
  if (status.managedElsewhere && !force) {
    throw new AppError(
      'DHCP_MANAGED_ELSEWHERE',
      'This router is set up as an access point, so your main router hands out addresses. Turning on a second one here would cause address clashes.',
      { status: 409, details: 'Send force:true to override deliberately.' },
    );
  }
}

export async function updateDhcp(client, session, body = {}) {
  const status = await getDhcpStatus(client, session);
  const force = body.force === true;
  const enabled = body.enabled === undefined ? status.enabled : Boolean(body.enabled);
  if (enabled) guardMode(status, force);

  const ipv6Enabled = body.ipv6 === undefined ? status.ipv6Enabled : Boolean(body.ipv6);

  const start = requireRange(body.start ?? status.start, { min: 1, max: 65534, fallback: status.start }, 'start');
  const limit = requireRange(body.limit ?? status.limit, { min: 1, max: 65534, fallback: status.limit }, 'limit');
  const leasetime = requireLeaseTime(body.leasetime ?? status.leasetime, 'leasetime');
  const range = planRange({ routerIp: status.routerIp, netmask: status.netmask, start, limit });

  const dns = []
    .concat(body.dns ?? status.dns)
    .flatMap((entry) => String(entry).split(/[,\s]+/))
    .filter(Boolean)
    .map((entry) => requireIpv4(entry, 'dns'));

  const snapshot = await snapshotConfigs(client, ['dhcp', 'network']);
  const uci = new Uci(client);
  const dhcpConfig = (await client.uciGet('dhcp')) ?? {};
  const networkConfig = (await client.uciGet('network')) ?? {};
  const lanDhcp = lanDhcpSection(dhcpConfig);

  const values = {
    interface: 'lan',
    start: String(start),
    limit: String(limit),
    leasetime,
    ignore: enabled ? '0' : '1',
  };
  
  const isRepeater = !!networkConfig.wwan;

  // IPv6 is owned by the /ipv6 toggle. Saving DHCP must not silently switch it off;
  // only when it is already off do we re-assert the pure-IPv4 cleanup below.
  const keepIpv6 = lanServesIpv6(lanDhcp?.section);
  if (!keepIpv6) {
    values.dhcpv6 = 'disabled';
    values.ra = 'disabled';
    values.ndp = 'disabled';
  }

  if (lanDhcp) await uci.set('dhcp', lanDhcp.name, values);
  else await uci.ensure('dhcp', 'lan', 'dhcp', values);

  const sectionName = lanDhcp?.name ?? 'lan';
  if (dns.length) await uci.set('dhcp', sectionName, { dhcp_option: [`6,${dns.join(',')}`] });
  else await uci.clearOptions('dhcp', sectionName, ['dhcp_option']);

  // Disable kernel IPv6 on the LAN interface so devices drop cached prefixes
  if (!keepIpv6) await uci.set('network', 'lan', { ipv6: '0' });

  // For repeater mode: remove any IPv6 interfaces and relays
  if (isRepeater && !keepIpv6) {
    const wwanKey = Object.keys(networkConfig).find(k => networkConfig[k]?.proto === 'dhcp' && k.startsWith('wwan')) ?? 'wwan';
    // Disable kernel IPv6 on the STA interface so Airtel's RAs are not processed.
    await uci.set('network', wwanKey, { ipv6: '0' });
    // Remove the wwan6 network interface and the relay master section.
    await uci.delete('network', 'wwan6');
    await uci.delete('dhcp', 'wwan');
  }

  // For DHCP-only changes, skip the heavy commitWithRollback.
  await uci.commitAll();

  // Wait up to 10s for cron to fire (it usually fires in <2s on this router).
  // Use short individual timeouts to avoid hitting the 8s ubus timeout.
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const crontab = await client.tryCall('file', 'read', { path: '/etc/crontabs/root' }) || { data: '' };
      if (!crontab.data.includes('easymode_commit_all')) break;
    } catch {
      // briefly unreachable during reload — keep waiting
    }
  }

  // Read and return the actual committed state from the router
  try {
    return { ...(await getDhcpStatus(client, session)), range };
  } catch {
    // If router is briefly restarting odhcpd, return desired state optimistically
    return { ...status, ipv6Enabled, range };
  }
}

export async function addReservation(client, session, body = {}) {
  const status = await getDhcpStatus(client, session);
  const { ip, mac } = validateReservation({
    ip: body.ip,
    mac: body.mac,
    routerIp: status.routerIp,
    netmask: status.netmask,
    existing: status.reservations,
  });
  const name = str(body.name).slice(0, 63) || null;

  const snapshot = await snapshotConfigs(client, ['dhcp']);
  const uci = new Uci(client);
  await uci.add('dhcp', 'host', { ip, mac, ...(name ? { name } : {}) });
  await commitWithRollback({ client, session, uci, snapshot, settleMs: 1500 });
  return getDhcpStatus(client, session);
}

export async function deleteReservation(client, session, sectionName) {
  const status = await getDhcpStatus(client, session);
  if (!status.reservations.some((entry) => entry.section === sectionName)) {
    throw new AppError('NOT_FOUND', 'That reserved address no longer exists.', { status: 404 });
  }

  const snapshot = await snapshotConfigs(client, ['dhcp']);
  const uci = new Uci(client);
  await uci.delete('dhcp', sectionName);
  await commitWithRollback({ client, session, uci, snapshot, settleMs: 1500 });
  return getDhcpStatus(client, session);
}

export { isIpv4 };
