import { bandFromFrequency, bandFromUci, bandLabel, signalQuality, uciBool } from './derive.js';

/**
 * Normalizes OpenWrt wireless state into band-labelled radios.
 * Radio device names (radio0/radio1) are never assumed to mean a band.
 */
export async function listRadios(client, { withClients = true } = {}) {
  const status = await client.tryCall('network.wireless', 'status', {}, null);
  const uciWireless = (await client.uciGet('wireless')) ?? {};
  const radios = [];

  if (status) {
    // Primary path: network.wireless.status gives live state.
    for (const [radioId, radio] of Object.entries(status)) {
      const uciRadio = Object.values(uciWireless).find(
        (section) => section['.type'] === 'wifi-device' && section['.name'] === radioId,
      );
      const cfg = radio.config ?? {};
      const interfaces = [];
      let band = bandFromUci({ band: cfg.band ?? uciRadio?.band, hwmode: cfg.hwmode ?? uciRadio?.hwmode, channel: cfg.channel ?? uciRadio?.channel });
      let liveChannel = null;
      let txpower = null;

      for (const iface of radio.interfaces ?? []) {
        const ifaceCfg = iface.config ?? {};
        const ifname = iface.ifname ?? null;
        const info = ifname ? await client.tryCall('iwinfo', 'info', { device: ifname }, null) : null;
        if (info?.frequency) {
          band = bandFromFrequency(info.frequency) ?? band;
          liveChannel = info.channel ?? liveChannel;
          txpower = info.txpower ?? txpower;
        }

        let clients = null;
        let clientMacs = [];
        let uplinkSignal = null;
        if (withClients && ifname) {
          const assoc = await client.tryCall('iwinfo', 'assoclist', { device: ifname }, null);
          if (assoc?.results) {
            clients = assoc.results.length;
            clientMacs = assoc.results.map(r => r.mac?.toLowerCase()).filter(Boolean);
            if (ifaceCfg.mode === 'sta' && assoc.results[0]) uplinkSignal = assoc.results[0].signal ?? null;
          }
        }

        interfaces.push({
          section: iface.section ?? null,
          ifname,
          mode: ifaceCfg.mode ?? 'ap',
          ssid: ifaceCfg.ssid ?? info?.ssid ?? null,
          network: Array.isArray(ifaceCfg.network) ? ifaceCfg.network : ifaceCfg.network ? [ifaceCfg.network] : [],
          encryption: ifaceCfg.encryption ?? (info?.encryption?.enabled ? 'enabled' : 'none'),
          hidden: uciBool(ifaceCfg.hidden),
          isolate: uciBool(ifaceCfg.isolate),
          disabled: uciBool(ifaceCfg.disabled),
          up: Boolean(info),
          clients,
          clientMacs,
          signal: info?.signal ?? uplinkSignal ?? null,
          quality: signalQuality(info?.signal ?? uplinkSignal),
        });
      }

      const apInterfaces = interfaces.filter((iface) => iface.mode === 'ap');
      const clientCounts = apInterfaces.map((iface) => iface.clients).filter((count) => count != null);
      
      const radioEnabled = Boolean(radio.up) && !uciBool(cfg.disabled);
      const anyApEnabled = apInterfaces.some((iface) => !iface.disabled);

      radios.push({
        id: radioId,
        band,
        label: bandLabel(band),
        enabled: radioEnabled && anyApEnabled,
        pending: Boolean(radio.pending),
        channel: liveChannel ?? (cfg.channel === 'auto' ? null : Number(cfg.channel) || null),
        channelConfig: cfg.channel ?? null,
        htmode: cfg.htmode ?? null,
        country: cfg.country ?? null,
        txpower,
        ssid: apInterfaces[0]?.ssid ?? null,
        clients: clientCounts.length ? clientCounts.reduce((sum, count) => sum + count, 0) : null,
        interfaces,
      });
    }
  } else {
    // Fallback path: some vendor OpenWrt builds (e.g. JioRouter AX6000) don't expose
    // network.wireless as a ubus object. Read radio list directly from UCI config and
    // supplement live data from iwinfo where available.
    const radioSections = Object.values(uciWireless).filter((s) => s['.type'] === 'wifi-device');
    const ifaceSections = Object.values(uciWireless).filter((s) => s['.type'] === 'wifi-iface');

    for (const uciRadio of radioSections) {
      const radioId = uciRadio['.name'];
      // Try to get live info from iwinfo using the radio device name directly.
      const liveInfo = await client.tryCall('iwinfo', 'info', { device: radioId }, null);
      let band = bandFromUci({ band: uciRadio.band, hwmode: uciRadio.hwmode, channel: uciRadio.channel });
      let liveChannel = null;
      let txpower = null;
      if (liveInfo?.frequency) {
        band = bandFromFrequency(liveInfo.frequency) ?? band;
        liveChannel = liveInfo.channel ?? null;
        txpower = liveInfo.txpower ?? null;
      }

      // Match wifi-iface sections that belong to this radio.
      const myIfaces = ifaceSections.filter((s) => s.device === radioId);
      const interfaces = [];
      let ifaceIndex = 0;
      for (const ifaceCfg of myIfaces) {
        // Derive ifname: UCI ifaces don't always have an explicit ifname.
        // Convention: radio0 AP iface 0 → phy0-ap0, STA iface → phy0-sta0.
        const radioIndex = radioId.replace(/\D/g, '');
        const modeStr = (ifaceCfg.mode ?? 'ap') === 'sta' ? 'sta' : 'ap';
        const derivedIfname = radioIndex !== ''
          ? `phy${radioIndex}-${modeStr}${modeStr === 'ap' ? ifaceIndex : 0}`
          : null;
        const ifname = ifaceCfg.ifname ?? derivedIfname;
        const info = ifname ? await client.tryCall('iwinfo', 'info', { device: ifname }, null) : null;
        if (info?.frequency) {
          band = bandFromFrequency(info.frequency) ?? band;
          liveChannel = info.channel ?? liveChannel;
          txpower = info.txpower ?? txpower;
        }

        let clients = null;
        let clientMacs = [];
        let uplinkSignal = null;
        if (withClients && ifname) {
          const assoc = await client.tryCall('iwinfo', 'assoclist', { device: ifname }, null);
          if (assoc?.results) {
            clients = assoc.results.length;
            clientMacs = assoc.results.map(r => r.mac?.toLowerCase()).filter(Boolean);
            if (ifaceCfg.mode === 'sta' && assoc.results[0]) uplinkSignal = assoc.results[0].signal ?? null;
          }
        }

        if (modeStr === 'ap') ifaceIndex += 1;

        interfaces.push({
          section: ifaceCfg['.name'] ?? null,
          ifname,
          mode: ifaceCfg.mode ?? 'ap',
          ssid: ifaceCfg.ssid ?? info?.ssid ?? null,
          network: Array.isArray(ifaceCfg.network) ? ifaceCfg.network : ifaceCfg.network ? [ifaceCfg.network] : [],
          encryption: ifaceCfg.encryption ?? 'none',
          hidden: uciBool(ifaceCfg.hidden),
          isolate: uciBool(ifaceCfg.isolate),
          disabled: uciBool(ifaceCfg.disabled),
          up: Boolean(info),
          clients,
          clientMacs,
          signal: info?.signal ?? uplinkSignal ?? null,
          quality: signalQuality(info?.signal ?? uplinkSignal),
        });
      }

      const apInterfaces = interfaces.filter((iface) => iface.mode === 'ap');
      const clientCounts = apInterfaces.map((iface) => iface.clients).filter((count) => count != null);
      
      const radioEnabled = !uciBool(uciRadio.disabled);
      const anyApEnabled = apInterfaces.some((iface) => !iface.disabled);

      radios.push({
        id: radioId,
        band,
        label: bandLabel(band),
        enabled: radioEnabled && anyApEnabled,
        pending: false,
        channel: liveChannel ?? (uciRadio.channel === 'auto' ? null : Number(uciRadio.channel) || null),
        channelConfig: uciRadio.channel ?? null,
        htmode: uciRadio.htmode ?? null,
        country: uciRadio.country ?? null,
        txpower,
        ssid: apInterfaces[0]?.ssid ?? null,
        clients: clientCounts.length ? clientCounts.reduce((sum, count) => sum + count, 0) : null,
        interfaces,
      });
    }
  }

  radios.sort((a, b) => Number(a.band ?? 99) - Number(b.band ?? 99));
  return radios;
}

/** The wireless uplink (STA) interface, if the router has one configured. */
export function findStaUplink(radios) {
  for (const radio of radios) {
    const sta = radio.interfaces.find((iface) => iface.mode === 'sta');
    if (sta) {
      return {
        configured: true,
        connected: sta.up && Boolean(sta.ssid),
        ssid: sta.ssid,
        ifname: sta.ifname,
        radioId: radio.id,
        band: radio.band,
        signal: sta.signal,
        quality: sta.quality,
        networks: sta.network,
      };
    }
  }
  return { configured: false, connected: false, ssid: null };
}
