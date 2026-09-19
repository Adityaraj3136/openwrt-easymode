import { config } from '../config.js';
import { AppError, errors } from './errors.js';

export const NULL_SID = '0'.repeat(32);

export const UBUS_STATUS = {
  0: 'OK',
  1: 'INVALID_COMMAND',
  2: 'INVALID_ARGUMENT',
  3: 'METHOD_NOT_FOUND',
  4: 'NOT_FOUND',
  5: 'NO_DATA',
  6: 'PERMISSION_DENIED',
  7: 'TIMEOUT',
  8: 'NOT_SUPPORTED',
  9: 'UNKNOWN_ERROR',
  10: 'CONNECTION_FAILED',
};

export class UbusError extends Error {
  constructor(status, target) {
    super(`ubus ${target} failed: ${UBUS_STATUS[status] ?? status}`);
    this.name = 'UbusError';
    this.status = status;
    this.target = target;
  }

  get isMissing() {
    return this.status === 3 || this.status === 4 || this.status === 8;
  }

  get isDenied() {
    return this.status === 6;
  }
}

/**
 * Thin JSON-RPC client for uhttpd-mod-ubus (`/ubus` on the router).
 * It knows nothing about EasyMode features; higher layers compose calls.
 */
export class UbusClient {
  constructor({ host, scheme = config.routerScheme, sid = NULL_SID, timeoutMs = config.routerTimeoutMs }) {
    this.host = host;
    this.scheme = scheme;
    this.sid = sid;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
  }

  get url() {
    return `${this.scheme}://${this.host}/ubus`;
  }

  async rpc(method, params) {
    let response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      if (cause?.name === 'TimeoutError') throw errors.unreachable(this.host);
      throw errors.unreachable(this.host);
    }

    if (response.status === 404) throw errors.ubusUnavailable();
    if (!response.ok) {
      throw new AppError('ROUTER_HTTP_ERROR', `Router replied with HTTP ${response.status}.`, {
        status: 502,
      });
    }

    let payload;
    const text = await response.text();
    if (!text.trim()) {
      // Empty response from uhttpd (often a sign that rpcd segfaulted or timed out internally).
      // If this was a call, pretend it returned successfully with no data.
      return Array.isArray(params) && params[0] === 'call' ? [0, {}] : {};
    }
    try {
      // Sanitize unescaped control characters which are common in iwinfo scan results (e.g. malformed SSIDs)
      const sanitized = text.replace(/[\x00-\x09\x0B-\x1F]/g, '');
      payload = JSON.parse(sanitized);
    } catch (err) {
      throw new AppError('UBUS_MALFORMED', `Router returned invalid JSON: ${text.slice(0, 150)}`, { status: 502 });
    }

    if (payload.error) {
      // -32002 is rpcd's "Access denied" for an expired or unprivileged session.
      if (payload.error.code === -32002) throw new UbusError(6, method);
      throw errors.routerFailed(payload.error.message ?? 'JSON-RPC error');
    }
    return payload.result;
  }

  /** ubus call. Returns the payload object (`{}` when the method returns nothing). */
  async call(object, method, args = {}) {
    const result = await this.rpc('call', [this.sid, object, method, args]);
    if (object === 'uci' && method === 'commit') {
      console.log(`[ubus debug] uci commit ${args.config} raw result:`, JSON.stringify(result));
    }
    if (!Array.isArray(result)) throw errors.routerFailed(`unexpected reply for ${object}.${method}`);
    const [status, data] = result;
    if (status !== 0) throw new UbusError(status, `${object}.${method}`);
    return data ?? {};
  }

  /** Same as call(), but returns `fallback` when the object/method/ACL is absent. */
  async tryCall(object, method, args = {}, fallback = null) {
    try {
      return await this.call(object, method, args);
    } catch (error) {
      if (error instanceof UbusError && (error.isMissing || error.isDenied)) return fallback;
      throw error;
    }
  }

  /** Map of ubus objects visible to this session -> method signatures. */
  async listObjects(pattern = '*') {
    const result = await this.rpc('list', [this.sid, pattern]);
    return result && typeof result === 'object' ? result : {};
  }

  async login(username, password) {
    const anon = new UbusClient({ host: this.host, scheme: this.scheme, timeoutMs: this.timeoutMs });
    const result = await anon.rpc('call', [
      NULL_SID,
      'session',
      'login',
      { username, password },
    ]);
    const [status, data] = Array.isArray(result) ? result : [9];
    if (status === 6 || status === 5 || !data?.ubus_rpc_session) throw errors.badCredentials();
    if (status !== 0) throw new UbusError(status, 'session.login');
    this.sid = data.ubus_rpc_session;
    return { sid: data.ubus_rpc_session, timeout: data.timeout, acls: data.acls };
  }

  async logout() {
    if (this.sid === NULL_SID) return;
    await this.tryCall('session', 'destroy', { ubus_rpc_session: this.sid });
  }

  /** Reads a text file through rpcd-mod-file. Returns null when unavailable. */
  async readFile(path) {
    const result = await this.tryCall('file', 'read', { path });
    return typeof result?.data === 'string' ? result.data : null;
  }

  /** Reads a UCI config as `{ section: { ...options } }`. Returns null when absent. */
  async uciGet(configName) {
    const result = await this.tryCall('uci', 'get', { config: configName });
    return result?.values ?? null;
  }
}
