import { AppError, errors } from '../lib/errors.js';
import { UbusError } from '../lib/ubus.js';
import { SESSION_COOKIE, clientFor, dropSession, getSession } from '../lib/session.js';

/** Minimal cookie parsing - the app sets exactly one cookie. */
export function readSessionCookie(req) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/**
 * Same-origin guard: browsers cannot set a custom header on a simple cross-site
 * request, so this blocks drive-by POSTs against the router API.
 */
export function requireAppHeader(req, _res, next) {
  if (req.method === 'GET' || req.get('X-EasyMode') === '1') return next();
  next(new AppError('BAD_REQUEST', 'Missing EasyMode request header.', { status: 400 }));
}

export function requireSession(req, _res, next) {
  const id = readSessionCookie(req);
  const session = getSession(id);
  if (!session) return next(errors.noSession());
  req.session = session;
  req.ubus = clientFor(session);
  next();
}

export const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

export function errorHandler(error, req, res, _next) {
  if (error instanceof AppError) {
    return res.status(error.status).json(error.toJSON());
  }
  if (error instanceof UbusError) {
    // A denied call on an established session usually means the router session expired.
    if (error.isDenied) {
      if (req.session) dropSession(req.session.id);
      const expired = errors.noSession();
      return res.status(expired.status).json(expired.toJSON());
    }
    const failed = errors.routerFailed(error.message);
    return res.status(failed.status).json(failed.toJSON());
  }
  console.error('[easymode] unexpected error:', error);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Unexpected server error.' } });
}
