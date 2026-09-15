import { commitWithRollback } from './apply.js';
import { bandFromFrequency, bandFromUci, bandLabel, channelWidthOptions } from './derive.js';
import { AppError } from './errors.js';
import { snapshotConfigs } from './backup.js';
import { Uci, findSection, findSections } from './uci.js';
import { requireOneOf, requireRange, requireSsid, requireWifiKey, str } from './validate.js';

const ENCRYPTIONS = ['psk2', 'sae-mixed', 'sae', 'none'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What this particular radio can actually do. Controls the UI does not have hardware
 * support for are hidden rather than shown broken.
 */
export async function radioCapabilities(client, radioId) {
  const status = await client.tryCall('network.wireless', 'status', {}, null);
  const radio = status?.[radioId];

  // Some vendor builds have network.wireless in the object list but the status call
  // returns incomplete data. Fall back to UCI + iwinfo for capabilities.
  const uciWireless = radio ? null : ((await client.uciGet('wireless')) ?? {});
  const uciRadio = uciWireless
    ? Object.values(uciWireless).find((s) => s['.type'] === 'wifi-device' && s['.name'] === radioId)
    : null;

  if (!radio && !uciRadio) {
    throw new AppError('NO_SUCH_RADIO', 'That Wi-Fi radio does not exist on this router.', { status: 404 });
  }

  // Derive ifname: from live status, or by querying iwinfo with the radio id directly.
  const ifname =
    (radio?.interfaces ?? []).map((iface) => iface.ifname).find(Boolean) ??
    // Fallback: hostapd names like 'phy0-ap0' map to the radio, or try the radioId itself.
    null;

  // Try to get iwinfo data with the ifname, or fall back to trying the radioId as device name.
  const devToTry = ifname ?? radioId;
  const info = await client.tryCall('iwinfo', 'info', { device: devToTry }, null);
  const freqlist = await client.tryCall('iwinfo', 'freqlist', { device: devToTry }, null);
  const txpowerlist = await client.tryCall('iwinfo', 'txpowerlist', { device: devToTry }, null);

  const channels = (freqlist?.results ?? [])
    .filter((entry) => !entry.restricted)
    .map((entry) => ({ channel: entry.channel, mhz: entry.mhz }));
  const powers = (txpowerlist?.results ?? []).map((entry) => entry.dbm).filter(Number.isFinite);

  const radioConfig = radio?.config ?? uciRadio ?? {};
  const band =
    bandFromFrequency(info?.frequency) ??
    bandFromUci({ band: radioConfig.band, hwmode: radioConfig.hwmode, channel: radioConfig.channel });

  const htmodes = info?.htmodes ?? [];
  // Channels the radio reports but that do not belong to this band are dropped: a
  // dual-band chip lists both sets, and offering channel 36 on 2.4 GHz is nonsense.
  const bandChannels = channels.filter((entry) => {
    if (band === '2.4') return entry.channel <= 14;
    if (band === '5') return entry.channel >= 32 && entry.channel <= 177;
    return true;
  });

  return {
    id: radioId,
    band,
    label: bandLabel(band),
    channels: bandChannels.length ? bandChannels : channels,
    // Falls back to the modes OpenWrt lists for this radio, never a hardcoded set.
    htmodes,
    widthOptions: channelWidthOptions(htmodes, band),
    hwmodes: info?.hwmodes ?? [],
    txpower: powers.length ? { min: Math.min(...powers), max: Math.max(...powers) } : null,
    country: radioConfig.country ?? info?.country ?? null,
    supports: {
      channel: bandChannels.length > 0 || channels.length > 0,
      htmode: htmodes.length > 0,
      txpower: powers.length > 0,
    },
  };
}

export function parseRadioSettings(body = {}, capabilities) {
  const settings = {};

  if (body.enabled !== undefined) settings.enabled = Boolean(body.enabled);

  if (body.ssid !== undefined) settings.ssid = requireSsid(body.ssid, 'ssid');

  if (body.encryption !== undefined) {
    settings.encryption = requireOneOf(body.encryption, ENCRYPTIONS, 'encryption');
  }

  // An empty password means "leave it as it is"; it is never sent to the browser.
  const key = typeof body.key === 'string' ? body.key : '';
  if (key) settings.key = requireWifiKey(key, settings.encryption ?? 'psk2', 'key');
  if (settings.encryption === 'none') settings.key = '';

  if (body.channel !== undefined && body.channel !== null && body.channel !== '') {
    const channel = str(body.channel);
    if (channel === 'auto') settings.channel = 'auto';
    else {
      const number = Number(channel);
      const allowed = capabilities.channels.some((entry) => entry.channel === number);
      if (!allowed) throw new AppError('INVALID_SETTINGS', 'This radio cannot use that channel.', { status: 400 });
      settings.channel = String(number);
    }
  }

  if (body.htmode) {
    const htmode = str(body.htmode);
    if (!capabilities.htmodes.includes(htmode)) {
      throw new AppError('INVALID_SETTINGS', 'This radio does not support that channel width.', { status: 400 });
    }
    settings.htmode = htmode;
  }

  if (body.txpower !== undefined && body.txpower !== null && body.txpower !== '') {
    if (!capabilities.txpower) {
      throw new AppError('INVALID_SETTINGS', 'This radio does not allow changing transmit power.', { status: 400 });
    }
    settings.txpower = requireRange(
      body.txpower,
      { min: capabilities.txpower.min, max: capabilities.txpower.max, fallback: capabilities.txpower.max },
      'txpower',
    );
  }

  if (body.hidden !== undefined) settings.hidden = Boolean(body.hidden);
  if (body.isolate !== undefined) settings.isolate = Boolean(body.isolate);
  if (body.country !== undefined) settings.country = body.country ? String(body.country).toUpperCase() : null;

  if (!Object.keys(settings).length) {
    throw new AppError('INVALID_SETTINGS', 'Nothing to change.', { status: 400 });
  }
  return settings;
}

/**
 * Applies Wi-Fi settings with the rollback timer armed.
 *
 * If the change cuts off the machine running EasyMode - which it will, when the admin
 * is on the Wi-Fi being renamed - no confirm arrives and the router puts the old
 * settings back. That is the intended behaviour, and the UI says so beforehand.
 */
export async function applyRadioSettings({ client, session, radioId, settings }) {
  const wireless = (await client.uciGet('wireless')) ?? {};
  const radioSection = findSection(wireless, 'wifi-device', (_section, name) => name === radioId);
  if (!radioSection) {
    throw new AppError('NO_SUCH_RADIO', 'That Wi-Fi radio does not exist on this router.', { status: 404 });
  }

  const apSections = findSections(
    wireless,
    'wifi-iface',
    (section) => section.device === radioId && (section.mode ?? 'ap') === 'ap',
  );
  if (!apSections.length && (settings.ssid || settings.key || settings.encryption || settings.hidden !== undefined)) {
    throw new AppError(
      'NO_AP_INTERFACE',
      'This radio has no network for your devices to join. Set up a mode first.',
      { status: 409 },
    );
  }

  // Turning encryption on without a password anywhere leaves hostapd unable to start,
  // which would only surface as "the Wi-Fi did not come back".
  if (settings.encryption && settings.encryption !== 'none' && !settings.key) {
    const missingKey = apSections.some(({ section }) => !section.key);
    if (missingKey) {
      throw new AppError('INVALID_SETTINGS', 'Set a Wi-Fi password before turning security on.', { status: 400 });
    }
  }

  const snapshot = await snapshotConfigs(client, ['wireless']);
  const uci = new Uci(client);

  const staSections = findSections(
    wireless,
    'wifi-iface',
    (section) => section.device === radioId && section.mode === 'sta',
  );

  const radioValues = {};
  if (settings.enabled !== undefined) {
    // Only disable the hardware radio if we aren't using it for a repeater/hotspot uplink!
    if (!settings.enabled && staSections.some((s) => s.section.disabled !== '1')) {
      // Leave radioValues.disabled unset, so the radio stays on for the STA interface.
    } else {
      radioValues.disabled = settings.enabled ? '0' : '1';
    }
  }
  if (settings.channel !== undefined) radioValues.channel = settings.channel;
  if (settings.htmode) radioValues.htmode = settings.htmode;
  if (settings.txpower !== undefined) radioValues.txpower = String(settings.txpower);
  if (settings.country !== undefined) radioValues.country = settings.country;
  if (Object.keys(radioValues).length) await uci.set('wireless', radioId, radioValues);

  for (const ap of apSections) {
    const values = {};
    if (settings.ssid) values.ssid = settings.ssid;
    if (settings.encryption) values.encryption = settings.encryption;
    if (settings.key) values.key = settings.key;
    if (settings.hidden !== undefined) values.hidden = settings.hidden ? '1' : '0';
    if (settings.isolate !== undefined) values.isolate = settings.isolate ? '1' : '0';
    if (settings.enabled !== undefined) values.disabled = settings.enabled ? '0' : '1';
    if (Object.keys(values).length) await uci.set('wireless', ap.name, values);
    if (settings.encryption === 'none') await uci.clearOptions('wireless', ap.name, ['key']);
  }

  const wantsOn = settings.enabled !== false;
  await commitWithRollback({
    client,
    session,
    uci,
    snapshot,
    settleMs: 3000,
    // A channel or width the hardware refuses leaves the radio down: restore at once
    // rather than waiting for the timer.
    verify: async (live) => {
      const status = await live.tryCall('network.wireless', 'status', {}, null);
      const radio = status?.[radioId];
      if (!wantsOn || !radio || radio.up) return { ok: true };
      return {
        ok: false,
        reason: 'The Wi-Fi did not come back up with those settings, so the previous ones were restored.',
        details: radio.retry_setup_failed ? 'The router rejected the channel or width.' : undefined,
      };
    },
  });

  return { ok: true, radio: radioId };
}
