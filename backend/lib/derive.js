/**
 * Pure derivations shared by the status modules.
 * No I/O here on purpose: everything in this file is unit-checkable (scripts/check.mjs).
 */

/**
 * UCI booleans arrive as strings, and the string "0" is truthy in JavaScript.
 * Reading them with Boolean() turns "disabled=0" into "disabled", which is how a
 * working radio ends up reported as switched off.
 */
export function uciBool(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(String(value).toLowerCase());
}

export function bandFromFrequency(mhz) {
  if (!Number.isFinite(mhz) || mhz <= 0) return null;
  if (mhz < 3000) return '2.4';
  if (mhz < 5925) return '5';
  if (mhz < 7200) return '6';
  return null;
}

export function bandFromUci({ band, hwmode, channel } = {}) {
  if (band === '2g') return '2.4';
  if (band === '5g') return '5';
  if (band === '6g') return '6';
  if (typeof hwmode === 'string') {
    if (hwmode.includes('a')) return '5';
    if (hwmode.includes('g') || hwmode.includes('b')) return '2.4';
  }
  const ch = Number(channel);
  if (Number.isFinite(ch) && ch > 0) return ch <= 14 ? '2.4' : '5';
  return null;
}

export const bandLabel = (band) => (band ? `${band} GHz Wi-Fi` : 'Wi-Fi');

const HT_FAMILY = { HT: { rank: 1, label: 'Wi-Fi 4' }, VHT: { rank: 2, label: 'Wi-Fi 5' }, HE: { rank: 3, label: 'Wi-Fi 6' }, EHT: { rank: 4, label: 'Wi-Fi 7' } };

/** "HE80" -> { family: 'HE', width: 80 }. */
export function parseHtmode(mode) {
  const match = /^(EHT|VHT|HE|HT)(\d+)$/.exec(String(mode ?? '').toUpperCase());
  if (!match) return null;
  return { family: match[1], width: Number(match[2]) };
}

// 2.4 GHz physically cannot do more than 40 MHz; radios often advertise wider modes
// because the chip supports them on another band.
const MAX_WIDTH_BY_BAND = { '2.4': 40, 5: 160, 6: 320 };

/**
 * One entry per usable channel width, keeping the newest standard for each.
 * Without this the picker lists "20 MHz" and "40 MHz" once per Wi-Fi generation.
 */
export function channelWidthOptions(htmodes = [], band = null) {
  const maxWidth = MAX_WIDTH_BY_BAND[String(band)] ?? 160;
  const best = new Map();

  for (const mode of htmodes) {
    const parsed = parseHtmode(mode);
    if (!parsed || parsed.width > maxWidth) continue;
    const current = best.get(parsed.width);
    if (!current || HT_FAMILY[parsed.family].rank > HT_FAMILY[current.family].rank) {
      best.set(parsed.width, { ...parsed, value: String(mode).toUpperCase() });
    }
  }

  return [...best.values()]
    .sort((a, b) => a.width - b.width)
    .map((entry) => ({
      value: entry.value,
      width: entry.width,
      label: `${entry.width} MHz`,
      standard: HT_FAMILY[entry.family].label,
    }));
}

/** Parses the aggregate `cpu` line of /proc/stat into jiffy totals. */
export function parseProcStat(text) {
  if (typeof text !== 'string') return null;
  const line = text.split('\n').find((row) => row.startsWith('cpu '));
  if (!line) return null;
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  if (fields.length < 4 || fields.some((value) => !Number.isFinite(value))) return null;
  const idle = fields[3] + (fields[4] ?? 0);
  const total = fields.reduce((sum, value) => sum + value, 0);
  return { idle, total };
}

/** CPU busy percentage between two /proc/stat samples. Null until a second sample exists. */
export function cpuUsageFromSamples(previous, current) {
  if (!previous || !current) return null;
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0) return null;
  const busy = ((totalDelta - idleDelta) / totalDelta) * 100;
  return Math.min(100, Math.max(0, Math.round(busy * 10) / 10));
}

/** Parses /tmp/dhcp.leases (dnsmasq format: expiry mac ip hostname clientid). */
export function parseDhcpLeases(text, now = Date.now()) {
  if (typeof text !== 'string') return [];
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [expiry, mac, ip, hostname] = line.split(/\s+/);
      const expiresAt = Number(expiry) * 1000;
      return {
        mac: mac ?? null,
        ip: ip ?? null,
        hostname: hostname && hostname !== '*' ? hostname : null,
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
        active: !Number.isFinite(expiresAt) || expiry === '0' || expiresAt > now,
      };
    })
    .filter((lease) => lease.ip);
}

