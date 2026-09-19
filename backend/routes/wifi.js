import { Router } from 'express';
import { channelCongestion } from '../lib/derive.js';
import { AppError } from '../lib/errors.js';
import { isInternetPaused } from '../lib/repeater-state.js';
import { applyRadioSettings, parseRadioSettings, radioCapabilities } from '../lib/wifi-config.js';
import { byNetworkName, scanNetworks } from '../lib/wifi-scan.js';
import { listRadios } from '../lib/wireless.js';
import { asyncHandler, requireSession } from '../middleware/auth.js';

export const wifiRouter = Router();

wifiRouter.use(requireSession);

/** Radios with their live state and what each one is capable of. */
wifiRouter.get(
  '/wifi',
  asyncHandler(async (req, res) => {
    const radios = await listRadios(req.ubus);
    // Read UCI wireless config once to extract per-interface keys.
    const uciWireless = (await req.ubus.uciGet('wireless')) ?? {};

    const detailed = [];
    for (const radio of radios) {
      let capabilities;
      try {
        capabilities = await radioCapabilities(req.ubus, radio.id);
      } catch (err) {
        console.error(`[wifi] radioCapabilities failed for ${radio.id}:`, err.message);
        capabilities = {
          id: radio.id, band: radio.band, label: radio.label,
          channels: [], htmodes: [], widthOptions: [], hwmodes: [],
          txpower: null, country: null,
          supports: { channel: false, htmode: false, txpower: false },
        };
      }

      // Enrich interfaces with the UCI key so the edit form can pre-fill it.
      const enrichedInterfaces = radio.interfaces.map((iface) => {
        const uciSection = iface.section
          ? Object.values(uciWireless).find((s) => s['.name'] === iface.section)
          : null;
        return { ...iface, key: uciSection?.key ?? null };
      });
      detailed.push({ ...radio, interfaces: enrichedInterfaces, capabilities });
    }
    const repeaterPaused = await isInternetPaused(req.ubus);
    res.json({ radios: detailed, supported: detailed.length > 0, repeaterPaused });
  }),
);

wifiRouter.get(
  '/wifi/scan',
  asyncHandler(async (req, res) => {
    const radios = await listRadios(req.ubus, { withClients: false });
    const radioId = req.query.radio ? String(req.query.radio) : radios[0]?.id;
    if (!radioId) {
      throw new AppError('NO_RADIO', 'This router has no Wi-Fi radio to search with.', { status: 409 });
    }
    // Accumulated across passes, so the channel picture fills in rather than flickering.
    const networks = await scanNetworks(req.ubus, radioId, req.session);
    res.json({
      radio: radioId,
      radios: radios.map((radio) => ({ id: radio.id, label: radio.label, band: radio.band })),
      networks,
      joinable: byNetworkName(networks),
      // Every access point counts towards congestion, including ones sharing a name.
      congestion: channelCongestion(networks),
    });
  }),
);

/** Devices currently connected to one radio. */
wifiRouter.get(
  '/wifi/clients',
  asyncHandler(async (req, res) => {
    const radios = await listRadios(req.ubus);
    const clients = [];
    for (const radio of radios) {
      for (const iface of radio.interfaces) {
        if (!iface.ifname || iface.mode !== 'ap') continue;
        const assoc = await req.ubus.tryCall('iwinfo', 'assoclist', { device: iface.ifname }, null);
        for (const entry of assoc?.results ?? []) {
          clients.push({
            mac: entry.mac,
            signal: entry.signal ?? null,
            radio: radio.id,
            band: radio.band,
            ssid: iface.ssid,
            connectedSeconds: entry.connected_time ?? null,
          });
        }
      }
    }
    res.json({ clients, available: radios.length > 0 });
  }),
);

wifiRouter.post(
  '/wifi/radio/:id',
  asyncHandler(async (req, res) => {
    const radioId = String(req.params.id);
    const capabilities = await radioCapabilities(req.ubus, radioId);
    const settings = parseRadioSettings(req.body, capabilities);
    const result = await applyRadioSettings({
      client: req.ubus,
      session: req.session,
      radioId,
      settings,
    });
    res.json(result);
  }),
);

/** Scan-based channel optimization: find the least congested channel and apply it. */
wifiRouter.post(
  '/wifi/optimize/:id',
  asyncHandler(async (req, res) => {
    const { optimizeChannel } = await import('../lib/wifi-config.js');
    const radioId = String(req.params.id);

    console.log('[optimize debug] Session ACLs:', JSON.stringify(req.session.acls, null, 2));

    try {
      const objects = await req.ubus.listObjects();
      console.log('[optimize debug] Available UBUS Objects:', Object.keys(objects || {}).join(', '));
      console.log('[optimize debug] luci methods:', objects['luci'] || 'none');
      console.log('[optimize debug] luci-rpc methods:', objects['luci-rpc'] || 'none');
      console.log('[optimize debug] rpc-sys methods:', objects['rpc-sys'] || 'none');
    } catch (e) {
      console.log('[optimize debug] listObjects FAILED:', e.message);
    }

    try {
      const wconfig = await req.ubus.call('file', 'read', { path: '/etc/config/wireless' });
      console.log('[optimize debug] wireless config:\n', wconfig.data.substring(0, 500));
    } catch (e) {
      console.log('[optimize debug] read wireless config FAILED:', e.message);
    }

    // Step 1: scan and find the best channel.
    const analysis = await optimizeChannel(req.ubus, radioId, req.session);

    // Step 2: apply the chosen channel.
    const capabilities = await radioCapabilities(req.ubus, radioId);
    const settings = parseRadioSettings({ channel: analysis.channel }, capabilities);
    const result = await applyRadioSettings({
      client: req.ubus,
      session: req.session,
      radioId,
      settings,
    });

    res.json({
      ...result,
      optimized: true,
      channel: Number(analysis.channel),
      reason: analysis.reason,
      scores: analysis.scores,
      networksScanned: analysis.networks,
    });
  }),
);

