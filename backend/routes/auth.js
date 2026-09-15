import { Router } from 'express';
import os from 'node:os';
import { config } from '../config.js';
import { detectCapabilities } from '../lib/capabilities.js';
import { DemoRouterClient } from '../lib/demo-router.js';
import { errors } from '../lib/errors.js';
import { normalizeRouterHost, probeReachable } from '../lib/host.js';
import { checkRate, clearRate, recordFailure } from '../lib/ratelimit.js';
import { SESSION_COOKIE, clientFor, createSession, dropSession } from '../lib/session.js';
import { UbusClient } from '../lib/ubus.js';
import { asyncHandler, readSessionCookie, requireSession } from '../middleware/auth.js';

export const authRouter = Router();

const DEMO_HOSTS = { demo: 'full', 'demo-minimal': 'minimal' };
const DEMO_HOST = 'demo';

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  // No Secure flag: routers and this tool normally run over plain HTTP on the LAN.
};

const isOpenWrt = (board) => {
  const distribution = board?.release?.distribution ?? '';
  return /openwrt|lede/i.test(distribution);
};

async function guessRouterIp() {
  const nets = os.networkInterfaces();
  const candidates = [];
  
  for (const name of Object.keys(nets)) {
    if (/^(veth|docker|vmnet|vbox|br-|tailscale|utun|tun|tap|wg)/i.test(name)) continue;
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        const parts = net.address.split('.');
        parts[3] = '1';
        candidates.push(parts.join('.'));
      }
    }
  }

  const unique = [...new Set(candidates)];
  if (unique.length === 0) return null;
  
  try {
    return await Promise.any(
      unique.map(async (ip) => {
        if (await probeReachable(ip, 800)) return ip;
        throw new Error('Unreachable');
      })
    );
  } catch {
    return unique[0];
  }
}

authRouter.get(
  '/config',
  asyncHandler(async (_req, res) => {
    res.json({
      defaultRouterHost: (await guessRouterIp()) || config.defaultRouterHost,
      scheme: config.routerScheme,
      demoAvailable: config.demo,
      demoHost: DEMO_HOST,
    });
  }),
);

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { host: rawHost, username, password } = req.body ?? {};

    // The simulated router short-circuits reachability and authentication only.
    // Everything after this point is the same code a real router goes through.
    const demoHost = String(rawHost ?? '').trim().toLowerCase();
    if (config.demo && DEMO_HOSTS[demoHost]) {
      // 'demo-minimal' is a bare router with no optional packages, used to prove the
      // interface degrades instead of breaking.
      const demoClient = new DemoRouterClient({ host: demoHost, profile: DEMO_HOSTS[demoHost] });
      const board = await demoClient.call('system', 'board');
      const capabilities = await detectCapabilities(demoClient, board);
      const sid = createSession({
        host: demoHost,
        scheme: 'http',
        ubusSid: demoClient.sid,
        username: 'demo',
        router: capabilities.router,
        capabilities,
        demoClient,
      });
      res.cookie(SESSION_COOKIE, sid, cookieOptions);
      return res.json({ router: capabilities.router, capabilities, username: 'demo', host: demoHost, demo: true });
    }

    if (typeof username !== 'string' || !username.trim()) {
      throw errors.badCredentials();
    }
    const host = normalizeRouterHost(rawHost || config.defaultRouterHost);
    const rateKey = `${req.ip}|${host}`;
    if (!checkRate(rateKey)) throw errors.rateLimited();

    if (!(await probeReachable(host))) {
      recordFailure(rateKey);
      throw errors.unreachable(host);
    }

    const client = new UbusClient({ host });
    try {
      await client.login(username.trim(), String(password ?? ''));
    } catch (error) {
      recordFailure(rateKey);
      throw error;
    }

    const board = await client.call('system', 'board');
    if (!isOpenWrt(board)) {
      await client.logout();
      throw errors.notOpenWrt(board?.release?.distribution || 'unknown firmware');
    }

    const capabilities = await detectCapabilities(client, board);
    clearRate(rateKey);

    const sid = createSession({
      host,
      scheme: config.routerScheme,
      ubusSid: client.sid,
      username: username.trim(),
      router: capabilities.router,
      capabilities,
    });

    res.cookie(SESSION_COOKIE, sid, cookieOptions);
    res.json({ router: capabilities.router, capabilities, username: username.trim(), host });
  }),
);

authRouter.get(
  '/session',
  requireSession,
  asyncHandler(async (req, res) => {
    res.json({
      host: req.session.host,
      username: req.session.username,
      router: req.session.router,
      capabilities: req.session.capabilities,
      demo: Boolean(req.session.demoClient),
    });
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const session = dropSession(readSessionCookie(req));
    if (session) {
      await clientFor(session)
        .logout()
        .catch(() => {});
    }
    res.clearCookie(SESSION_COOKIE, cookieOptions);
    res.json({ ok: true });
  }),
);
