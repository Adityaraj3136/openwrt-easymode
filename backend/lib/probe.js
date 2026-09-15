const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const defaultRoute = (iface) =>
  (iface.route ?? []).find((route) => route.target === '0.0.0.0' && Number(route.mask) === 0) ?? null;

/** Reads one logical interface out of a fresh dump. */
export async function readInterface(client, name) {
  const dump = await client.call('network.interface', 'dump');
  return (dump.interface ?? []).find((iface) => iface.interface === name) ?? null;
}

export function leaseFacts(iface) {
  const address = iface?.['ipv4-address']?.[0];
  if (!iface?.up || !address) return null;
  return {
    ip: address.address,
    mask: String(address.mask),
    gateway: defaultRoute(iface)?.nexthop ?? null,
    dns: iface['dns-server'] ?? [],
    device: iface.l3_device ?? iface.device ?? null,
  };
}

/** Waits for a DHCP lease on an interface. Returns null if nothing arrives in time. */
export async function waitForLease(client, name, { attempts = 9, delayMs = 3000 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const facts = leaseFacts(await readInterface(client, name));
    if (facts?.gateway) return facts;
    await sleep(delayMs);
  }
  return null;
}

/**
 * Is this address unused? Needs ping rights; `null` means "could not check",
 * which callers must not read as "free".
 */
export async function isAddressFree(client, ip) {
  const result = await client.tryCall(
    'file',
    'exec',
    { command: '/bin/ping', params: ['-c', '1', '-W', '1', ip] },
    null,
  );
  if (!result || typeof result.code !== 'number') return null;
  return result.code !== 0;
}

/** Can the router reach this host? Used to confirm the main router answers. */
export async function canReach(client, ip) {
  const free = await isAddressFree(client, ip);
  return free === null ? null : !free;
}
