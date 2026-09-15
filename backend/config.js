const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const config = {
  port: num(process.env.EASYMODE_PORT, 8787),
  bindHost: process.env.EASYMODE_BIND || '127.0.0.1',
  defaultRouterHost: process.env.EASYMODE_DEFAULT_ROUTER || '192.168.1.1',
  routerScheme: process.env.EASYMODE_ROUTER_SCHEME === 'https' ? 'https' : 'http',
  routerTimeoutMs: num(process.env.EASYMODE_ROUTER_TIMEOUT_MS, 8000),
  probeTimeoutMs: num(process.env.EASYMODE_PROBE_TIMEOUT_MS, 4000),
  sessionIdleMs: num(process.env.EASYMODE_SESSION_IDLE_MS, 10 * 60 * 1000),
  loginMaxAttempts: num(process.env.EASYMODE_LOGIN_MAX_ATTEMPTS, 8),
  loginWindowMs: num(process.env.EASYMODE_LOGIN_WINDOW_MS, 5 * 60 * 1000),
  // Routers live on private networks. Allowing public targets would turn this
  // backend into an open proxy, so it stays opt-in.
  allowPublicRouter: process.env.EASYMODE_ALLOW_PUBLIC_ROUTER === '1',
  internetProbeHost: process.env.EASYMODE_INTERNET_PROBE_HOST || '1.1.1.1',
  // Offers a simulated router at the address "demo" so the interface can be explored
  // without hardware. Real router handling is untouched by this.
  demo: process.env.EASYMODE_DEMO !== '0',
};
