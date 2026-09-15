import { Router } from 'express';
import { getDashboard } from '../lib/status/dashboard.js';
import { getNetworkStatus } from '../lib/status/network.js';
import { getSystemStatus } from '../lib/status/system.js';
import { asyncHandler, requireSession } from '../middleware/auth.js';

export const statusRouter = Router();

statusRouter.use(requireSession);

statusRouter.get(
  '/status',
  asyncHandler(async (req, res) => {
    res.json(await getDashboard(req.ubus, req.session));
  }),
);

statusRouter.get(
  '/system',
  asyncHandler(async (req, res) => {
    res.json(await getSystemStatus(req.ubus, req.session));
  }),
);

statusRouter.get(
  '/network',
  asyncHandler(async (req, res) => {
    const network = await getNetworkStatus(req.ubus, req.session);
    delete network._raw;
    res.json(network);
  }),
);

/** Diagnostic endpoint: exposes session capabilities and raw ubus object list for debugging. */
statusRouter.get(
  '/debug/capabilities',
  asyncHandler(async (req, res) => {
    const objects = await req.ubus.listObjects();
    res.json({
      capabilities: req.session.capabilities,
      ubusObjects: Object.keys(objects).sort(),
    });
  }),
);
