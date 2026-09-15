import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { UbusClient } from './ubus.js';

export const SESSION_COOKIE = 'em_sid';

const sessions = new Map();

export function createSession({ host, scheme, ubusSid, username, router, capabilities, demoClient = null }) {
  const id = randomBytes(24).toString('base64url');
  const now = Date.now();
  sessions.set(id, {
    id,
    host,
    scheme,
    ubusSid,
    username,
    router,
    capabilities,
    // Present only for the simulated router; every other module stays unaware.
    demoClient,
    createdAt: now,
    lastSeen: now,
    // Per-session scratch space (previous /proc/stat sample, cached leases, ...).
    scratch: {},
  });
  return id;
}

export function getSession(id) {
  if (!id) return null;
  const session = sessions.get(id);
  if (!session) return null;
  if (Date.now() - session.lastSeen > config.sessionIdleMs) {
    sessions.delete(id);
    return null;
  }
  session.lastSeen = Date.now();
  return session;
}

export function dropSession(id) {
  const session = sessions.get(id);
  sessions.delete(id);
  return session ?? null;
}

/** ubus client bound to a stored session. The router password is never kept. */
export function clientFor(session) {
  return session.demoClient ?? new UbusClient({ host: session.host, scheme: session.scheme, sid: session.ubusSid });
}

setInterval(() => {
  const cutoff = Date.now() - config.sessionIdleMs;
  for (const [id, session] of sessions) {
    if (session.lastSeen < cutoff) sessions.delete(id);
  }
}, 60_000).unref();
