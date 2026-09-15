import { cpuUsageFromSamples, formatUptime, parseProcStat } from '../derive.js';

/** Router identity + health. CPU% needs /proc/stat access; it degrades to load average. */
export async function getSystemStatus(client, session) {
  const [board, info] = await Promise.all([
    client.call('system', 'board'),
    client.call('system', 'info'),
  ]);

  const memory = info.memory ?? {};
  const total = memory.total ?? null;
  const available = memory.available ?? memory.free ?? null;
  const used = total != null && available != null ? total - available : null;

  let cpu = { percent: null, available: false, reason: 'Requires rpcd-mod-file read access to /proc/stat' };
  if (session.capabilities?.features?.cpuUsage) {
    const sample = parseProcStat(await client.readFile('/proc/stat'));
    const percent = cpuUsageFromSamples(session.scratch.cpuSample, sample);
    if (sample) session.scratch.cpuSample = sample;
    cpu = {
      percent,
      available: true,
      reason: percent == null ? 'Collecting first sample' : null,
    };
  }

  const load = Array.isArray(info.load)
    ? info.load.map((value) => Math.round((value / 65536) * 100) / 100)
    : null;

  const crontab = await client.readFile('/etc/crontabs/root') ?? '';
  const rebootLine = crontab.split('\n').find(l => l.includes('easymode-auto-reboot'));
  let autoReboot = null;
  if (rebootLine) {
    const parts = rebootLine.split(' ');
    autoReboot = {
      enabled: true,
      minute: Number(parts[0]),
      hour: Number(parts[1]),
      day: parts[4] === '*' ? 'everyday' : Number(parts[4]),
    };
  }

  return {
    model: board.model ?? null,
    hostname: board.hostname ?? null,
    boardName: board.board_name ?? null,
    processor: board.system ?? null,
    firmware: board.release?.description ?? board.release?.version ?? null,
    version: board.release?.version ?? null,
    kernel: board.kernel ?? null,
    uptimeSeconds: info.uptime ?? null,
    uptime: formatUptime(info.uptime),
    localtime: info.localtime ?? null,
    autoReboot,
    memory: {
      total,
      used,
      available,
      percent: total && used != null ? Math.round((used / total) * 1000) / 10 : null,
      cached: memory.cached ?? null,
      buffered: memory.buffered ?? null,
    },
    cpu,
    load,
  };
}
