import { config } from '../config.js';

const attempts = new Map();

/** Per key (client ip + router host) failed-login throttle. In-memory is enough for a LAN tool. */
export function checkRate(key) {
  const entry = attempts.get(key);
  if (!entry) return true;
  if (Date.now() - entry.first > config.loginWindowMs) {
    attempts.delete(key);
    return true;
  }
  return entry.count < config.loginMaxAttempts;
}

export function recordFailure(key) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now - entry.first > config.loginWindowMs) {
    attempts.set(key, { first: now, count: 1 });
    return;
  }
  entry.count += 1;
}

export function clearRate(key) {
  attempts.delete(key);
}
