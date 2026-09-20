import { api } from '../api.js';
import { confirmDialog, errorState, openModal, skeleton, skeletonCards, toast, toggle } from '../components.js';
import { icon } from '../icons.js';
import { badge, clear, dash, el, panel, signalText, select } from '../ui.js';

const SECURITY = [
  { value: 'psk2', label: 'WPA2 (recommended)' },
  { value: 'sae-mixed', label: 'WPA2 + WPA3' },
  { value: 'none', label: 'Open — no password' },
];

const field = (label, input, hint) =>
  el('div', { class: 'field' }, [
    el('label', { text: label }),
    input,
    hint ? el('span', { class: 'hint', text: hint }) : null,
  ]);



/** Maps whatever the router reports to one of the choices we offer. */
function securityValue(encryption) {
  const value = String(encryption ?? 'psk2').toLowerCase();
  if (value === 'none' || value === '') return 'none';
  if (value.startsWith('sae')) return 'sae-mixed';
  return 'psk2';
}

/* ============================================================
   Edit drawer
   ============================================================ */
function openRadioEditor(radio, { onSaved, onUnauthorized }) {
  const caps = radio.capabilities;
  const ap = radio.interfaces.find((iface) => iface.mode === 'ap');
  const sta = radio.interfaces.find((iface) => iface.mode === 'sta');

  // Keep the mode the router actually runs for its width, so saving without touching
  // the width never switches the radio to another Wi-Fi generation.
  const currentHtmode = radio.htmode ?? null;
  const currentWidthMhz = currentHtmode ? Number(currentHtmode.match(/(\d+)$/)?.[1]) : null;
  const widths = (caps.widthOptions ?? []).map((entry) =>
    entry.width === currentWidthMhz && currentHtmode ? { ...entry, value: currentHtmode } : entry,
  );
  const currentWidth = widths.find((entry) => entry.value === currentHtmode) ?? widths.find((entry) => entry.width === currentWidthMhz);

  const enabled = toggle({ checked: radio.enabled, label: 'Wi-Fi on', hint: 'Turning this off hides the network completely.' });
  const hidden = toggle({ checked: Boolean(ap?.hidden), label: 'Hide network name', hint: 'Devices must type the name to join.' });

  // Show the current key from UCI if available; allow editing in place.
  const currentKey = ap?.key ?? '';
  const securitySelect = select(SECURITY, securityValue(ap?.encryption));

  // Show/hide the password field based on security selection.
  const keyInput = el('input', {
    type: 'text',
    value: currentKey,
    placeholder: 'Enter Wi-Fi password',
    style: securityValue(ap?.encryption) === 'none' ? 'display:none' : '',
  });
  const keyField = field('Password', keyInput, 'Minimum 8 characters for WPA2/WPA3.');
  if (securityValue(ap?.encryption) === 'none') keyField.style.display = 'none';

  securitySelect.addEventListener('change', () => {
    const isOpen = securitySelect.value === 'none';
    keyField.style.display = isOpen ? 'none' : '';
    keyInput.style.display = isOpen ? 'none' : '';
  });

  const inputs = {
    ssid: el('input', { value: ap?.ssid ?? '' }),
    key: keyInput,
    security: securitySelect,
    channel: caps.supports?.channel
      ? select(
          [{ value: 'auto', label: 'Automatic' }, ...caps.channels.map((entry) => ({ value: entry.channel, label: `Channel ${entry.channel}` }))],
          radio.channelConfig === 'auto' || !radio.channelConfig ? 'auto' : radio.channel ?? 'auto',
        )
      : null,
    htmode: widths.length
      ? select(widths.map((entry) => ({ value: entry.value, label: `${entry.label} · ${entry.standard}` })), currentWidth?.value ?? widths.at(-1).value)
      : null,
    txpower: caps.supports?.txpower
      ? el('input', { type: 'number', min: caps.txpower.min, max: caps.txpower.max, value: radio.txpower ?? caps.txpower.max })
      : null,
    country: el('input', { type: 'text', maxlength: 2, value: radio.country ?? '', placeholder: 'e.g. US, IN' }),
    isolate: toggle({ checked: Boolean(ap?.isolate), label: 'Isolate Clients', hint: 'Prevents devices on this network from talking to each other.' }),
  };

  const errorSlot = el('div');
  const save = el('button', { class: 'btn btn-primary' }, ['Save changes']);
  const cancel = el('button', { class: 'btn btn-ghost' }, ['Cancel']);

  const modal = openModal({
    title: `${radio.label.replace(' Wi-Fi', '')} Wi-Fi`,
    subtitle: 'Changes apply straight away and reconnect your devices.',
    size: 'md',
    body: [
      errorSlot,
      enabled,
      el('div', { style: 'height:16px' }),
      field('Network name', inputs.ssid),
      keyField,
      field('Security', inputs.security),
      sta?.ssid
        ? el('div', { class: 'alert alert-info' }, [
            icon('info', { size: 18 }),
            el('div', {}, [
              el('span', { text: `This radio also carries the internet connection to "${sta.ssid}". Change that in Mode setup.` }),
            ]),
          ])
        : null,
      el('details', { class: 'advanced' }, [
        el('summary', { text: 'Advanced settings' }),
        (() => {
          if (!inputs.channel) return null;
          const dfsWarning = el('div', { class: 'alert alert-warn', style: 'margin-top: 8px; display: none;' }, [
            icon('alert', { size: 18 }),
            el('div', {}, [
              el('span', { text: 'DFS Channel Selected' }),
              el('span', { class: 'detail', text: 'If weather or airport radar is detected nearby, the 5GHz network will temporarily drop to change channels.' })
            ])
          ]);
          inputs.channel.addEventListener('change', () => {
            const ch = parseInt(inputs.channel.value, 10);
            dfsWarning.style.display = (ch >= 52 && ch <= 144) ? 'flex' : 'none';
          });
          // Trigger initial state
          setTimeout(() => inputs.channel.dispatchEvent(new Event('change')), 0);

          return el('div', { class: 'field' }, [
            el('label', { text: 'Channel' }),
            inputs.channel,
            el('span', { class: 'hint', text: 'Devices reconnect when the channel changes.' }),
            dfsWarning
          ]);
        })(),
        inputs.htmode ? field('Channel width', inputs.htmode) : null,
        inputs.txpower ? field('Transmit power (dBm)', inputs.txpower) : null,
        inputs.country ? field('Country Code', inputs.country, 'ISO country code (e.g., US, IN) for regulatory limits.') : null,
        hidden,
        inputs.isolate,
      ]),
    ],
    actions: [cancel, save],
  });

  cancel.addEventListener('click', modal.close);

  save.addEventListener('click', async () => {
    clear(errorSlot);
    if (radio.enabled && !enabled.input.checked) {
      const confirmed = await confirmDialog({
        title: 'Turn this Wi-Fi off?',
        message: 'Devices using this network will be disconnected until you turn it back on.',
        confirmLabel: 'Turn off',
        tone: 'danger',
      });
      if (!confirmed) return;
    }

    save.disabled = true;
    save.textContent = 'Applying…';
    try {
      const payload = {
        enabled: enabled.input.checked,
        ssid: inputs.ssid.value,
        encryption: inputs.security.value,
        hidden: hidden.input.checked,
      };
      // Always send key if field has a value (and encryption is not 'none').
      if (inputs.security.value !== 'none' && inputs.key.value) payload.key = inputs.key.value;
      if (inputs.channel) payload.channel = inputs.channel.value;
      if (inputs.htmode) payload.htmode = inputs.htmode.value;
      if (inputs.txpower) payload.txpower = Number(inputs.txpower.value);
      if (inputs.isolate) payload.isolate = inputs.isolate.input.checked;
      if (inputs.country && inputs.country.value.trim()) payload.country = inputs.country.value.trim();

      await api.updateRadio(radio.id, payload);
      modal.close();
      toast('Wi-Fi settings saved', { tone: 'ok' });
      onSaved();
    } catch (error) {
      if (error.status === 401) return onUnauthorized();
      errorSlot.append(errorState(error));
      save.disabled = false;
      save.textContent = 'Save changes';
    }
  });
}

