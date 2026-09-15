import { commitWithRollback } from './apply.js';
import { snapshotConfigs } from './backup.js';
import { normalizeMac } from './dhcp.js';
import { AppError } from './errors.js';
import { Uci, findSections } from './uci.js';

// Rules EasyMode owns are tagged by name so they can be found and removed again
// without disturbing anything the user wrote in LuCI.
const PREFIX = 'easymode_block_';

const ruleName = (mac) => `${PREFIX}${mac.replace(/:/g, '')}`;

/**
 * Devices this router is currently blocking.
 *
 * The rule shape is the one LuCI writes for a MAC-based block: a `rule` section with
 * src, src_mac, dest and target.
 */
export function listBlocks(firewallConfig) {
  return findSections(firewallConfig ?? {}, 'rule', (section) => String(section.name ?? '').startsWith(PREFIX)).map(
    ({ name, section }) => ({
      section: name,
      mac: (Array.isArray(section.src_mac) ? section.src_mac[0] : section.src_mac) ?? null,
    }),
  );
}

/**
 * Blocking works by refusing to forward the device's traffic, so it only applies
 * when this router actually routes. In access point mode traffic is bridged straight
 * through and never passes the firewall.
 */
export function blockingSupport(mode) {
  if (mode === 'ap') {
    return {
      available: false,
      reason: 'This router is an access point, so traffic passes straight through it. Block devices on your main router instead.',
    };
  }
  return { available: true, reason: null };
}

export async function blockClient(client, session, body = {}, mode = null) {
  const support = blockingSupport(mode);
  if (!support.available) {
    throw new AppError('BLOCKING_UNAVAILABLE', support.reason, { status: 409 });
  }

  const mac = normalizeMac(body.mac);
  const firewall = (await client.uciGet('firewall')) ?? {};
  if (listBlocks(firewall).some((entry) => entry.mac === mac)) {
    throw new AppError('ALREADY_BLOCKED', 'That device is already blocked.', { status: 409 });
  }

  const snapshot = await snapshotConfigs(client, ['firewall']);
  const uci = new Uci(client);
  await uci.add('firewall', 'rule', {
    name: ruleName(mac),
    src: 'lan',
    src_mac: mac,
    dest: '*',
    target: 'REJECT',
  });

  await commitWithRollback({ client, session, uci, snapshot, settleMs: 1500 });
  return { ok: true, mac };
}

export async function unblockClient(client, session, rawMac) {
  const mac = normalizeMac(rawMac);
  const firewall = (await client.uciGet('firewall')) ?? {};
  const entries = listBlocks(firewall).filter((entry) => entry.mac === mac);
  if (!entries.length) {
    throw new AppError('NOT_FOUND', 'That device is not blocked.', { status: 404 });
  }

  const snapshot = await snapshotConfigs(client, ['firewall']);
  const uci = new Uci(client);
  for (const entry of entries) await uci.delete('firewall', entry.section);

  await commitWithRollback({ client, session, uci, snapshot, settleMs: 1500 });
  return { ok: true, mac };
}
