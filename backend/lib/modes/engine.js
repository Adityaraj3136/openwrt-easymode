import { randomUUID } from 'node:crypto';
import { restoreSnapshot, snapshotConfigs } from '../backup.js';
import { Uci } from '../uci.js';
import { UbusClient } from '../ubus.js';

const ROLLBACK_TIMEOUT_S = 90;
const STEP_SEQUENCE = [
  ['backup', 'Saving current configuration'],
  ['prepare', 'Preparing interfaces'],
  ['network', 'Configuring network'],
  ['wifi', 'Configuring Wi-Fi'],
  ['apply', 'Applying changes'],
  ['test', 'Testing connection'],
  ['finish', 'Saving configuration'],
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function getJob(session, jobId) {
  return session.scratch.jobs?.[jobId] ?? null;
}

function newJob(session, mode) {
  session.scratch.jobs ??= {};
  const job = {
    id: randomUUID(),
    mode,
    status: 'running',
    startedAt: new Date().toISOString(),
    steps: STEP_SEQUENCE.map(([id, label]) => ({ id, label, status: 'pending', detail: null })),
    error: null,
    result: null,
  };
  // Keep only the most recent jobs around.
  const ids = Object.keys(session.scratch.jobs);
  if (ids.length > 4) delete session.scratch.jobs[ids[0]];
  session.scratch.jobs[job.id] = job;
  return job;
}

const stepOf = (job, id) => job.steps.find((step) => step.id === id);

function mark(job, id, status, detail) {
  const step = stepOf(job, id);
  if (!step) return;
  step.status = status;
  if (detail !== undefined) step.detail = detail;
}

/**
 * Stores which mode EasyMode applied, so repeater and phone-hotspot (identical on the
 * wire) stay distinguishable. Creates /etc/config/easymode on first use.
 */
async function recordMode(client, mode) {
  if ((await client.uciGet('easymode')) === null) {
    const written = await client.tryCall('file', 'write', {
      path: '/etc/config/easymode',
      data: "config state 'state'\n",
    });
    if (written === null) return false;
  }
  const set = await client.tryCall('uci', 'set', {
    config: 'easymode',
    section: 'state',
    // The type is required when the section is not there yet, e.g. the first time a
    // mode is applied on a router that has never had an easymode config.
    type: 'state',
    values: { mode, updated: String(Math.floor(Date.now() / 1000)) },
  });
  if (set === null) return false;
  await client.tryCall('uci', 'commit', { config: 'easymode' });
  return true;
}

/** Waits until the router answers again, following a LAN address change if there was one. */
export async function reconnect(session, candidates, { attempts = 12, delayMs = 2500 } = {}) {
  // The simulated router is always there, at whatever address the plan moved it to.
  if (session.demoClient) return { client: session.demoClient, host: candidates[0] ?? session.host };

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    for (const host of candidates) {
      const client = new UbusClient({ host, scheme: session.scheme, sid: session.ubusSid, timeoutMs: 4000 });
      try {
        await client.call('system', 'info');
        return { client, host };
      } catch {
        /* keep trying */
      }
    }
    await sleep(delayMs);
  }
  return null;
}

/**
 * Runs a mode change as a background job.
 *
 * Order matters: snapshot, stage, apply-with-rollback-timer, verify, then confirm.
 * If verification fails we roll back explicitly; if the router stops answering, the
 * router's own timer restores the previous configuration without us.
 */
export function startModeJob({ client, session, mode, plan, options }) {
  const job = newJob(session, mode);

  const run = async () => {
    let snapshot = null;
    let applied = false;

    const ctx = {
      client,
      session,
      options,
      uci: new Uci(client),
      facts: {},
      log: (stepId, detail) => mark(job, stepId, 'running', detail),
      // Some plans commit an interim step (a DHCP probe, joining a Wi-Fi network)
      // before the main apply. Recovery has to know those are already live.
      noteInterimApply: () => {
        applied = true;
      },
    };

    try {
      mark(job, 'backup', 'running');
      snapshot = await snapshotConfigs(client);
      session.scratch.lastSnapshot = snapshot;
      const rollbackSupported = await Uci.supportsRollback(client);
      mark(job, 'backup', 'done', rollbackSupported ? 'Restore point created' : 'Restore point created (no automatic timer on this firmware)');

      mark(job, 'prepare', 'running');
      await plan.preflight(ctx);
      mark(job, 'prepare', 'done', ctx.facts.preflightDetail ?? null);

      mark(job, 'network', 'running');
      await plan.stageNetwork(ctx);
      mark(job, 'network', 'done', ctx.facts.networkDetail ?? null);

      mark(job, 'wifi', 'running');
      const wifiDetail = await plan.stageWifi(ctx);
      mark(job, 'wifi', 'done', wifiDetail ?? 'Left unchanged');

      mark(job, 'apply', 'running');
      if (rollbackSupported) await ctx.uci.apply(ROLLBACK_TIMEOUT_S);
      else await ctx.uci.commitAll();
      applied = true;

      const candidates = [...new Set([ctx.facts.newLanIp, session.host].filter(Boolean))];
      await sleep(4000);
      const connection = await reconnect(session, candidates);
      if (!connection) {
        // The rollback timer will restore the old configuration by itself.
        throw new Error('The router stopped responding after the change.');
      }
      if (connection.host !== session.host) {
        session.host = connection.host;
        ctx.client = connection.client;
        ctx.uci = new Uci(connection.client);
      }
      mark(job, 'apply', 'done', `Router reachable at ${connection.host}`);

      mark(job, 'test', 'running');
      const verdict = await plan.verify({ ...ctx, client: connection.client });
      if (!verdict.ok) throw new Error(verdict.reason ?? 'The new settings did not give a working connection.');
      mark(job, 'test', 'done', verdict.detail ?? null);

      mark(job, 'finish', 'running');
      if (rollbackSupported) await new Uci(connection.client).confirm();
      const recorded = await recordMode(connection.client, mode);
      mark(job, 'finish', 'done', recorded ? null : 'Mode applied, but EasyMode could not record which mode it is');

      job.status = 'success';
      job.result = { mode, routerHost: session.host, ...verdict.summary };
    } catch (error) {
      job.status = 'failed';
      job.error = error.message;
      const running = job.steps.find((step) => step.status === 'running');
      if (running) mark(job, running.id, 'failed', error.message);
      job.steps.filter((step) => step.status === 'pending').forEach((step) => {
        step.status = 'skipped';
      });

      await recover({ session, applied, snapshot, job, uci: ctx.uci });
    }
  };

  run().catch((error) => {
    job.status = 'failed';
    job.error = error.message;
  });

  return job;
}

/** Puts the router back the way it was, by whichever route is still available. */
async function recover({ session, applied, snapshot, job, uci }) {
  const connection = await reconnect(session, [session.host], { attempts: 4, delayMs: 3000 });
  if (!connection) {
    job.recovery = 'The router is not answering. Its automatic rollback timer restores the previous settings within 90 seconds.';
    return;
  }

  try {
    if (!applied) {
      // Revert the staged-but-uncommitted changes. This has to be the job's own Uci
      // instance: a fresh one knows nothing about which configs were touched.
      await uci.revert();
      job.recovery = 'No changes were applied. The router is untouched.';
      return;
    }
    await new Uci(connection.client).rollback();
    if (snapshot) {
      const restore = await restoreSnapshot(connection.client, snapshot);
      await restore.commitAll();
    }
    job.recovery = 'Previous configuration restored.';
  } catch (error) {
    job.recovery = `Automatic restore failed: ${error.message}. The router's own rollback timer may still restore it.`;
  }
}
