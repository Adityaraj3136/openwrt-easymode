export class AppError extends Error {
  constructor(code, message, { status = 400, details } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export const errors = {
  invalidHost: (host) =>
    new AppError('INVALID_HOST', `"${host}" is not a valid router address.`),
  hostNotAllowed: (host) =>
    new AppError(
      'HOST_NOT_ALLOWED',
      `"${host}" is outside the private network ranges this tool manages.`,
      { details: 'Set EASYMODE_ALLOW_PUBLIC_ROUTER=1 to override.' },
    ),
  unreachable: (host) =>
    new AppError('ROUTER_UNREACHABLE', `No answer from ${host}. Check the address and cabling.`, {
      status: 502,
    }),
  ubusUnavailable: () =>
    new AppError(
      'UBUS_UNAVAILABLE',
      'The router answered, but its management API (ubus over HTTP) is not enabled.',
      {
        status: 502,
        details:
          'On the router run: opkg update && opkg install uhttpd-mod-ubus rpcd, then restart uhttpd.',
      },
    ),
  notOpenWrt: (what) =>
    new AppError('NOT_OPENWRT', `That device does not look like an OpenWrt router (${what}).`, {
      status: 502,
    }),
  badCredentials: () =>
    new AppError('INVALID_CREDENTIALS', 'Wrong username or password.', { status: 401 }),
  rateLimited: () =>
    new AppError('RATE_LIMITED', 'Too many failed sign-in attempts. Wait a few minutes.', {
      status: 429,
    }),
  noSession: () =>
    new AppError('NO_SESSION', 'Your session expired. Please connect to the router again.', {
      status: 401,
    }),
  routerDenied: (detail) =>
    new AppError('ROUTER_PERMISSION_DENIED', 'The router refused this request.', {
      status: 403,
      details: detail,
    }),
  routerFailed: (detail) =>
    new AppError('ROUTER_ERROR', 'The router could not complete the request.', {
      status: 502,
      details: detail,
    }),
};