/* ============================================================
   Summary card
   ============================================================ */
function radioSummary(radio, handlers) {
  const ap = radio.interfaces.find((iface) => iface.mode === 'ap');
  const edit = el('button', { class: 'btn btn-ghost btn-small', onclick: () => openRadioEditor(radio, handlers) }, [
    icon('pencil', { size: 15 }),
    el('span', { text: 'Edit' }),
  ]);

  return el('section', { class: 'card radio-summary' }, [
    el('div', { class: 'radio-summary-head' }, [
      el('div', { class: 'card-icon' }, [icon('wifi', { size: 20 })]),
      el('div', {}, [
        el('h3', { text: radio.label.replace(' Wi-Fi', ' Wi-Fi') }),
        el('div', { class: 'sub', text: radio.enabled ? ap?.ssid ?? 'No network name' : 'Currently switched off' }),
      ]),
      el('span', { style: 'flex:1' }),
      badge(radio.enabled ? 'On' : 'Off', radio.enabled ? 'ok' : 'neutral'),
    ]),
    el('div', { class: 'radio-facts' }, [
      el('div', { class: 'radio-fact' }, [
        el('span', { text: 'Network name' }),
        el('strong', { text: ap?.ssid ?? dash }),
      ]),
      el('div', { class: 'radio-fact' }, [
        el('span', { text: 'Channel' }),
        el('strong', { text: radio.enabled ? String(radio.channel ?? 'Auto') : dash }),
      ]),
      el('div', { class: 'radio-fact' }, [
        el('span', { text: 'Devices' }),
        el('strong', { text: radio.clients == null ? dash : String(radio.clients) }),
      ]),
    ]),
    el('div', { class: 'button-row' }, [
      edit,
      radio.capabilities?.supports?.channel
        ? el('button', { class: 'btn btn-ghost btn-small', onclick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            btn.innerHTML = `<span class="spinner" style="width:14px;height:14px;border-width:2px;margin-right:6px;display:inline-block"></span> Scanning & optimizing...`;
            try {
              const result = await api.optimizeRadio(radio.id);
              const chLabel = result.channel ? `to channel ${result.channel}` : '';
              toast(`${radio.label.replace(' Wi-Fi', '')} optimized ${chLabel}`, { tone: 'ok' });
              handlers.onSaved();
            } catch (error) {
              if (error.status === 401) return handlers.onUnauthorized();
              toast(`Failed to optimize: ${error.message}`, { tone: 'bad' });
              btn.disabled = false;
              btn.innerHTML = '';
              btn.append(icon('zap', { size: 15 }), el('span', { text: ' Optimize' }));
            }
          } }, [
            icon('zap', { size: 15 }),
            el('span', { text: ' Optimize' }),
          ])
        : null
    ].filter(Boolean)),
  ]);
}

