import { Router } from 'express';
import { AppError } from '../lib/errors.js';
import { apModePlan, apPreflightInfo, parseApOptions } from '../lib/modes/ap.js';
import { getJob, startModeJob } from '../lib/modes/engine.js';
import { parseRouterOptions, routerModePlan, routerPreflight } from '../lib/modes/router.js';
import { hotspotModePlan, parseWirelessUplinkOptions, repeaterModePlan } from '../lib/modes/wireless-uplink.js';
import { getModeStatus } from '../lib/status/mode.js';
import { getNetworkStatus } from '../lib/status/network.js';
import { findSections } from '../lib/uci.js';
import { listRadios } from '../lib/wireless.js';
import { asyncHandler, requireSession } from '../middleware/auth.js';

export const modeRouter = Router();

modeRouter.use(requireSession);

const hasRunningJob = (session) =>
  Object.values(session.scratch.jobs ?? {}).some((job) => job.status === 'running');

/** Everything the Mode Setup page needs to draw its cards and prefill the forms. */
modeRouter.get(
  '/mode',
  asyncHandler(async (req, res) => {
    const network = await getNetworkStatus(req.ubus, req.session);
    const radios = req.session.capabilities?.features?.wirelessControl ? await listRadios(req.ubus, { withClients: false }) : [];
    const mode = await getModeStatus(req.ubus, { network, radios });
    const wireless = (await req.ubus.uciGet('wireless')) ?? {};
    const firstAp = findSections(wireless, 'wifi-iface', (section) => (section.mode ?? 'ap') === 'ap')[0];

    res.json({
      current: mode,
      busy: hasRunningJob(req.session),
      defaults: {
        lanIp: network.lan.ip,
        lanNetmask: network.lan.netmask,
        wifiSsid: firstAp?.section.ssid ?? null,
        wifiKey: firstAp?.section.key ?? null,
        wifiEncryption: firstAp?.section.encryption ?? 'psk2',
        hasWifi: radios.length > 0,
      },
      preflight: {
        router: await routerPreflight(req.ubus),
        ap: await apPreflightInfo(req.ubus),
      },
      available: {
        router: true,
        ap: true,
        repeater: radios.length > 0,
        hotspot: radios.length > 0,
      },
      wireless: {
        radios: radios.map((radio) => ({ id: radio.id, label: radio.label, band: radio.band, enabled: radio.enabled })),
        // One radio means the uplink and the local Wi-Fi share a channel.
        singleRadio: radios.length === 1,
      },
    });
  }),
);

modeRouter.post(
  '/mode/router',
  asyncHandler(async (req, res) => {
    if (hasRunningJob(req.session)) {
      throw new AppError('JOB_RUNNING', 'A setup is already running. Wait for it to finish.', { status: 409 });
    }
    const options = parseRouterOptions(req.body);
    const job = startModeJob({
      client: req.ubus,
      session: req.session,
      mode: 'router',
      plan: routerModePlan,
      options,
    });
    res.status(202).json({ jobId: job.id, status: job.status, steps: job.steps });
  }),
);

modeRouter.post(
  '/mode/ap',
  asyncHandler(async (req, res) => {
    if (hasRunningJob(req.session)) {
      throw new AppError('JOB_RUNNING', 'A setup is already running. Wait for it to finish.', { status: 409 });
    }
    const options = parseApOptions(req.body);
    const job = startModeJob({
      client: req.ubus,
      session: req.session,
      mode: 'ap',
      plan: apModePlan,
      options,
    });
    res.status(202).json({ jobId: job.id, status: job.status, steps: job.steps });
  }),
);

for (const [mode, plan] of [
  ['repeater', repeaterModePlan],
  ['hotspot', hotspotModePlan],
]) {
  modeRouter.post(
    `/mode/${mode}`,
    asyncHandler(async (req, res) => {
      if (hasRunningJob(req.session)) {
        throw new AppError('JOB_RUNNING', 'A setup is already running. Wait for it to finish.', { status: 409 });
      }
      const options = parseWirelessUplinkOptions(req.body);
      const job = startModeJob({ client: req.ubus, session: req.session, mode, plan, options });
      res.status(202).json({ jobId: job.id, status: job.status, steps: job.steps });
    }),
  );
}

modeRouter.get(
  '/mode/job/:id',
  asyncHandler(async (req, res) => {
    const job = getJob(req.session, req.params.id);
    if (!job) throw new AppError('JOB_NOT_FOUND', 'That setup run is no longer available.', { status: 404 });
    res.json(job);
  }),
);
