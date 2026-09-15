import { detectMode, internetSourceLabel } from '../derive.js';
import { findStaUplink } from '../wireless.js';

/** EasyMode records the mode it applied in uci `easymode.state.mode` (written from phase 3 on). */
async function readStoredMode(client) {
  const easymode = await client.uciGet('easymode');
  if (!easymode) return null;
  const state = Object.values(easymode).find(
    (section) => section['.type'] === 'state' || section['.name'] === 'state',
  );
  return state?.mode ?? null;
}

export async function getModeStatus(client, { network, radios }) {
  const storedMode = await readStoredMode(client);
  const staUplink = findStaUplink(radios);

  const mode = detectMode({
    storedMode,
    staUplink,
    wanUp: network.wan.up && network.wan.kind === 'ethernet',
    wanDevice: network.wan.device,
    lanDhcpDisabled: network._raw.lanDhcpDisabled,
    lanHasGateway: network._raw.lanHasGateway,
  });

  return {
    ...mode,
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
        }
      : { kind: network.wan.kind, device: network.wan.device, connected: network.wan.up },
  };
}
