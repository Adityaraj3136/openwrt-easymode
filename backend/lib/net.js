/** IPv4 helpers used by conflict detection and subnet planning. Pure, unit-checkable. */

export function isIpv4(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export const ipToInt = (ip) =>
  ip.split('.').reduce((total, part) => (total << 8 >>> 0) + Number(part), 0) >>> 0;

export const intToIp = (value) =>
  [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.');

export function maskToBits(mask) {
  if (/^\d+$/.test(String(mask))) {
    const bits = Number(mask);
    return bits >= 0 && bits <= 32 ? bits : null;
  }
  if (!isIpv4(mask)) return null;
  const value = ipToInt(mask);
  const bits = 32 - Math.log2((~value >>> 0) + 1);
  return Number.isInteger(bits) ? bits : null;
}

export function bitsToMask(bits) {
  const value = bits >= 0 && bits <= 32 ? (bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0) : 0;
  return intToIp(value);
}

export function networkAddress(ip, mask) {
  const bits = maskToBits(mask);
  if (!isIpv4(ip) || bits == null) return null;
  const maskInt = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (ipToInt(ip) & maskInt) >>> 0, bits };
}

/** True when two address/mask pairs describe overlapping networks. */
export function subnetsOverlap(a, b) {
  const netA = networkAddress(a.ip, a.mask);
  const netB = networkAddress(b.ip, b.mask);
  if (!netA || !netB) return false;
  const bits = Math.min(netA.bits, netB.bits);
  const maskInt = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((netA.base & maskInt) >>> 0) === ((netB.base & maskInt) >>> 0);
}

// Ordered candidates for "move the LAN somewhere else"; the first free one wins.
export const FALLBACK_LANS = [
  '192.168.8.1',
  '192.168.9.1',
  '192.168.22.1',
  '192.168.88.1',
  '10.10.10.1',
  '172.16.30.1',
];

/**
 * Picks a LAN address that does not collide with any upstream network.
 * `conflicts` is a list of {ip, mask} the router already sees (WAN lease, upstream LAN).
 */
export function pickSafeLan(conflicts = [], preferred = null, mask = '255.255.255.0') {
  const clashes = (candidate) =>
    conflicts.some((conflict) => subnetsOverlap({ ip: candidate, mask }, conflict));

  if (preferred && isIpv4(preferred) && !clashes(preferred)) return preferred;
  for (const candidate of FALLBACK_LANS) {
    if (!clashes(candidate)) return candidate;
  }
  return null;
}

/**
 * Picks a management address for Access Point mode: inside the main router's network,
 * clear of the gateway and of the range a DHCP server normally hands out. High
 * addresses are tried first because pools almost always start low.
 */
export function pickManagementAddress({ ip, mask, gateway }, taken = []) {
  const net = networkAddress(ip, mask);
  if (!net) return null;
  const size = 2 ** (32 - net.bits);
  if (size < 8) return null;

  const offsets = [size - 6, size - 5, size - 4, size - 3, size - 17, size - 33, 2, 3];
  const blocked = new Set([...taken, gateway, ip].filter(Boolean).map((address) => ipToInt(address)));

  for (const offset of offsets) {
    if (offset <= 0 || offset >= size - 1) continue;
    const candidate = (net.base + offset) >>> 0;
    if (blocked.has(candidate)) continue;
    return intToIp(candidate);
  }
  return null;
}

/** First usable host offset inside the LAN, e.g. 192.168.8.1 -> 192.168.8.100 for DHCP start. */
export function hostInSubnet(ip, mask, offset) {
  const net = networkAddress(ip, mask);
  if (!net) return null;
  return intToIp((net.base + offset) >>> 0);
}