wifiRouter.post(
  '/wifi/repeater/disconnect',
  asyncHandler(async (req, res) => {
    const { Uci } = await import('../lib/uci.js');
    const uci = new Uci(req.ubus);
    
    // Find or create the pause-internet rule
    const firewall = await req.ubus.uciGet('firewall');
    let ruleName = 'pause_internet';
    
    // Check if it exists by name or internal ID
    const existing = Object.entries(firewall || {}).find(([k, v]) => v['.type'] === 'rule' && (v.name === 'pause-internet' || k === 'pause_internet'));
    if (existing) {
      ruleName = existing[0];
    } else {
      // Ensure it exists (signature: config, section, type, values)
      await uci.ensure('firewall', ruleName, 'rule', {
        name: 'pause-internet',
        src: 'lan',
        dest: 'wan',
        proto: 'all',
        target: 'REJECT'
      });
    }
    
    await uci.set('firewall', ruleName, { enabled: '1', proto: 'all' });
    await req.ubus.tryCall('uci', 'commit', { config: 'firewall' });
    
    // Apply changes (no service restart)
    try {
      await req.ubus.call('uci', 'apply', { timeout: 10, rollback: false });
    } catch {
      await req.ubus.tryCall('firewall', 'reload', {});
    }

    res.json({ success: true, paused: true });
  }),
);

wifiRouter.post(
  '/wifi/repeater/connect',
  asyncHandler(async (req, res) => {
    const { Uci } = await import('../lib/uci.js');
    const uci = new Uci(req.ubus);
    
    const firewall = await req.ubus.uciGet('firewall');
    let ruleName = 'pause_internet';
    
    const existing = Object.entries(firewall || {}).find(([k, v]) => v['.type'] === 'rule' && (v.name === 'pause-internet' || k === 'pause_internet'));
    if (existing) {
      ruleName = existing[0];
    } else {
      await uci.ensure('firewall', ruleName, 'rule', {
        name: 'pause-internet',
        src: 'lan',
        dest: 'wan',
        proto: 'all',
        target: 'REJECT'
      });
    }
    
    await uci.set('firewall', ruleName, { enabled: '0', proto: 'all' });
    await req.ubus.tryCall('uci', 'commit', { config: 'firewall' });
    
    try {
      await req.ubus.call('uci', 'apply', { timeout: 10, rollback: false });
    } catch {
      await req.ubus.tryCall('firewall', 'reload', {});
    }

    res.json({ success: true, paused: false });
  }),
);

wifiRouter.get(
  '/wifi/guest',
  asyncHandler(async (req, res) => {
    const { getGuestStatus } = await import('../lib/guest.js');
    res.json(await getGuestStatus(req.ubus));
  }),
);

wifiRouter.post(
  '/wifi/guest',
  asyncHandler(async (req, res) => {
    const { updateGuest } = await import('../lib/guest.js');
    res.json(await updateGuest(req.ubus, req.session, req.body));
  }),
);

/** Diagnostic dump of guest network state — useful for debugging DHCP issues. */
wifiRouter.get(
  '/wifi/guest/debug',
  asyncHandler(async (req, res) => {
    const ubus = req.ubus;
    const [network, wireless, dhcp, firewall] = await Promise.all([
      ubus.uciGet('network'),
      ubus.uciGet('wireless'),
      ubus.uciGet('dhcp'),
      ubus.uciGet('firewall'),
    ]);

    // Live interface dump
    const ifDump = await ubus.tryCall('network.interface', 'dump', {}, null);
    const guestIf = (ifDump?.interface ?? []).find(i => i.interface === 'guest') ?? null;

    // Check which ubus services are available for restart
    const ubusObjects = await ubus.listObjects();
    const hasInit    = 'init'    in (ubusObjects ?? {});
    const hasService = 'service' in (ubusObjects ?? {});

    const guestNetwork  = network  ? Object.fromEntries(Object.entries(network).filter(([k]) => k === 'guest'))  : null;
    const guestWireless = wireless ? Object.values(wireless).filter(s => s.network === 'guest')  : [];
    const guestDhcp     = dhcp     ? Object.fromEntries(Object.entries(dhcp).filter(([k]) => k === 'guest'))     : null;
    const guestFirewall = firewall  ? Object.values(firewall).filter(s => s.name === 'guest' || s.src === 'guest' || (s.name && s.name.startsWith('Guest_'))) : [];

    res.json({
      uci: { guestNetwork, guestWireless, guestDhcp, guestFirewall },
      live: { guestInterface: guestIf },
      ubusServices: { hasInit, hasService, keys: Object.keys(ubusObjects ?? {}).slice(0, 40) },
    });
  }),
);

