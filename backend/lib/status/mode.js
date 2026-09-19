import { detectMode, internetSourceLabel } from '../derive.js';
import { findStaUplink } from '../wireless.js';

/** EasyMode records the mode it applied in uci `easymode.state.mode` (written from phase 3 on). */
async function readStoredState(client) {
  const easymode = await client.uciGet('easymode');
  if (!easymode) return { mode: null, repeaterPaused: false };
  const state = Object.values(easymode).find(
    (section) => section['.type'] === 'state' || section['.name'] === 'state',
  );
  return {
    mode: state?.mode ?? null,
    repeaterPaused: state?.repeater_paused === '1',
  };
}

export async function getModeStatus(client, { network, radios }) {
  const stored = await readStoredState(client);
  const staUplink = findStaUplink(radios);

  const mode = detectMode({
    storedMode: stored.mode,
    staUplink,
    wanUp: network.wan.up && network.wan.kind === 'ethernet',
    wanDevice: network.wan.device,
    lanDhcpDisabled: network._raw.lanDhcpDisabled,
    lanHasGateway: network._raw.lanHasGateway,
  });

  return {
    ...mode,
    repeaterPaused: stored.repeaterPaused,
    internetSource: internetSourceLabel(mode.id, {
      staSsid: staUplink.ssid,
      wanProto: network.wan.proto,
      wanDevice: network.wan.device,
    }),
    uplink: staUplink.configured
      ? {
          kind: 'wireless',
          ssid: staUplink.ssid,
          band: staUplink.band,
          signal: staUplink.signal,
          quality: staUplink.quality,
          connected: staUplink.connected,
          disabled: staUplink.disabled,
          paused: stored.repeaterPaused,
        }
      : { kind: network.wan.kind, device: network.wan.device, connected: network.wan.up },
  };
}
