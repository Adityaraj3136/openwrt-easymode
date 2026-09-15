import { listRadios } from '../wireless.js';
import { checkInternet } from './connectivity.js';
import { getModeStatus } from './mode.js';
import { getNetworkStatus } from './network.js';
import { getSystemStatus } from './system.js';

/** One aggregated payload so the dashboard is a single request. */
export async function getDashboard(client, session) {
  const [system, network] = await Promise.all([
    getSystemStatus(client, session),
    getNetworkStatus(client, session),
  ]);

  const radios = session.capabilities?.features?.wirelessControl ? await listRadios(client) : [];
  const [internet, mode] = await Promise.all([
    checkInternet(client, network),
    getModeStatus(client, { network, radios }),
  ]);

  delete network._raw;

  return {
    fetchedAt: new Date().toISOString(),
    router: {
      host: session.host,
      username: session.username,
      luciUrl: `${session.scheme}://${session.host}/cgi-bin/luci`,
    },
    system,
    network,
    internet,
    wifi: {
      supported: radios.length > 0,
      radios: radios.map((radio) => ({
        id: radio.id,
        band: radio.band,
        label: radio.label,
        enabled: radio.enabled,
        ssid: radio.ssid,
        channel: radio.channel,
        clients: radio.clients,
        interfaces: radio.interfaces,
      })),
    },
    mode,
  };
}