export const MODES = {
  router: {
    id: 'router',
    label: 'Router Mode',
    sourceLabel: 'WAN Ethernet',
  },
  ap: {
    id: 'ap',
    label: 'Access Point Mode',
    sourceLabel: 'Main router via Ethernet',
  },
  repeater: {
    id: 'repeater',
    label: 'Wireless Repeater Mode',
    sourceLabel: 'Upstream Wi-Fi',
  },
  hotspot: {
    id: 'hotspot',
    label: 'Phone Hotspot Mode',
    sourceLabel: 'Phone hotspot',
  },
  unknown: {
    id: 'unknown',
    label: 'Custom / Unknown setup',
    sourceLabel: 'Unknown',
  },
};

/**
 * Works out the operating mode from live router facts.
 *
 * `storedMode` is what EasyMode itself last applied (uci easymode.state.mode). It wins
 * because repeater and phone-hotspot are identical on the wire - only intent differs.
 */
export function detectMode({ storedMode, staUplink, wanUp, wanDevice, lanDhcpDisabled, lanHasGateway } = {}) {
  const known = storedMode && MODES[storedMode] ? storedMode : null;

  let detected = 'unknown';
  if (staUplink?.connected || staUplink?.configured) {
    detected = 'repeater';
  } else if (wanUp && wanDevice) {
    detected = 'router';
  } else if (lanDhcpDisabled && lanHasGateway) {
    detected = 'ap';
  } else if (lanDhcpDisabled) {
    detected = 'ap';
  }

  // Stored intent only refines the wireless-uplink pair; it never overrules the wire.
  let id = detected;
  if (known) {
    const wirelessPair = ['repeater', 'hotspot'];
    if (wirelessPair.includes(known) && detected === 'repeater') id = known;
    else if (known === detected) id = known;
  }

  return {
    id,
    label: MODES[id].label,
    source: known ? 'stored' : 'detected',
    detected,
    storedMode: known,
    matchesStored: known ? known === id : null,
  };
}

export function internetSourceLabel(mode, { staSsid, wanProto, wanDevice } = {}) {
  switch (mode) {
    case 'router':
      return wanProto ? `WAN Ethernet (${wanProto.toUpperCase()}${wanDevice ? ` on ${wanDevice}` : ''})` : 'WAN Ethernet';
    case 'ap':
      return 'Main router via Ethernet';
    case 'repeater':
      return staSsid ? `Wi-Fi network "${staSsid}"` : 'Upstream Wi-Fi';
    case 'hotspot':
      return staSsid ? `Phone hotspot "${staSsid}"` : 'Phone hotspot';
    default:
      return 'Unknown';
  }
}

export function formatUptime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h ${minutes}m`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Maps an iwinfo scan encryption block to the UCI `encryption` value a client
 * interface needs. Getting this wrong is the usual cause of a repeater that
 * associates and then silently drops.
 */
export function scanEncryption(encryption) {
  if (!encryption?.enabled) return 'none';
  const wpa = Array.isArray(encryption.wpa) ? encryption.wpa : [];
  const auth = Array.isArray(encryption.authentication) ? encryption.authentication : [];
  if (auth.includes('sae') || wpa.includes(3)) return 'sae-mixed';
  if (wpa.includes(2)) return 'psk2';
  if (wpa.includes(1)) return 'psk';
  if (auth.includes('psk')) return 'psk2';
  return 'psk2';
}

export const encryptionLabel = (value) => {
  if (value === 'none') return 'Open — no password';
  if (value === 'sae-mixed' || value === 'sae') return 'WPA3';
  if (value === 'psk') return 'WPA (older)';
  return 'WPA2';
};

/**
 * How busy each channel is, from a scan. Neighbours on the same channel hurt more
 * than neighbours nearby, but this stays deliberately simple: a count and a label.
 */
export function channelCongestion(networks = []) {
  const counts = new Map();
  for (const network of networks) {
    const channel = Number(network.channel);
    if (!Number.isFinite(channel) || channel <= 0) continue;
    counts.set(channel, (counts.get(channel) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([channel, count]) => ({
      channel,
      count,
      level: count >= 5 ? 'crowded' : count >= 3 ? 'busy' : 'quiet',
    }))
    .sort((a, b) => a.channel - b.channel);
}

/** Signal (dBm) -> rough quality bucket for the UI. */
export function signalQuality(dbm) {
  if (!Number.isFinite(dbm) || dbm === 0) return null;
  if (dbm >= -55) return { level: 'excellent', bars: 4 };
  if (dbm >= -67) return { level: 'good', bars: 3 };
  if (dbm >= -75) return { level: 'fair', bars: 2 };
  return { level: 'weak', bars: 1 };
}
