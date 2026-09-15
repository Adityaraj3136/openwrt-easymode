import { Router } from 'express';
import { getBandwidth, setTotalLimits } from '../lib/bandwidth.js';
import { asyncHandler, requireSession } from '../middleware/auth.js';

export const bandwidthRouter = Router();

bandwidthRouter.use(requireSession);

bandwidthRouter.get(
  '/bandwidth',
  asyncHandler(async (req, res) => {
    res.json(await getBandwidth(req.ubus, req.session));
  }),
);

bandwidthRouter.post(
  '/bandwidth/limits',
  asyncHandler(async (req, res) => {
    res.json(await setTotalLimits(req.ubus, req.session, req.body));
  }),
);

bandwidthRouter.post(
  '/bandwidth/device/:mac',
  asyncHandler(async (req, res) => {
    const { setDeviceLimits } = await import('../lib/bandwidth.js');
    res.json(await setDeviceLimits(req.ubus, req.session, req.params.mac, req.body));
  }),
);
