import { Router } from 'express';
import { getSystemStatus } from '../lib/status/system.js';
import { createBackup, rebootRouter, restoreBackup } from '../lib/system.js';
import { asyncHandler, requireSession } from '../middleware/auth.js';

export const systemRouter = Router();

systemRouter.use(requireSession);

systemRouter.get(
  '/system/overview',
  asyncHandler(async (req, res) => {
    const system = await getSystemStatus(req.ubus, req.session);
    res.json({
      system,
      router: {
        host: req.session.host,
        username: req.session.username,
        luciUrl: `${req.session.scheme}://${req.session.host}/cgi-bin/luci`,
      },
      capabilities: req.session.capabilities?.features ?? {},
    });
  }),
);

systemRouter.get(
  '/system/backup',
  asyncHandler(async (req, res) => {
    const backup = await createBackup(req.ubus, req.session);
    const stamp = backup.takenAt.slice(0, 19).replace(/[:T]/g, '-');
    res.setHeader('Content-Disposition', `attachment; filename="easymode-backup-${stamp}.json"`);
    res.json(backup);
  }),
);

systemRouter.post(
  '/system/restore',
  asyncHandler(async (req, res) => {
    res.json(await restoreBackup(req.ubus, req.session, req.body));
  }),
);

systemRouter.post(
  '/system/reboot',
  asyncHandler(async (req, res) => {
    res.json(await rebootRouter(req.ubus));
  }),
);

systemRouter.post(
  '/system/autoreboot',
  asyncHandler(async (req, res) => {
    const { setAutoReboot } = await import('../lib/system.js');
    res.json(await setAutoReboot(req.ubus, req.body));
  }),
);
