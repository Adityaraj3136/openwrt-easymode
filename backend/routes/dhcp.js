import { Router } from 'express';
import { blockClient, unblockClient } from '../lib/clients.js';
import { getLanSettings, updateLan } from '../lib/lan.js';
import { addReservation, deleteReservation, getDhcpStatus, updateDhcp } from '../lib/dhcp.js';
import { asyncHandler, requireSession } from '../middleware/auth.js';

export const dhcpRouter = Router();

dhcpRouter.use(requireSession);

dhcpRouter.get(
  '/dhcp',
  asyncHandler(async (req, res) => {
    res.json(await getDhcpStatus(req.ubus, req.session));
  }),
);

dhcpRouter.post(
  '/dhcp',
  asyncHandler(async (req, res) => {
    res.json(await updateDhcp(req.ubus, req.session, req.body));
  }),
);

/** The router's own address, which is also the address of this sign-in page. */
dhcpRouter.get(
  '/lan',
  asyncHandler(async (req, res) => {
    res.json(await getLanSettings(req.ubus, req.session));
  }),
);

dhcpRouter.post(
  '/lan',
  asyncHandler(async (req, res) => {
    res.json(await updateLan(req.ubus, req.session, req.body));
  }),
);

dhcpRouter.post(
  '/dhcp/reservations',
  asyncHandler(async (req, res) => {
    res.json(await addReservation(req.ubus, req.session, req.body));
  }),
);

dhcpRouter.delete(
  '/dhcp/reservations/:section',
  asyncHandler(async (req, res) => {
    res.json(await deleteReservation(req.ubus, req.session, String(req.params.section)));
  }),
);

/** Stops a device reaching the internet through this router. */
dhcpRouter.post(
  '/dhcp/blocked',
  asyncHandler(async (req, res) => {
    const status = await getDhcpStatus(req.ubus, req.session);
    await blockClient(req.ubus, req.session, req.body, status.mode);
    res.json(await getDhcpStatus(req.ubus, req.session));
  }),
);

dhcpRouter.delete(
  '/dhcp/blocked/:mac',
  asyncHandler(async (req, res) => {
    await unblockClient(req.ubus, req.session, String(req.params.mac));
    res.json(await getDhcpStatus(req.ubus, req.session));
  }),
);