/* ============================================================
   Nearby networks — manual scan only
   ============================================================ */
function scanPanel(radios, onUnauthorized) {
  // Start in idle state — do NOT auto-scan.
  const idle = el('p', { class: 'empty', style: 'margin:12px 0', text: 'Click Refresh to search for networks near you.' });
  const body = el('div', {}, [idle]);

  const radioSelect =
    radios.length > 1
      ? select(radios.map((radio) => ({ value: radio.id, label: radio.label })), radios[0].id, {
          onchange: (event) => load(event.target.value),
        })
      : null;
  const refresh = el('button', { class: 'btn btn-ghost btn-small' }, [
    icon('refresh', { size: 15 }),
    el('span', { text: 'Refresh' }),
  ]);

  async function load(radioId) {
    clear(body).append(skeleton({ rows: 4 }));
    refresh.disabled = true;
    try {
      const result = await api.scanWifi(radioId);
      const busiest = new Map(result.congestion.map((entry) => [entry.channel, entry]));
      clear(body).append(
        el('div', { class: 'congestion' }, result.congestion.map((entry) =>
          el('div', { class: `congestion-item ${entry.level}` }, [
            el('strong', { text: `Ch ${entry.channel}` }),
            el('span', { text: `${entry.count} network${entry.count === 1 ? '' : 's'}` }),
          ]),
        )),
        el('div', { class: 'scan-list', style: 'margin-top:14px' }, result.networks.length
          ? result.networks.map((network) =>
              el('div', { class: 'scan-row' }, [
                el('div', { class: 'scan-main' }, [
                  el('strong', { text: network.ssid ?? 'Hidden network' }),
                  el('span', {
                    text: `${network.band ? `${network.band} GHz` : ''} · channel ${network.channel ?? '?'} · ${network.encryptionLabel}${
                      busiest.get(network.channel)?.level === 'crowded' ? ' · busy channel' : ''
                    }`,
                  }),
                ]),
                el('span', { class: 'scan-signal', text: signalText(network.signal) ?? dash }),
              ]),
            )
          : [el('p', { class: 'empty', text: 'No other networks found nearby.' })]),
      );
    } catch (error) {
      if (error.status === 401) return onUnauthorized();
      clear(body).append(errorState(error, () => load(radioId)));
    } finally {
      refresh.disabled = false;
    }
  }

  // Manual scan only — triggered by button click, not on page load.
  refresh.addEventListener('click', () => load(radioSelect?.value ?? radios[0].id));

  return panel(
    { icon: icon('signal', { size: 19 }), title: 'Networks near you', trailing: [radioSelect, refresh].filter(Boolean), className: 'scan-card' },
    [
      el('p', { class: 'empty', style: 'margin-bottom:12px', text: 'Fewer networks on your channel usually means a faster, steadier connection.' }),
      body,
    ],
  );
}

