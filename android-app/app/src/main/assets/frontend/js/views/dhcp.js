import { api } from '../api.js';
import { confirmDialog, emptyState, errorState, openModal, skeletonCards, toast, toggle } from '../components.js';
import { icon } from '../icons.js';
import { badge, clear, dash, el, panel } from '../ui.js';

const field = (label, input, hint) =>
  el('div', { class: 'field' }, [
    el('label', { text: label }),
    input,
    hint ? el('span', { class: 'hint', text: hint }) : null,
  ]);

const expiryText = (lease) => {
  if (!lease.expiresAt) return 'No expiry';
  const minutes = Math.round((lease.expiresAt - Date.now()) / 60000);
  if (minutes <= 0) return 'Expired';
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h left` : `${Math.round(hours / 24)} days left`;
};

const deviceGlyph = (name = '') => {
  const n = String(name).toLowerCase();
  if (/phone|iphone|pixel|galaxy|mobile/.test(n)) return 'smartphone';
  if (/laptop|macbook|notebook|pc|desktop/.test(n)) return 'laptop';
  return 'devices';
};

/** Is this address handed out automatically, or does it sit outside the pool? */
const inPool = (ip, status) => {
  if (!ip || !status.rangeStart || !status.rangeEnd) return null;
  const toInt = (value) => value.split('.').reduce((total, part) => total * 256 + Number(part), 0);
  return toInt(ip) >= toInt(status.rangeStart) && toInt(ip) <= toInt(status.rangeEnd);
};

/* ============================================================
   Router address (the address of this page)
   ============================================================ */
function openLanEditor(lan, { onSaved, onUnauthorized }) {
  const inputs = {
    ip: el('input', { value: lan.ip ?? '' }),
    netmask: el('input', { value: lan.netmask ?? '255.255.255.0' }),
  };
  const errorSlot = el('div');
  const cancel = el('button', { class: 'btn btn-ghost' }, ['Cancel']);
  const save = el('button', { class: 'btn btn-primary' }, ['Change address']);

  const modal = openModal({
    title: 'Router address',
    subtitle: 'The address you type to open this page.',
    size: 'sm',
    body: [
      errorSlot,
      el('div', { class: 'alert alert-info' }, [
        icon('info', { size: 18 }),
        el('div', {}, [
          el('span', { text: 'Changing this moves the router, so this page will move with it.' }),
          el('span', { class: 'detail', text: 'Your devices pick up new addresses automatically, though some may need a reconnect.' }),
        ]),
      ]),
      field('Router address', inputs.ip, 'For example 192.168.1.1 or 192.168.8.1.'),
      el('details', { class: 'advanced' }, [
        el('summary', { text: 'Advanced settings' }),
        field('Network mask', inputs.netmask, 'Leave at 255.255.255.0 unless you know you need another size.'),
      ]),
    ],
    actions: [cancel, save],
  });

  cancel.addEventListener('click', modal.close);
  save.addEventListener('click', async () => {
    clear(errorSlot);
    const confirmed = await confirmDialog({
      title: `Move the router to ${inputs.ip.value.trim()}?`,
      message: 'Your network goes down for a few seconds while the router takes its new address.',
      detail: 'If the new address does not work, the router puts the old one back by itself.',
      confirmLabel: 'Change address',
      tone: 'danger',
    });
    if (!confirmed) return;

    save.disabled = true;
    save.textContent = 'Applying…';
    try {
      const result = await api.updateLan({ ip: inputs.ip.value, netmask: inputs.netmask.value });
      modal.close();
      if (result.changed) {
        toast('Router address changed', { tone: 'ok', detail: `Open it at ${result.loginUrl}`, duration: 9000 });
        // Reload so every page and the header pick up the new address.
        setTimeout(() => location.reload(), 1200);
      } else {
        toast('Nothing to change', { tone: 'info' });
      }
      onSaved();
    } catch (error) {
      if (error.status === 401) return onUnauthorized();
      errorSlot.append(errorState(error));
      save.disabled = false;
      save.textContent = 'Change address';
    }
  });
}

function lanPanel(lan, handlers) {
  if (!lan) return null;

  const edit = el('button', { class: 'btn btn-ghost btn-small', onclick: () => openLanEditor(lan, handlers) }, [
    icon('pencil', { size: 15 }),
    el('span', { text: 'Change' }),
  ]);

  return panel(
    {
      icon: icon('router', { size: 19 }),
      title: 'Router address',
      trailing: lan.managedElsewhere ? badge('Set by main router', 'accent', { dot: false }) : edit,
    },
    [
      el('div', { class: 'stat-row' }, [
        el('div', { class: 'stat' }, [
          el('span', { class: 'label', text: 'This page opens at' }),
          el('div', { class: 'value', style: 'font-size:20px', text: lan.ip ?? dash }),
        ]),
        el('div', { class: 'stat' }, [
          el('span', { class: 'label', text: 'Network size' }),
          el('div', { class: 'value', style: 'font-size:20px', text: lan.prefix ? `/${lan.prefix}` : dash }),
        ]),
      ]),
      lan.managedElsewhere
        ? el('p', { class: 'empty', style: 'margin-top:12px', text: 'This router is an access point, so its address belongs to your main router’s network. Change the setup in Mode setup to manage it here.' })
        : el('p', { class: 'empty', style: 'margin-top:12px', text: 'Bookmark this address — it is how you reach the router and this page.' }),
    ],
  );
}

/* ============================================================
   Server settings
   ============================================================ */
function serverPanel(status, { onSaved, onUnauthorized }) {
  const locked = status.managedElsewhere;

  const enabled = toggle({
    checked: status.enabled,
    disabled: locked,
    label: 'DHCP server',
    hint: locked ? 'Your main router is handing out addresses.' : 'Gives your devices an address automatically.',
  });

  const ipv6Enabled = toggle({
    checked: status.ipv6Enabled,
    disabled: locked,
    label: 'IPv6 support',
    hint: locked ? 'Managed by main router.' : 'Assigns IPv6 addresses and routing to devices.',
  });

  const inputs = {
    start: el('input', { type: 'number', min: 2, max: 254, value: status.start, disabled: locked || false }),
    limit: el('input', { type: 'number', min: 1, max: 253, value: status.limit, disabled: locked || false }),
    leasetime: el('input', { value: status.leasetime, disabled: locked || false }),
    dns: el('input', { value: status.dns.join(', '), placeholder: 'Router handles this', disabled: locked || false }),
  };

  const errorSlot = el('div');
  const save = el('button', { class: 'btn btn-primary', disabled: locked || false }, ['Save changes']);

  save.addEventListener('click', async () => {
    console.log('DHCP_TOGGLE_V2_LOADED');
    clear(errorSlot);
    save.disabled = true;
    save.textContent = 'Saving...';
    try {
      await api.updateDhcp({
        enabled: enabled.input.checked,
        ipv6: false, // Hardcoded to false for pure IPv4 operation
        start: Number(inputs.start.value),
        limit: Number(inputs.limit.value),
        leasetime: inputs.leasetime.value,
        dns: inputs.dns.value,
      });
      toast('Address settings saved', { tone: 'ok' });
      onSaved();
    } catch (error) {
      if (error.status === 401) return onUnauthorized();
      errorSlot.append(errorState(error));
      save.disabled = false;
      save.textContent = 'Save changes';
    }
  });

  return panel(
    {
      icon: icon('network', { size: 19 }),
      title: 'DHCP server',
      trailing: locked
        ? badge('Managed by main router', 'accent', { dot: false })
        : badge(status.enabled ? 'Active' : 'Off', status.enabled ? 'ok' : 'neutral'),
    },
    [
      locked
        ? el('div', { class: 'alert alert-info' }, [
            icon('info', { size: 18 }),
            el('div', {}, [
              el('span', { text: 'This router is set up as an access point, so your main router hands out addresses.' }),
              el('span', { class: 'detail', text: 'Two routers doing this on one network causes address clashes, so these controls are locked.' }),
            ]),
          ])
        : null,
      enabled,
      // IPv6 removed for pure IPv4 mode
      el('div', { style: 'height:18px' }),
      el('div', { class: 'stat-row' }, [
        el('div', { class: 'stat' }, [
          el('span', { class: 'label', text: 'Router address' }),
          el('div', { class: 'value', style: 'font-size:18px', text: status.routerIp ?? dash }),
        ]),
        el('div', { class: 'stat' }, [
          el('span', { class: 'label', text: 'Address range' }),
          el('div', { class: 'value', style: 'font-size:16px', text: status.rangeStart ? `${status.rangeStart} – ${status.rangeEnd}` : dash }),
        ]),
        el('div', { class: 'stat' }, [
          el('span', { class: 'label', text: 'Lease time' }),
          el('div', { class: 'value', style: 'font-size:18px', text: status.leasetime ?? dash }),
        ]),
      ]),
      el('details', { class: 'advanced' }, [
        el('summary', { text: 'Advanced settings' }),
        field('First address number', inputs.start, `Range starts at ${status.rangeStart ?? dash}.`),
        field('How many addresses', inputs.limit, `Range ends at ${status.rangeEnd ?? dash}.`),
        field('Lease time', inputs.leasetime, 'For example 12h or 30m.'),
        field('DNS servers for your devices', inputs.dns, 'Leave empty to let the router answer.'),
      ]),
      errorSlot,
      el('div', { class: 'button-row', style: 'margin-top:14px' }, [save]),
    ],
  );
}

/* ============================================================
   Reservations
   ============================================================ */
function openReserveModal(status, prefill, { onSaved, onUnauthorized }) {
  const inputs = {
    name: el('input', { value: prefill?.hostname ?? '', placeholder: 'Living room TV' }),
    mac: el('input', { value: prefill?.mac ?? '', placeholder: 'aa:bb:cc:dd:ee:ff' }),
    ip: el('input', { value: prefill?.ip ?? '', placeholder: status.rangeStart ?? '' }),
  };
  const errorSlot = el('div');
  const cancel = el('button', { class: 'btn btn-ghost' }, ['Cancel']);
  const save = el('button', { class: 'btn btn-primary' }, ['Reserve address']);

  const modal = openModal({
    title: 'Reserve an IP address',
    subtitle: 'The device always gets the same address, so it never changes.',
    size: 'sm',
    body: [errorSlot, field('Device name', inputs.name), field('Device address (MAC)', inputs.mac), field('IP address to reserve', inputs.ip)],
    actions: [cancel, save],
  });

  cancel.addEventListener('click', modal.close);
  save.addEventListener('click', async () => {
    clear(errorSlot);
    save.disabled = true;
    try {
      await api.addReservation({ name: inputs.name.value, mac: inputs.mac.value, ip: inputs.ip.value });
      modal.close();
      toast('Address reserved', { tone: 'ok' });
      onSaved();
    } catch (error) {
      if (error.status === 401) return onUnauthorized();
      errorSlot.append(errorState(error));
      save.disabled = false;
    }
  });
}

function reservationsPanel(status, handlers) {
  const add = el('button', { class: 'btn btn-ghost btn-small', onclick: () => openReserveModal(status, null, handlers) }, [
    icon('plus', { size: 15 }),
    el('span', { text: 'Reserve an IP' }),
  ]);

  const remove = async (entry) => {
    const confirmed = await confirmDialog({
      title: 'Remove this reservation?',
      message: `${entry.name ?? 'This device'} will get an ordinary address next time it connects.`,
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      await api.deleteReservation(entry.section);
      toast('Reservation removed', { tone: 'ok' });
      handlers.onSaved();
    } catch (error) {
      if (error.status === 401) return handlers.onUnauthorized();
      toast('Could not remove the reservation', { tone: 'bad', detail: error.message });
    }
  };

  return panel({ icon: icon('lock', { size: 19 }), title: 'Reserved addresses', trailing: add }, [
    el('p', { class: 'empty', style: 'margin-bottom:12px' }, [
      el('span', { text: `A reserved address may sit outside the automatic range (${status.rangeStart ?? '—'} – ${status.rangeEnd ?? '—'}). That is normal: the router keeps it for that one device.` }),
    ]),
    status.reservations.length
      ? el('div', { class: 'table-wrap' }, [
          el('table', { class: 'data-table' }, [
            el('thead', {}, [el('tr', {}, [el('th', { text: 'Device' }), el('th', { text: 'IP address' }), el('th', {})])]),
            el(
              'tbody',
              {},
              status.reservations.map((entry) =>
                el('tr', {}, [
                  el('td', {}, [
                    el('strong', { text: entry.name ?? 'Unnamed device' }),
                    el('span', { class: 'mac', text: entry.mac ?? '' }),
                  ]),
                  el('td', {}, [
                    el('span', { class: 'mono', text: entry.ip ?? dash }),
                    inPool(entry.ip, status) === false
                      ? el('span', { class: 'sub-note', text: 'Outside the automatic range' })
                      : null,
                  ]),
                  el('td', { style: 'text-align:right' }, [
                    el('button', { class: 'btn btn-quiet btn-small', onclick: () => remove(entry) }, [
                      icon('trash', { size: 15 }),
                    ]),
                  ]),
                ]),
              ),
            ),
          ]),
        ])
      : emptyState({
          glyph: 'lock',
          title: 'No reserved addresses',
          message: 'Reserve one when a device should always get the same IP address, like a printer or a server.',
        }),
  ]);
}

/* ============================================================
   Blocking a device
   ============================================================ */
function blockButton(status, lease, handlers) {
  if (!lease.mac) return null;

  if (lease.blocked) {
    const unblock = el('button', { class: 'btn btn-quiet btn-small' }, [
      icon('check', { size: 15 }),
      el('span', { text: 'Unblock' }),
    ]);
    unblock.addEventListener('click', async () => {
      unblock.disabled = true;
      try {
        await api.unblockClient(lease.mac);
        toast(`${lease.hostname ?? 'Device'} can use the internet again`, { tone: 'ok' });
        handlers.onSaved();
      } catch (error) {
        if (error.status === 401) return handlers.onUnauthorized();
        toast('Could not unblock the device', { tone: 'bad', detail: error.message });
        unblock.disabled = false;
      }
    });
    return unblock;
  }

  if (!status.blocking?.available) {
    return el('button', { class: 'btn btn-quiet btn-small', disabled: true, title: status.blocking?.reason ?? '', text: 'Block' });
  }

  const block = el('button', { class: 'btn btn-quiet btn-small danger-text' }, [
    icon('xCircle', { size: 15 }),
    el('span', { text: 'Block' }),
  ]);
  block.addEventListener('click', async () => {
    const name = lease.hostname ?? lease.ip ?? 'This device';
    const confirmed = await confirmDialog({
      title: `Block ${name}?`,
      message: 'The device stays on your network but cannot reach the internet through this router.',
      detail: 'You can unblock it again at any time.',
      confirmLabel: 'Block device',
      tone: 'danger',
    });
    if (!confirmed) return;

    block.disabled = true;
    try {
      await api.blockClient({ mac: lease.mac, name: lease.hostname });
      toast(`${name} is blocked from the internet`, { tone: 'ok' });
      handlers.onSaved();
    } catch (error) {
      if (error.status === 401) return handlers.onUnauthorized();
      toast('Could not block the device', { tone: 'bad', detail: error.message });
      block.disabled = false;
    }
  });
  return block;
}

function blockedPanel(status, handlers) {
  if (!status.blocked?.length) return null;

  return panel(
    {
      icon: icon('xCircle', { size: 19 }),
      title: 'Blocked devices',
      trailing: badge(`${status.blocked.length} blocked`, 'bad', { dot: false }),
    },
    [
      el('p', { class: 'empty', style: 'margin-bottom:12px', text: 'These devices stay on your network but cannot reach the internet through this router.' }),
      el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el(
            'tbody',
            {},
            status.blocked.map((entry) =>
              el('tr', {}, [
                el('td', {}, [
                  el('strong', { text: entry.label ?? 'Unnamed device' }),
                  el('span', { class: 'mac', text: entry.mac ?? '' }),
                ]),
                el('td', { style: 'text-align:right' }, [
                  blockButton(status, { mac: entry.mac, hostname: entry.label, blocked: true }, handlers),
                ]),
              ]),
            ),
          ),
        ]),
      ]),
    ],
  );
}

/* ============================================================
   Leases
   ============================================================ */
function leasesPanel(status, handlers) {
  if (!status.leasesAvailable) {
    return panel({ icon: icon('devices', { size: 19 }), title: 'Connected devices' }, [
      el('p', { class: 'empty', text: 'This router does not let EasyMode read the list of connected devices. Installing rpcd-mod-file enables it.' }),
    ]);
  }
  if (!status.leases.length) {
    return panel({ icon: icon('devices', { size: 19 }), title: 'Connected devices' }, [
      emptyState({ glyph: 'devices', title: 'No devices yet', message: 'Devices appear here once they connect and receive an address.' }),
    ]);
  }

  return panel(
    {
      icon: icon('devices', { size: 19 }),
      title: 'Connected devices',
      trailing: badge(`${status.leases.length} connected`, 'neutral', { dot: false }),
    },
    [
      el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [
            el('tr', {}, [el('th', { text: 'Device' }), el('th', { text: 'IP address' }), el('th', { text: 'Lease' }), el('th', {})]),
          ]),
          el(
            'tbody',
            {},
            status.leases.map((lease) =>
              el('tr', {}, [
                el('td', {}, [
                  el('div', { style: 'display:flex;align-items:center;gap:10px' }, [
                    icon(deviceGlyph(lease.hostname), { size: 17 }),
                    el('div', {}, [
                      el('strong', { text: lease.hostname ?? 'Unnamed device' }),
                      el('span', { class: 'mac', text: lease.mac ?? '' }),
                    ]),
                  ]),
                ]),
                el('td', {}, [
                  el('span', { class: 'mono', text: lease.ip }),
                  lease.reserved && inPool(lease.ip, status) === false
                    ? el('span', { class: 'sub-note', text: 'Fixed address, outside the automatic range' })
                    : null,
                ]),
                el('td', { text: lease.blocked ? 'Blocked' : expiryText(lease) }),
                el('td', { style: 'text-align:right' }, [
                  el('div', { class: 'row-actions' }, [
                    lease.reserved
                      ? badge('Reserved', 'ok', { dot: false })
                      : el('button', {
                          class: 'btn btn-quiet btn-small',
                          onclick: () => openReserveModal(status, lease, handlers),
                          text: 'Reserve',
                        }),
                    blockButton(status, lease, handlers),
                  ]),
                ]),
              ]),
            ),
          ),
        ]),
      ]),
    ],
  );
}

/* ============================================================
   Page
   ============================================================ */
export function renderDhcp(container, { onUnauthorized }) {
  const head = el('div', { class: 'page-head' }, [
    el('div', {}, [
      el('h1', { text: 'DHCP & IP addresses' }),
      el('p', { text: 'Which addresses this router gives your devices, and which devices always get the same one.' }),
    ]),
  ]);
  const body = el('div', {}, [skeletonCards(2, 5)]);
  container.append(head, body);

  const load = async () => {
    try {
      const [status, lan] = await Promise.all([api.dhcp(), api.lan().catch(() => null)]);
      const handlers = { onSaved: load, onUnauthorized };
      clear(body).append(
        el('div', { class: 'grid halves' }, [lanPanel(lan, handlers), serverPanel(status, handlers)].filter(Boolean)),
        el('div', { style: 'height:16px' }),
        el('div', { class: 'grid halves' }, [reservationsPanel(status, handlers)]),
        el('div', { style: 'height:16px' }),
        leasesPanel(status, handlers),
        ...(status.blocked?.length ? [el('div', { style: 'height:16px' }), blockedPanel(status, handlers)] : []),
      );
    } catch (error) {
      if (error.status === 401) return onUnauthorized();
      clear(body).append(errorState(error, load));
    }
  };

  load();
  return () => {};
}
