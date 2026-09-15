import { restoreSnapshot } from './backup.js';
import { AppError } from './errors.js';
import { reconnect } from './modes/engine.js';
import { Uci } from './uci.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Commits staged UCI changes behind the rollback timer, waits for the router to come
 * back, optionally verifies the result, then confirms.
 *
 * Losing contact means no confirm is sent and the router restores itself - which is
 * the desired outcome for a change that would otherwise lock the user out.
 */
export async function commitWithRollback({
  client,
  session,
  uci,
  snapshot = null,
  verify = null,
  timeoutSeconds = 60,
  settleMs = 2500,
  // A change that moves the router's own address must be followed to the new one.
  candidates = null,
}) {
  const rollbackSupported = await Uci.supportsRollback(client);
  if (rollbackSupported) await uci.apply(timeoutSeconds);
  else await uci.commitAll();

  await sleep(settleMs);
  const hosts = [...new Set([...(candidates ?? []), session.host].filter(Boolean))];
  const connection = await reconnect(session, hosts, { attempts: 12, delayMs: 2500 });
  if (!connection) {
    throw new AppError(
      'ROUTER_UNREACHABLE_AFTER_CHANGE',
      'The router stopped answering after the change, so it is putting the previous settings back.',
      { status: 502 },
    );
  }

  if (verify) {
    const verdict = await verify(connection.client);
    if (!verdict.ok) {
      if (rollbackSupported) await new Uci(connection.client).rollback();
      if (snapshot) {
        const restore = await restoreSnapshot(connection.client, snapshot);
        await restore.commitAll();
      }
      throw new AppError('CHANGE_REJECTED', verdict.reason, { status: 409, details: verdict.details });
    }
  }

  if (rollbackSupported) await new Uci(connection.client).confirm();
  // The router may now answer somewhere else; keep the session pointed at it.
  if (connection.host !== session.host) session.host = connection.host;
  return connection.client;
}
