import { bandFromFrequency, encryptionLabel, scanEncryption, signalQuality } from './derive.js';
import { AppError } from './errors.js';

// A single scan pass rarely sees every neighbour: radios miss beacons, and a radio
// busy serving clients misses more. LuCI keeps a cache keyed by BSSID and merges
// passes into it, so results accumulate instead of flickering. Same idea here.
const SCAN_TTL_MS = 5 * 60 * 1000;

/** An interface on this radio that iwinfo can scan with. */
async function scanDevice(client, radioId) {
  const { listRadios } = await import('./wireless.js');
  const radios = await listRadios(client, { withClients: false });
  const radio = radios.find((r) => r.id === radioId);
  
  if (!radio) {
    throw new AppError('NO_SUCH_RADIO', 'That Wi-Fi radio does not exist on this router.', { status: 404 });
  }

  // Find the first interface on this radio that has a valid ifname.
  // We prefer an AP interface since they are usually up, but a STA interface works too.
  const ifname = (radio.interfaces ?? []).map((iface) => iface.ifname).find(Boolean);
  
  if (!ifname) {
    throw new AppError(
      'RADIO_OFF',
      'This Wi-Fi radio is switched off, so it cannot look for networks. Turn it on and try again.',
      { status: 409 },
    );
  }

  // Verify iwinfo actually knows this interface before returning it.
  const test = await client.tryCall('iwinfo', 'info', { device: ifname }, null);
  if (!test) {
    throw new AppError(
      'RADIO_OFF',
      'This Wi-Fi radio is switched off, so it cannot look for networks. Turn it on and try again.',
      { status: 409 },
    );
  }
  return ifname;
}

/** Normalizes one iwinfo scan row. Hidden networks are kept but flagged. */
export function normalizeScanEntry(entry) {
  const ssid = typeof entry.ssid === 'string' ? entry.ssid.trim() : '';
  const encryption = scanEncryption(entry.encryption);
  const frequency = entry.frequency ?? (Number(entry.channel) <= 14 ? 2437 : 5180);

  return {
    ssid: ssid || null,
    hidden: !ssid,
    bssid: entry.bssid ?? null,
    signal: entry.signal ?? null,
    quality: signalQuality(entry.signal),
    channel: entry.channel ?? null,
    band: bandFromFrequency(frequency),
    encryption,
    encryptionLabel: encryptionLabel(encryption),
    needsPassword: encryption !== 'none',
  };
}

/**
 * Merges a fresh pass into what we already saw, dropping anything older than the TTL.
 * Pure so the merge rules are checkable without a radio.
 */
export function mergeScanResults(cache = {}, entries = [], now = Date.now()) {
  const merged = {};
  for (const [bssid, cached] of Object.entries(cache)) {
    if (now - cached.seenAt <= SCAN_TTL_MS) merged[bssid] = cached;
  }
  for (const entry of entries) {
    const key = entry.bssid ?? `${entry.ssid ?? 'hidden'}@${entry.channel}`;
    merged[key] = { ...entry, seenAt: now };
  }
  return merged;
}

export const sortScanResults = (merged) =>
  Object.values(merged)
    .map(({ seenAt, ...entry }) => entry)
    .sort((a, b) => (b.signal ?? -999) - (a.signal ?? -999));

/**
 * Nearby networks on one radio. Every access point is listed separately, the way
 * LuCI does it: two routers sharing a name sit on different channels, and collapsing
 * them hides exactly the congestion this list exists to show.
 */
export async function scanNetworks(client, radioId, session = null) {
  const device = await scanDevice(client, radioId);
  const result = await client.tryCall('iwinfo', 'scan', { device }, null);
  if (!result) {
    throw new AppError('SCAN_FAILED', 'The router could not search for Wi-Fi networks.', { status: 502 });
  }

  const entries = (result.results ?? []).map(normalizeScanEntry);

  if (!session) return sortScanResults(mergeScanResults({}, entries));

  session.scratch.scanCache ??= {};
  session.scratch.scanCache[radioId] = mergeScanResults(session.scratch.scanCache[radioId], entries);
  return sortScanResults(session.scratch.scanCache[radioId]);
}

/** One entry per network name, strongest first — for joining, where the name is what matters. */
export const byNetworkName = (networks) => {
  const best = new Map();
  for (const network of networks) {
    if (!network.ssid) continue; // a hidden network cannot be joined by name
    const current = best.get(network.ssid);
    if (!current || (network.signal ?? -999) > (current.signal ?? -999)) best.set(network.ssid, network);
  }
  return [...best.values()].sort((a, b) => (b.signal ?? -999) - (a.signal ?? -999));
};
