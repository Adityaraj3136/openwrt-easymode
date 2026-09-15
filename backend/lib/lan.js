import { commitWithRollback } from './apply.js';
import { snapshotConfigs } from './backup.js';
import { AppError } from './errors.js';
import { maskToBits, pickSafeLan, subnetsOverlap } from './net.js';
import { readInterface } from './probe.js';
import { Uci } from './uci.js';
import { requireIpv4, requireNetmask } from './validate.js';

/**
 * The LAN address is the address people type to reach the router, so this is also
 * where the sign-in page lives. Changing it moves both.
 */
export async function getLanSettings(client, session) {
  const network = (await client.uciGet('network')) ?? {};
  const lan = network.lan ?? {};
  const ip = lan.ipaddr ?? session.host;
  const netmask = lan.netmask ?? '255.255.255.0';

  const live = await readInterface(client, 'lan');
  const address = live?.['ipv4-address']?.[0] ?? null;

  return {
    ip,
    netmask,
    prefix: maskToBits(netmask),
    // What the browser should use afterwards.
    loginUrl: `${session.scheme}://${ip}`,
    liveIp: address?.address ?? null,
    // Set by Access Point mode; shown so the page can explain the locked state.
    gateway: lan.gateway ?? null,
    managedElsewhere: Boolean(lan.gateway),
  };
}

export async function updateLan(client, session, body = {}) {
  const ip = requireIpv4(body.ip, 'ip');
  const netmask = requireNetmask(body.netmask ?? '255.255.255.0', 'netmask');
  const current = await getLanSettings(client, session);

  if (ip === current.ip && netmask === current.netmask) {
    return { ...current, changed: false };
  }

  // The router cannot sit on the same network on both sides, or it has no idea
  // which way to send traffic.
  const dump = await client.call('network.interface', 'dump');
  const uplinks = (dump.interface ?? []).filter(
    (iface) => iface.interface !== 'lan' && iface.interface !== 'loopback' && iface.up,
  );
  for (const uplink of uplinks) {
    const address = uplink['ipv4-address']?.[0];
    if (!address) continue;
    if (subnetsOverlap({ ip, mask: netmask }, { ip: address.address, mask: String(address.mask) })) {
      const suggestion = pickSafeLan([{ ip: address.address, mask: String(address.mask) }], null, netmask);
      throw new AppError(
        'SUBNET_CONFLICT',
        `That address is on the same range as your internet connection (${address.address}). Devices would not know where to send traffic.`,
        { status: 409, details: suggestion ? `Try ${suggestion} instead.` : undefined },
      );
    }
  }

  const snapshot = await snapshotConfigs(client, ['network', 'dhcp']);
  const uci = new Uci(client);
  await uci.set('network', 'lan', { proto: 'static', ipaddr: ip, netmask });

  await commitWithRollback({
    client,
    session,
    uci,
    snapshot,
    settleMs: 4000,
    // The router is about to answer on the new address, so look there first.
    candidates: [ip],
    verify: async (live) => {
      const lan = await readInterface(live, 'lan');
      const address = lan?.['ipv4-address']?.[0];
      return address?.address === ip
        ? { ok: true }
        : { ok: false, reason: 'The router did not take the new address, so the previous one was restored.' };
    },
  });

  return { ...(await getLanSettings(client, session)), changed: true };
}
