import { commitWithRollback } from './apply.js';
import { snapshotConfigs } from './backup.js';
import { AppError } from './errors.js';
import { Uci, findSection } from './uci.js';
import { requireRange } from './validate.js';

/**
 * Parses `nlbw -c json` output. Columns are read by name because their order and
 * number change between nlbwmon versions.
 */
export function parseNlbwJson(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return [];
  }
  const columns = payload?.columns;
  const rows = payload?.data;
  if (!Array.isArray(columns) || !Array.isArray(rows)) return [];

  const index = (name) => columns.indexOf(name);
  const macAt = index('mac');
  const ipAt = index('ip');
  const rxAt = index('rx_bytes');
  const txAt = index('tx_bytes');
  if (rxAt < 0 || txAt < 0) return [];

  return rows
    .map((row) => ({
      mac: macAt >= 0 ? row[macAt] ?? null : null,
      ip: ipAt >= 0 ? row[ipAt] ?? null : null,
      rxBytes: Number(row[rxAt]) || 0,
      txBytes: Number(row[txAt]) || 0,
    }))
    .filter((entry) => entry.mac || entry.ip)
    .sort((a, b) => b.rxBytes + b.txBytes - (a.rxBytes + a.txBytes));
}

/** Bytes-per-second between two counter samples. */
export function rateBetween(previous, current) {
  if (!previous || !current) return null;
  const seconds = (current.at - previous.at) / 1000;
  if (seconds <= 0.5) return null;
  const rx = (current.rx - previous.rx) / seconds;
  const tx = (current.tx - previous.tx) / seconds;
  if (rx < 0 || tx < 0) return null; // counters were reset
  return { rx: Math.round(rx), tx: Math.round(tx) };
}

/** The interface carrying internet traffic: a WAN port, or a wireless uplink. */
async function uplinkDevice(client) {
  const dump = await client.call('network.interface', 'dump');
  const interfaces = dump.interface ?? [];
  const routed = interfaces.find(
    (iface) =>
      iface.up &&
      iface.interface !== 'loopback' &&
      (iface.route ?? []).some((route) => route.target === '0.0.0.0' && Number(route.mask) === 0),
  );
  const named = interfaces.find((iface) => iface.interface === 'wan' && iface.up);
  const chosen = routed ?? named ?? null;
  return chosen ? { name: chosen.interface, device: chosen.l3_device ?? chosen.device ?? null } : null;
}

export async function getBandwidth(client, session) {
  const uplink = await uplinkDevice(client);
  const devices = (await client.tryCall('network.device', 'status', {}, null)) ?? {};
  const stats = uplink?.device ? devices[uplink.device]?.statistics ?? null : null;

  let total = { available: false, reason: 'No internet connection is up yet.', rxRate: null, txRate: null };
  if (stats) {
    const sample = { at: Date.now(), rx: stats.rx_bytes ?? 0, tx: stats.tx_bytes ?? 0 };
    const rates = rateBetween(session.scratch.bandwidthSample, sample);
    session.scratch.bandwidthSample = sample;
    total = {
      available: true,
      reason: rates ? null : 'Collecting the first sample — this fills in a few seconds.',
      // Download is what arrives on the uplink, which is its receive counter.
      rxRate: rates?.rx ?? null,
      txRate: rates?.tx ?? null,
      rxBytes: sample.rx,
      txBytes: sample.tx,
      interface: uplink.name,
      device: uplink.device,
    };
  }

  const sqmConfig = await client.uciGet('sqm');
  const [sqmInit, sqmRun, sqmBin] = await Promise.all([
    client.tryCall('file', 'stat', { path: '/etc/init.d/sqm' }, null),
    client.tryCall('file', 'stat', { path: '/usr/lib/sqm/run.sh' }, null),
    client.tryCall('file', 'stat', { path: '/usr/bin/sqm' }, null),
  ]);
  const hasSqm = sqmConfig !== null || sqmInit !== null || sqmRun !== null || sqmBin !== null;
  
  const queue = sqmConfig && uplink?.device
    ? findSection(sqmConfig, 'queue', (section) => section.interface === uplink.device)
    : null;

  const nlbwConfig = await client.uciGet('nlbwmon');
  const nlbwBin = await client.tryCall('file', 'stat', { path: '/usr/sbin/nlbwmon' }, null);
  const hasNlbw = nlbwConfig !== null || nlbwBin !== null;
  
  let perDevice = {
    available: false,
    reason: hasNlbw
      ? 'The traffic accounting service is installed but did not return data. It may be stopped or collecting its first samples.'
      : 'Per-device usage needs the nlbwmon package, which is not installed on this router.',
    devices: [],
  };
  if (hasNlbw) {
    const result = await client.tryCall(
      'file',
      'exec',
      { command: '/usr/sbin/nlbw', params: ['-c', 'json', '-g', 'mac,ip'] },
      null,
    );
    const rows = parseNlbwJson(result?.stdout ?? '');
    if (rows.length) perDevice = { available: true, reason: null, devices: rows };
    else if (!result) {
      // Often just means the service is disabled, but could be ACLs.
      perDevice.reason = 'Traffic accounting is installed but not currently returning data. Make sure nlbwmon is enabled and running.';
    }
  }

  return {
    total,
    limits: {
      available: hasSqm,
      reason: hasSqm ? null : 'Speed limits need the sqm-scripts package, which is not installed on this router.',
      enabled: queue ? queue.section.enabled === '1' : false,
      downloadMbps: queue?.section.download ? Number(queue.section.download) / 1000 : null,
      uploadMbps: queue?.section.upload ? Number(queue.section.upload) / 1000 : null,
      device: uplink?.device ?? null,
    },
    perDevice,
    // Being explicit beats a control that quietly does nothing.
    perDeviceLimits: {
      available: false,
      reason:
        'EasyMode can only limit the whole connection on this router. Per-device limits need a shaping service it can configure safely, and none was found.',
    },
  };
}

