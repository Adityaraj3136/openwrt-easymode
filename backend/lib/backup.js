import { Uci } from './uci.js';

export const MODE_CONFIGS = ['network', 'wireless', 'dhcp', 'firewall'];

const META_KEYS = new Set(['.name', '.type', '.anonymous', '.index']);

const optionsOf = (section) =>
  Object.fromEntries(Object.entries(section).filter(([key]) => !META_KEYS.has(key)));

/**
 * Reads the configs a mode change touches. This is the restore point used when the
 * router stays reachable but the new configuration turns out not to work - the
 * uci rollback timer only covers the case where we lose contact entirely.
 */
export async function snapshotConfigs(client, configs = MODE_CONFIGS) {
  const snapshot = { takenAt: new Date().toISOString(), configs: {} };
  for (const config of configs) {
    snapshot.configs[config] = (await client.uciGet(config)) ?? {};
  }
  return snapshot;
}

/**
 * Writes a snapshot back section by section: restores known options, removes options
 * and sections that were added after the snapshot. Named sections only - anonymous
 * sections are matched by their generated name, which rpcd keeps stable.
 */
export async function restoreSnapshot(client, snapshot) {
  const uci = new Uci(client);

  for (const [config, sections] of Object.entries(snapshot.configs ?? {})) {
    const current = (await client.uciGet(config)) ?? {};

    for (const [name, section] of Object.entries(sections)) {
      const wanted = optionsOf(section);
      const existing = current[name];

      if (!existing) {
        await uci.ensure(config, name, section['.type'], wanted);
        continue;
      }

      const staleOptions = Object.keys(optionsOf(existing)).filter(
        (option) => wanted[option] === undefined,
      );
      if (staleOptions.length) await uci.delete(config, name, staleOptions);
      if (Object.keys(wanted).length) await uci.set(config, name, wanted);
    }

    for (const name of Object.keys(current)) {
      if (!sections[name]) await uci.delete(config, name);
    }
  }

  return uci;
}
