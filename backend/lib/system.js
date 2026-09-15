import { commitWithRollback } from './apply.js';
import { MODE_CONFIGS, restoreSnapshot, snapshotConfigs } from './backup.js';
import { AppError } from './errors.js';

export const BACKUP_FORMAT = 'easymode-config-backup-1';

// Restores may only touch the configs EasyMode itself manages. A backup file is user
// input: without this, a crafted file could write any config on the router.
const RESTORABLE = new Set([...MODE_CONFIGS, 'sqm']);

export async function createBackup(client, session) {
  const snapshot = await snapshotConfigs(client, [...RESTORABLE]);
  return {
    format: BACKUP_FORMAT,
    takenAt: snapshot.takenAt,
    router: {
      model: session.router?.model ?? null,
      hostname: session.router?.hostname ?? null,
      host: session.host,
    },
    configs: snapshot.configs,
  };
}

export function validateBackup(payload) {
  if (!payload || typeof payload !== 'object' || payload.format !== BACKUP_FORMAT) {
    throw new AppError('INVALID_BACKUP', 'That file is not an EasyMode backup.', { status: 400 });
  }
  const configs = payload.configs;
  if (!configs || typeof configs !== 'object' || !Object.keys(configs).length) {
    throw new AppError('INVALID_BACKUP', 'That backup file has no settings in it.', { status: 400 });
  }

  const unknown = Object.keys(configs).filter((name) => !RESTORABLE.has(name));
  if (unknown.length) {
    throw new AppError('INVALID_BACKUP', `That backup contains settings EasyMode does not manage: ${unknown.join(', ')}.`, {
      status: 400,
    });
  }
  for (const sections of Object.values(configs)) {
    if (!sections || typeof sections !== 'object') {
      throw new AppError('INVALID_BACKUP', 'That backup file is damaged.', { status: 400 });
    }
  }
  return { takenAt: payload.takenAt ?? null, configs };
}

export async function restoreBackup(client, session, payload) {
  const backup = validateBackup(payload);
  const rollbackPoint = await snapshotConfigs(client, Object.keys(backup.configs));

  const uci = await restoreSnapshot(client, backup);
  await commitWithRollback({
    client,
    session,
    uci,
    snapshot: rollbackPoint,
    settleMs: 4000,
    verify: async (live) => {
      const dump = await live.tryCall('network.interface', 'dump', {}, null);
      const lan = (dump?.interface ?? []).find((iface) => iface.interface === 'lan');
      return lan?.up
        ? { ok: true }
        : { ok: false, reason: 'The restored settings did not bring the network back up.' };
    },
  });

  return { ok: true, restoredFrom: backup.takenAt };
}

export async function rebootRouter(client) {
  const result = await client.tryCall('system', 'reboot', {}, null);
  if (result === null) {
    throw new AppError('REBOOT_NOT_ALLOWED', 'This router does not allow EasyMode to restart it.', {
      status: 403,
      details: 'The rpcd user needs write access to the system reboot method.',
    });
  }
  return { ok: true };
}



export async function setAutoReboot(client, body) {
  const { enabled, day, hour, minute } = body;
  
  // Read current crontab
  let crontab = await client.readFile('/etc/crontabs/root') ?? '';
  
  // Remove existing auto-reboot lines
  crontab = crontab.split('\n').filter(line => !line.includes('easymode-auto-reboot')).join('\n');
  
  if (enabled) {
    // Add new job
    const m = minute ?? 0;
    const h = hour ?? 3;
    const d = day === 'everyday' ? '*' : (day ?? 0);
    // sleep 70 ensures we don't reboot loop if clock is weird, though standard on OpenWrt
    crontab += `\n${m} ${h} * * ${d} sleep 70 && touch /etc/banner && reboot # easymode-auto-reboot\n`;
  }
  
  // Write back and restart cron
  await client.tryCall('file', 'write', { path: '/etc/crontabs/root', data: crontab.trim() + '\n' }, null);
  await client.tryCall('file', 'exec', { command: '/bin/sh', params: ['-c', '/etc/init.d/cron restart'] }, null);
  
  return { ok: true };
}
