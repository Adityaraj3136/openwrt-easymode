/**
 * UCI writer on top of ubus.
 *
 * Changes are staged per rpcd session, then applied with OpenWrt's own rollback
 * timer: `uci apply {rollback:true, timeout:N}` reverts everything automatically if
 * nobody calls `uci confirm` in time. That is the real protection against locking
 * yourself out, so every mode change goes through it.
 */
export class Uci {
  constructor(client) {
    this.client = client;
    this.touched = new Set();
  }

  async get(config, section, option) {
    const args = { config };
    if (section) args.section = section;
    if (option) args.option = option;
    const result = await this.client.tryCall('uci', 'get', args, null);
    if (!result) return null;
    return option ? result.value : result.values ?? null;
  }

  async set(config, section, values) {
    this.touched.add(config);
    await this.client.call('uci', 'set', { config, section, values });
  }

  /**
   * Adds a section and returns its name.
   *
   * `name` is a top-level ubus argument, not an option: passing it inside `values`
   * creates an anonymous section carrying a stray `option name` instead of the named
   * section the caller wanted.
   */
  async add(config, type, values = {}, name = null) {
    this.touched.add(config);
    const args = { config, type, values };
    if (name) args.name = name;
    const result = await this.client.call('uci', 'add', args);
    return result.section ?? name;
  }

  /**
   * Create-or-update a named section. `uci set` on a section that does not exist yet
   * fails unless the type comes with it, which is why this is not just set().
   */
  async ensure(config, section, type, values = {}) {
    this.touched.add(config);
    const existing = await this.get(config, section);
    if (existing) {
      if (Object.keys(values).length) await this.set(config, section, values);
      return false;
    }
    await this.add(config, type, values, section);
    return true;
  }

  async delete(config, section, options) {
    this.touched.add(config);
    const args = { config, section };
    if (Array.isArray(options)) args.options = options;
    else if (options) args.option = options;
    try {
      await this.client.call('uci', 'delete', args);
    } catch (err) {
      if (!err.isMissing) throw err;
    }
  }

  /** Clears options that must not survive a protocol change (e.g. PPPoE creds -> DHCP). */
  async clearOptions(config, section, options) {
    const current = await this.get(config, section);
    if (!current) return;
    const present = options.filter((option) => current[option] !== undefined);
    if (present.length) await this.delete(config, section, present);
  }

  async changes(config) {
    const result = await this.client.tryCall('uci', 'changes', config ? { config } : {}, null);
    return result?.changes ?? {};
  }

  async revert() {
    for (const config of this.touched) {
      await this.client.tryCall('uci', 'revert', { config });
    }
    this.touched.clear();
  }

  /**
   * Commits staged changes, reloads the affected services and arms the rollback
   * timer. Must be followed by confirm() or the router reverts on its own.
   */
  async apply(timeoutSeconds = 90) {
    await this.client.call('uci', 'apply', { rollback: true, timeout: timeoutSeconds });
  }

  async confirm() {
    await this.client.call('uci', 'confirm', {});
    this.touched.clear();
  }

  async rollback() {
    await this.client.tryCall('uci', 'rollback', {});
    this.touched.clear();
  }

  /** Does this rpcd build support apply/confirm/rollback at all? */
  static async supportsRollback(client) {
    const objects = await client.listObjects('uci');
    const methods = objects?.uci ?? {};
    return ['apply', 'confirm', 'rollback'].every((method) =>
      Object.prototype.hasOwnProperty.call(methods, method),
    );
  }

  /** Applies without the rollback timer. Only used when rpcd lacks apply/confirm. */
  async commitAll() {
    for (const config of this.touched) {
      await this.client.call('uci', 'commit', { config });
    }
    this.touched.clear();
    await this.client.tryCall('network', 'reload', {});
  }
}

/** Finds the first section of a given type, optionally matching a predicate. */
export function findSection(values, type, predicate = () => true) {
  if (!values) return null;
  for (const [name, section] of Object.entries(values)) {
    if (section['.type'] === type && predicate(section, name)) return { name, section };
  }
  return null;
}

export function findSections(values, type, predicate = () => true) {
  if (!values) return [];
  return Object.entries(values)
    .filter(([name, section]) => section['.type'] === type && predicate(section, name))
    .map(([name, section]) => ({ name, section }));
}

/** UCI lists arrive as arrays or single strings; normalize before comparing. */
export const asList = (value) =>
  value == null ? [] : Array.isArray(value) ? value.slice() : String(value).split(/\s+/).filter(Boolean);
