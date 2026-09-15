import { config } from '../../config.js';

/**
 * "WAN up" and "internet works" are different things, so this is measured separately.
 * Ping is the real test; without exec rights we say so instead of guessing silently.
 */
export async function checkInternet(client, network) {
  const probeHost = config.internetProbeHost;

  const result = await client.tryCall(
    'file',
    'exec',
    { command: '/bin/ping', params: ['-c', '1', '-W', '2', probeHost] },
    null,
  );

  if (result && typeof result.code === 'number') {
    return {
      online: result.code === 0,
      method: 'ping',
      target: probeHost,
      detail: result.code === 0 ? null : 'No ping reply from the internet.',
    };
  }

  // In Access Point mode the route out lives on the LAN, not on a WAN interface.
  const gateway = network.wan?.gateway ?? network.lan?.gateway ?? null;
  const hasUplink = Boolean(gateway && (network.wan?.up || network.lan?.up));
  const hasDns = (network.wan?.dns ?? []).length > 0 || Boolean(network.lan?.gateway);
  return {
    online: hasUplink && hasDns ? null : false,
    method: 'heuristic',
    target: null,
    detail: hasUplink
      ? 'A gateway is set, but this router does not allow EasyMode to run a ping test.'
      : 'No default gateway, so the internet is not reachable.',
  };
}