/* ============================================================
   Guest Wi-Fi card
   ============================================================ */
function openGuestEditor(guestStatus, { onSaved, onUnauthorized }) {
  const enabled = toggle({ checked: guestStatus.enabled, label: 'Guest Network', hint: 'An isolated network for guests.' });

  const securitySelect = select(SECURITY, securityValue(guestStatus.encryption));
  const keyInput = el('input', { type: 'text', value: guestStatus.key ?? '', placeholder: 'Enter password' });
  const keyField = field('Password', keyInput, 'Minimum 8 characters.');

  if (securityValue(guestStatus.encryption) === 'none') {
    keyField.style.display = 'none';
  }

  securitySelect.addEventListener('change', () => {
    const isOpen = securitySelect.value === 'none';
    keyField.style.display = isOpen ? 'none' : '';
  });

  const inputs = {
    ssid: el('input', { value: guestStatus.ssid ?? 'Guest Network' }),
    security: securitySelect,
    key: keyInput,
    ipaddr: el('input', { type: 'text', value: guestStatus.ipaddr ?? '192.168.22.1' }),
    isolate: toggle({ checked: guestStatus.isolate !== false, label: 'Client isolation', hint: 'Prevent guests from seeing each other.' }),
    hidden: toggle({ checked: guestStatus.hidden === true, label: 'Hide network name', hint: 'Guests must type the name manually to join.' }),
  };

  const errorSlot = el('div');
  const save = el('button', { class: 'btn btn-primary' }, ['Save changes']);
  const cancel = el('button', { class: 'btn btn-ghost' }, ['Cancel']);

  const modal = openModal({
    title: 'Guest Wi-Fi',
    subtitle: 'A separate, isolated network for visitors to use.',
    size: 'md',
    body: [
      errorSlot,
      enabled,
      el('div', { style: 'height:16px' }),
      field('Network name', inputs.ssid),
      keyField,
      field('Security', inputs.security),
      el('details', { class: 'advanced', style: 'margin-top:20px; padding-top:12px; border-top:1px solid var(--line);' }, [
        el('summary', { text: 'Advanced settings' }),
        el('div', { style: 'height:16px' }),
        field('Router IP address for guests', inputs.ipaddr, 'Example: 192.168.22.1'),
        inputs.isolate,
        el('div', { style: 'height:12px' }),
        inputs.hidden,
      ]),
    ],
    actions: [cancel, save],
  });

  cancel.addEventListener('click', modal.close);

  save.addEventListener('click', async () => {
    clear(errorSlot);
    save.disabled = true;
    save.textContent = 'Saving…';
    try {
      const payload = {
        enabled: enabled.input.checked,
        ssid: inputs.ssid.value,
        encryption: inputs.security.value,
        ipaddr: inputs.ipaddr.value,
        isolate: inputs.isolate.input.checked,
        hidden: inputs.hidden.input.checked,
      };
      if (inputs.security.value !== 'none') {
        payload.key = inputs.key.value;
      }
      await api.updateGuestWifi(payload);
      modal.close();
      toast('Guest Wi-Fi settings saved', { tone: 'ok' });
      onSaved();
    } catch (error) {
      if (error.status === 401) return onUnauthorized();
      errorSlot.append(errorState(error));
      save.disabled = false;
      save.textContent = 'Save changes';
    }
  });
}

