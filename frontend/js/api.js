export class ApiError extends Error {
  constructor({ code, message, details }, status) {
    super(message || 'Request failed');
    this.code = code || 'UNKNOWN';
    this.details = details;
    this.status = status;
  }
}

async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-EasyMode': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) throw new ApiError(payload?.error ?? {}, response.status);
  return payload;
}

export const api = {
  bootConfig: () => request('/auth/config'),
  login: (credentials) => request('/auth/login', { method: 'POST', body: credentials }),
  session: () => request('/auth/session'),
  logout: () => request('/auth/logout', { method: 'POST' }),
  status: () => request('/status'),
  modeOverview: () => request('/mode'),
  applyRouterMode: (options) => request('/mode/router', { method: 'POST', body: options }),
  applyApMode: (options) => request('/mode/ap', { method: 'POST', body: options }),
  applyRepeaterMode: (options) => request('/mode/repeater', { method: 'POST', body: options }),
  applyHotspotMode: (options) => request('/mode/hotspot', { method: 'POST', body: options }),
  scanWifi: (radio) => request(`/wifi/scan${radio ? `?radio=${encodeURIComponent(radio)}` : ''}`),
  wifi: () => request('/wifi'),
  wifiClients: () => request('/wifi/clients'),
  updateRadio: (radio, settings) =>
    request(`/wifi/radio/${encodeURIComponent(radio)}`, { method: 'POST', body: settings }),
  optimizeRadio: (radio) =>
    request(`/wifi/optimize/${encodeURIComponent(radio)}`, { method: 'POST' }),
  disconnectRepeater: () => request('/wifi/repeater/disconnect', { method: 'POST' }),
  connectRepeater: () => request('/wifi/repeater/connect', { method: 'POST' }),
  guestWifi: () => request('/wifi/guest'),
  updateGuestWifi: (settings) => request('/wifi/guest', { method: 'POST', body: settings }),
  dhcp: () => request('/dhcp'),
  updateDhcp: (settings) => request('/dhcp', { method: 'POST', body: settings }),
  addReservation: (entry) => request('/dhcp/reservations', { method: 'POST', body: entry }),
  deleteReservation: (section) =>
    request(`/dhcp/reservations/${encodeURIComponent(section)}`, { method: 'DELETE' }),
  systemOverview: () => request('/system/overview'),
  backup: () => request('/system/backup'),
  restore: (payload) => request('/system/restore', { method: 'POST', body: payload }),
  reboot: () => request('/system/reboot', { method: 'POST' }),
  lan: () => request('/lan'),
  updateLan: (settings) => request('/lan', { method: 'POST', body: settings }),
  blockClient: (entry) => request('/dhcp/blocked', { method: 'POST', body: entry }),
  unblockClient: (mac) => request(`/dhcp/blocked/${encodeURIComponent(mac)}`, { method: 'DELETE' }),
  bandwidth: () => request('/bandwidth'),
  setBandwidthLimits: (limits) => request('/bandwidth/limits', { method: 'POST', body: limits }),
  setDeviceLimits: (mac, limits) => request(`/bandwidth/device/${encodeURIComponent(mac)}`, { method: 'POST', body: limits }),
  job: (id) => request(`/mode/job/${id}`),
  ping: (host) => request('/diagnostics/ping', { method: 'POST', body: { host } }),
  traceroute: (host) => request('/diagnostics/traceroute', { method: 'POST', body: { host } }),
  setAutoReboot: (schedule) => request('/system/autoreboot', { method: 'POST', body: schedule }),
};