export async function setTotalLimits(client, session, body = {}) {
  const current = await getBandwidth(client, session);
  if (!current.limits.available) {
    throw new AppError('SQM_MISSING', current.limits.reason, {
      status: 409,
      details: 'Install sqm-scripts on the router, then reload this page.',
    });
  }
  const device = current.limits.device;
  if (!device) {
    throw new AppError('NO_UPLINK', 'There is no internet connection to limit yet.', { status: 409 });
  }

  const enabled = body.enabled === undefined ? true : Boolean(body.enabled);
  const download = requireRange(body.downloadMbps, { min: 1, max: 10000, fallback: null }, 'downloadMbps');
  const upload = requireRange(body.uploadMbps, { min: 1, max: 10000, fallback: null }, 'uploadMbps');
  if (enabled && (!download || !upload)) {
    throw new AppError('INVALID_SETTINGS', 'Enter both a download and an upload speed.', { status: 400 });
  }

  const snapshot = await snapshotConfigs(client, ['sqm']);
  const uci = new Uci(client);
  const sqmConfig = (await client.uciGet('sqm')) ?? {};
  const queue = findSection(sqmConfig, 'queue', (section) => section.interface === device);

  const values = {
    interface: device,
    enabled: enabled ? '1' : '0',
    // cake with piece_of_cake is the sane default; anything finer belongs in LuCI.
    qdisc: 'cake',
    script: 'piece_of_cake.qos',
    linklayer: 'ethernet',
    ...(enabled ? { download: String(Math.round(download * 1000)), upload: String(Math.round(upload * 1000)) } : {}),
  };

  if (queue) await uci.set('sqm', queue.name, values);
  else await uci.add('sqm', 'queue', values);

  await commitWithRollback({ client, session, uci, snapshot, settleMs: 2000 });
  return getBandwidth(client, session);
}

export async function setDeviceLimits(client, session, mac, body = {}) {
  const current = await getBandwidth(client, session);
  if (!current.perDeviceLimits.available) {
    throw new AppError('NFT_QOS_MISSING', current.perDeviceLimits.reason, {
      status: 409,
      details: 'Install nft-qos on the router, then reload this page.',
    });
  }

  const download = requireRange(body.downloadMbps, { min: 1, max: 10000, fallback: null }, 'downloadMbps');
  const upload = requireRange(body.uploadMbps, { min: 1, max: 10000, fallback: null }, 'uploadMbps');

  const snapshot = await snapshotConfigs(client, ['nft-qos']);
  const uci = new Uci(client);
  const config = (await client.uciGet('nft-qos')) ?? {};
  
  // Ensure default setup is enabled
  const statics = findSection(config, 'default', (s) => s['.type'] === 'nft-qos-static');
  if (statics) await uci.set('nft-qos', statics.name, { enable: '1' });
  else await uci.add('nft-qos', 'nft-qos-static', { enable: '1' }, 'default');

  const existing = Object.values(config).find(
    (s) => s['.type'] === 'client' && String(s.mac).toLowerCase() === String(mac).toLowerCase()
  );

  if (!download && !upload) {
    // Remove limits for this device
    if (existing) await uci.delete('nft-qos', existing['.name']);
  } else {
    // Set limits
    const values = {
      mac: String(mac).toLowerCase(),
      rate_down: download ? String(download) : '0',
      rate_up: upload ? String(upload) : '0',
      unit: 'Mbps',
    };
    if (existing) await uci.set('nft-qos', existing['.name'], values);
    else await uci.add('nft-qos', 'client', values);
  }

  await commitWithRollback({ client, session, uci, snapshot, settleMs: 2000 });
  return getBandwidth(client, session);
}