function guestSummary(guestStatus, handlers) {
  const edit = el('button', { class: 'btn btn-ghost btn-small', onclick: () => openGuestEditor(guestStatus, handlers) }, [
    icon('pencil', { size: 15 }),
    el('span', { text: 'Edit' }),
  ]);

  return el('section', { class: 'card radio-summary' }, [
    el('div', { class: 'radio-summary-head' }, [
      el('div', { class: 'card-icon' }, [icon('shield', { size: 20 })]),
      el('div', {}, [
        el('h3', { text: 'Guest Wi-Fi' }),
        el('div', { class: 'sub', text: guestStatus.enabled ? guestStatus.ssid ?? 'Guest Network' : 'Currently switched off' }),
      ]),
      el('span', { style: 'flex:1' }),
      badge(guestStatus.enabled ? 'On' : 'Off', guestStatus.enabled ? 'ok' : 'neutral'),
    ]),
    el('div', { class: 'radio-facts' }, [
      el('div', { class: 'radio-fact' }, [
        el('span', { text: 'Network name' }),
        el('strong', { text: guestStatus.enabled ? guestStatus.ssid ?? 'Guest Network' : dash }),
      ]),
      el('div', { class: 'radio-fact' }, [
        el('span', { text: 'Security' }),
        el('strong', { text: SECURITY.find(s => s.value === securityValue(guestStatus.encryption))?.label.split(' ')[0] ?? dash }),
      ]),
      el('div', { class: 'radio-fact' }, [
        el('span', { text: 'Isolation' }),
        el('strong', { text: guestStatus.enabled ? (guestStatus.isolate === false ? 'Off' : 'Active') : dash }),
      ]),
    ]),
    el('div', { class: 'button-row' }, [edit]),
  ]);
}

/* ============================================================
   Page
   ============================================================ */
export function renderWifi(container, { onUnauthorized }) {
  const head = el('div', { class: 'page-head' }, [
    el('div', {}, [
      el('h1', { text: 'Wi-Fi' }),
      el('p', { text: 'The networks this router broadcasts for your devices.' }),
    ]),
  ]);
  const body = el('div', {}, [skeletonCards(2, 4)]);
  container.append(head, body);

  const load = async () => {
    try {
      const [{ radios, supported }, guestStatus] = await Promise.all([
        api.wifi(),
        api.guestWifi().catch(() => ({ enabled: false }))
      ]);
      clear(body);
      if (!supported) {
        body.append(panel({ icon: icon('wifi', { size: 19 }), title: 'Wi-Fi' }, [
          el('p', { class: 'empty', text: 'This router reports no wireless radios.' }),
        ]));
        return;
      }

      body.append(
        el('div', { class: 'grid halves' }, [
          ...radios.map((radio) => radioSummary(radio, { onSaved: load, onUnauthorized })),
          guestSummary(guestStatus, { onSaved: load, onUnauthorized })
        ]),
        el('div', { style: 'height:16px' }),
        scanPanel(radios.map((radio) => ({ id: radio.id, label: radio.label })), onUnauthorized),
      );
    } catch (error) {
      if (error.status === 401) return onUnauthorized();
      clear(body).append(errorState(error, load));
    }
  };

  load();
  return () => {};
}
