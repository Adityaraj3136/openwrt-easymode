import net from 'node:net';
import { config } from '../config.js';
import { errors } from './errors.js';

const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const LOCAL_SUFFIXES = ['.lan', '.local', '.localdomain', '.home', '.home.arpa'];

export function isPrivateIPv4(ip) {
  if (net.isIPv4(ip) !== 4 && net.isIP(ip) !== 4) return false;
  const [a, b] = ip.split('.').map(Number);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 127) return true;
  return false;
}

/** Validates operator-supplied router addresses and keeps the backend off the public internet. */
export function normalizeRouterHost(rawHost) {
  const host = String(rawHost ?? '').trim().toLowerCase();
  if (!host) throw errors.invalidHost(rawHost ?? '');

  const isIp = net.isIP(host) !== 0;
  if (!isIp && !HOSTNAME_RE.test(host)) throw errors.invalidHost(rawHost);
  if (config.allowPublicRouter) return host;

  if (isIp) {
    if (net.isIP(host) === 6) {
      const isLocalV6 = host.startsWith('fe80:') || host.startsWith('fd') || host === '::1';
      if (!isLocalV6) throw errors.hostNotAllowed(rawHost);
      return host;
    }
    if (!isPrivateIPv4(host)) throw errors.hostNotAllowed(rawHost);
    return host;
  }

  const isLocalName = !host.includes('.') || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
  if (!isLocalName) throw errors.hostNotAllowed(rawHost);
  return host;
}

/** Cheap reachability probe so "router unreachable" is distinguishable from "bad password". */
export async function probeReachable(host, scheme = config.routerScheme) {
  try {
    await fetch(`${scheme}://${host}/`, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(config.probeTimeoutMs),
    });
    return true;
  } catch {
    return false;
  }
}
