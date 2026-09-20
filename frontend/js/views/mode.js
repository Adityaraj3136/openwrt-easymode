import { api } from '../api.js';
import { confirmDialog, emptyState, errorState, skeleton, toast, toggle } from '../components.js';
import { icon } from '../icons.js';
import { badge, clear, el, panel, signalText, select } from '../ui.js';
import { MODES, modeById, modeCard } from './mode-cards.js';

const STEPS = ['Connection', 'Home network', 'Wi-Fi', 'Review'];

// Intervals started inside wizard steps (e.g. the disconnect countdown) are tracked here
// so renderModeSetup's teardown can clear them when the user navigates away mid-countdown.
const activeTimers = new Set();
function trackInterval(fn, ms) {
  const id = setInterval(fn, ms);
  activeTimers.add(id);
  return id;
}
function clearTrackedInterval(id) {
  clearInterval(id);
  activeTimers.delete(id);
}

const field = (label, input, hint) =>
  el('div', { class: 'field' }, [
    el('label', { text: label }),
    input,
    hint ? el('span', { class: 'hint', text: hint }) : null,
  ]);

const advanced = (summaryText, children) =>
  el('details', { class: 'advanced' }, [el('summary', { text: summaryText }), ...[].concat(children).filter(Boolean)]);

/* ============================================================
   Stepper
   ============================================================ */
function stepper(activeIndex) {
  const nodes = [];
  STEPS.forEach((label, index) => {
    if (index) nodes.push(el('span', { class: `stepper-bar${index <= activeIndex ? ' done' : ''}` }));
    const state = index === activeIndex ? 'active' : index < activeIndex ? 'done' : '';
    nodes.push(
      el('div', { class: `stepper-step ${state}`.trim() }, [
        el('span', { class: 'stepper-dot' }, [
          index < activeIndex ? icon('check', { size: 14 }) : el('span', { text: String(index + 1) }),
        ]),
        el('span', { class: 'stepper-label', text: label }),
      ]),
    );
  });
  return el('div', { class: 'stepper' }, nodes);
}

function stepHero(glyph, title, description) {
  return el('div', { class: 'wizard-hero' }, [
    el('div', { class: 'card-icon' }, [icon(glyph, { size: 22 })]),
    el('div', {}, [el('h3', { text: title }), el('p', { text: description })]),
  ]);
}

const reviewRows = (rows) =>
  el(
    'div',
    { class: 'review-list' },
    rows
      .filter(([, value]) => value != null && value !== '')
      .map(([key, value]) =>
        el('div', { class: 'review-row' }, [el('span', { class: 'k', text: key }), el('span', { class: 'v', text: String(value) })]),
      ),
  );

/* ============================================================
   Wi-Fi picker (repeater + hotspot)
   ============================================================ */
const BARS = 4;
function signalBars(quality) {
  const filled = quality?.bars ?? 0;
  return el(
    'span',
    { class: 'bars', title: quality?.level ?? 'unknown' },
    Array.from({ length: BARS }, (_, index) => el('i', { class: index < filled ? 'on' : '', style: `height:${4 + index * 3}px` })),
  );
}

function networkPicker(state, overview, onPick) {
  const list = el('div', { class: 'scan-list' }, [skeleton({ rows: 4 })]);
  const rescan = el('button', { class: 'btn btn-ghost btn-small', type: 'button' }, [
    icon('refresh', { size: 15 }),
    el('span', { text: 'Scan again' }),
  ]);

  const draw = (networks) => {
    clear(list);
    if (!networks.length) {
      list.append(emptyState({ glyph: 'wifi', title: 'No networks found', message: 'Move the router closer and scan again.' }));
      return;
    }
    for (const network of networks) {
      list.append(
        el(
          'button',
          {
            type: 'button',
            class: `scan-row${state.ssid === network.ssid ? ' selected' : ''}`,
            onclick: () => {
              state.ssid = network.ssid;
              // Prefer the explicit mode string (psk2 / sae-mixed / ...); fall back to
              // network.encryption which the backend also returns as the mode.
              state.encryption = network.encryptionMode ?? network.encryption;
              state.needsPassword = network.needsPassword;
              draw(networks);
              onPick();
            },
          },
          [
            signalBars(network.quality),
            el('div', { class: 'scan-main' }, [
              el('strong', { text: network.ssid }),
              el('span', { text: `${network.band ? `${network.band} GHz` : 'Wi-Fi'} · ${network.encryptionLabel}` }),
            ]),
            el('span', { class: 'scan-signal', text: signalText(network.signal) ?? '' }),
          ],
        ),
      );
    }
  };

  const load = async () => {
    clear(list).append(skeleton({ rows: 4 }));
    rescan.disabled = true;
    try {
      const result = await api.scanWifi(state.radio);
      state.radio = result.radio;
      draw(result.joinable ?? result.networks);
    } catch (error) {
      clear(list).append(errorState(error, load));
    } finally {
      rescan.disabled = false;
    }
  };

  rescan.addEventListener('click', load);
  load();

  const radios = overview.wireless?.radios ?? [];
  const picker =
    radios.length > 1
      ? field(
          'Radio to connect with',
          select(
            radios.map((radio) => ({ value: radio.id, label: radio.label })),
            state.radio,
            {
              onchange: (event) => {
                state.radio = event.target.value;
                load();
              },
            }
          ),
        )
      : null;

  return el('div', {}, [picker, list, el('div', { style: 'margin-top:10px' }, [rescan])]);
}

/* ============================================================
   Per-mode wizard steps
   ============================================================ */
function routerSteps(state, overview) {
  const preflight = overview.preflight.router;

  const inputs = {
    pppoeUser: el('input', { autocomplete: 'off', value: state.pppoe?.username ?? '' }),
    pppoePass: el('input', { type: 'password', autocomplete: 'off' }),
    staticIp: el('input', { placeholder: '203.0.113.10', value: state.static?.ip ?? '' }),
    staticMask: el('input', { value: state.static?.netmask ?? '255.255.255.0' }),
    staticGw: el('input', { placeholder: '203.0.113.1', value: state.static?.gateway ?? '' }),
    staticDns: el('input', { placeholder: '1.1.1.1, 8.8.8.8', value: state.static?.dns ?? '' }),
    lanIp: el('input', { value: state.lanIp ?? overview.defaults.lanIp ?? '' }),
    lease: el('input', { value: state.leasetime ?? '12h' }),
    ssid: el('input', { value: state.wifiSsid ?? overview.defaults.wifiSsid ?? '' }),
    key: el('input', { type: 'password', value: state.wifiKey ?? overview.defaults.wifiKey ?? '', placeholder: 'At least 8 characters' }),
    macaddr: el('input', { placeholder: '00:11:22:33:44:55', value: state.macaddr ?? '' }),
  };

  const CONNECTIONS = [
    { id: 'auto', title: 'Automatic IP', hint: 'Most connections. The router asks your provider for its settings.' },
    { id: 'pppoe', title: 'ISP username and password', hint: 'Your provider gave you sign-in details.' },
    { id: 'static', title: 'Static IP', hint: 'You were given a fixed address to enter.' },
  ];

  return [
    {
      render() {
        const pppoeBox = el('div', { hidden: state.connection !== 'pppoe' }, [
          field('Provider username', inputs.pppoeUser),
          field('Provider password', inputs.pppoePass),
        ]);
        const staticBox = el('div', { hidden: state.connection !== 'static' }, [
          field('IP address', inputs.staticIp),
          field('Network mask', inputs.staticMask),
          field('Gateway', inputs.staticGw),
          field('DNS servers', inputs.staticDns, 'Optional. Separate with commas.'),
        ]);

        const choices = el(
          'div',
          { class: 'choice-grid' },
          CONNECTIONS.map((choice) =>
            el('label', { class: `choice${state.connection === choice.id ? ' selected' : ''}`, 'data-choice': choice.id }, [
              el('input', { type: 'radio', name: 'connection', value: choice.id, checked: state.connection === choice.id }),
              el('div', {}, [el('strong', { text: choice.title }), el('span', { text: choice.hint })]),
            ]),
          ),
        );
        choices.addEventListener('change', (event) => {
          state.connection = event.target.value;
          pppoeBox.hidden = state.connection !== 'pppoe';
          staticBox.hidden = state.connection !== 'static';
          for (const label of choices.querySelectorAll('.choice')) {
            label.classList.toggle('selected', label.dataset.choice === state.connection);
          }
        });

        return el('div', {}, [
          stepHero('cable', 'How does the internet reach this router?', 'Plug the cable from your modem or main router into the internet (WAN) port.'),
          preflight.ready
            ? el('div', { style: 'margin-bottom:16px' }, [badge('Cable detected in the internet port', 'ok')])
            : el('div', { class: 'alert alert-warn' }, [
                icon('alert', { size: 18 }),
                el('div', {}, [el('span', { text: preflight.reason ?? 'No cable detected in the internet port. You can still set up the router now and plug it in later.' })]),
              ]),
          choices,
          pppoeBox,
          staticBox,
          advanced('Advanced settings', [
            field('MAC address clone', inputs.macaddr, 'Optional. Use when your ISP locks your connection to a specific device.'),
          ]),
        ]);
      },
      commit() {
        // state.connection is updated by the change listener, but if it was never changed,
        // it might be undefined. Default it to 'auto' if so.
        if (!state.connection) state.connection = 'auto';
        state.pppoe = { username: inputs.pppoeUser.value, password: inputs.pppoePass.value };
        state.static = {
          ip: inputs.staticIp.value,
          netmask: inputs.staticMask.value,
          gateway: inputs.staticGw.value,
          dns: inputs.staticDns.value,
        };
        state.macaddr = inputs.macaddr.value.trim();
      },
    },
    {
      render() {
        return el('div', {}, [
          stepHero('network', 'Your home network', 'This is the address your devices use to reach the router.'),
          field('Router address', inputs.lanIp, 'Leave this as it is unless you know you need to change it.'),
          advanced('Advanced settings', [field('Address lease time', inputs.lease, 'How long a device keeps its address, for example 12h.')]),
        ]);
      },
      commit() {
        state.lanIp = inputs.lanIp.value.trim();
        state.leasetime = inputs.lease.value.trim() || '12h';
      },
    },
    wifiStep(state, inputs),
    {
      render() {
        const connectionLabel = { auto: 'Automatic IP', pppoe: 'ISP username and password', static: 'Static IP' }[state.connection];
        return el('div', {}, [
          stepHero('checkCircle', 'Review your setup', 'EasyMode will apply these settings and check that the connection works.'),
          reviewRows([
            ['Mode', 'Router'],
            ['Internet connection', connectionLabel],
            state.connection === 'pppoe' ? ['Provider username', state.pppoe.username] : null,
            state.connection === 'static' ? ['IP address', state.static.ip] : null,
            state.macaddr ? ['Cloned MAC address', state.macaddr] : null,
            ['Router address', state.lanIp || overview.defaults.lanIp],
            ['Wi-Fi', state.changeWifi ? state.wifiSsid : 'Left unchanged'],
          ].filter(Boolean)),
        ]);
      },
    },
  ];
}

function apSteps(state, overview) {
  const preflight = overview.preflight.ap;
  const inputs = {
    manualIp: el('input', { placeholder: '192.168.1.250' }),
    manualMask: el('input', { value: '255.255.255.0' }),
    manualGw: el('input', { placeholder: '192.168.1.1' }),
    ssid: el('input', { value: state.wifiSsid ?? overview.defaults.wifiSsid ?? '' }),
    key: el('input', { type: 'password', value: state.wifiKey ?? overview.defaults.wifiKey ?? '', placeholder: 'At least 8 characters' }),
  };

  const UPLINKS = [
    { id: 'wan', title: 'Into the internet (WAN) port', hint: 'The separate, usually differently coloured port.' },
    { id: 'lan', title: 'Into a numbered LAN port', hint: 'Any of the normal network ports.' },
  ];

  return [
    {
      render() {
        const choices = el(
          'div',
          { class: 'choice-grid' },
          UPLINKS.map((choice) =>
            el('label', { class: `choice${state.uplink === choice.id ? ' selected' : ''}`, 'data-choice': choice.id }, [
              el('input', { type: 'radio', name: 'uplink', value: choice.id, checked: state.uplink === choice.id }),
              el('div', {}, [el('strong', { text: choice.title }), el('span', { text: choice.hint })]),
            ]),
          ),
        );
        choices.addEventListener('change', (event) => {
          state.uplink = event.target.value;
          for (const label of choices.querySelectorAll('.choice')) {
            label.classList.toggle('selected', label.dataset.choice === state.uplink);
          }
        });

        return el('div', {}, [
          stepHero('cable', 'Connect the cable', 'Run a network cable from your main router to this one, then tell us which port you used.'),
          preflight.ready
            ? el('div', { style: 'margin-bottom:16px' }, [badge(`Cable detected (${preflight.livePorts.join(', ') || 'link up'})`, 'ok')])
            : el('div', { class: 'alert' }, [
                icon('alert', { size: 18 }),
                el('div', {}, [el('span', { text: preflight.reason ?? 'No cable detected.' })]),
              ]),
          choices,
        ]);
      },
    },
    {
      render() {
        const manualBox = el('div', { hidden: !state.manual }, [
          field('Address for this router', inputs.manualIp, 'Must be free and on your main router’s network.'),
          field('Network mask', inputs.manualMask),
          field('Main router’s address', inputs.manualGw),
        ]);
        const manualToggle = toggle({
          checked: Boolean(state.manual),
          label: 'My main router does not hand out addresses',
          hint: 'Only needed on unusual networks.',
          onChange: (checked) => {
            state.manual = checked;
            manualBox.hidden = !checked;
          },
        });

        return el('div', {}, [
          stepHero('network', 'Your home network', 'Your main router keeps handing out addresses. This router will stop doing that and move to a free address on the same network.'),
          el('div', { class: 'alert alert-info' }, [
            icon('info', { size: 18 }),
            el('div', {}, [el('span', { text: 'EasyMode finds a free address automatically and shows it when setup finishes.' })]),
          ]),
          manualToggle,
          manualBox,
        ]);
      },
      commit() {
        state.manualValues = {
          ip: inputs.manualIp.value,
          netmask: inputs.manualMask.value,
          gateway: inputs.manualGw.value,
        };
      },
    },
    wifiStep(state, inputs),
    {
      render() {
        return el('div', {}, [
          stepHero('checkCircle', 'Review your setup', 'EasyMode will apply these settings and check that your main router answers.'),
          reviewRows([
            ['Mode', 'Access Point'],
            ['Cable plugged into', state.uplink === 'wan' ? 'Internet (WAN) port' : 'LAN port'],
            ['Addresses', state.manual ? `Fixed: ${state.manualValues?.ip ?? ''}` : 'Managed by your main router'],
            ['Wi-Fi', state.changeWifi ? state.wifiSsid : 'Left unchanged'],
          ]),
        ]);
      },
    },
  ];
}

function wirelessSteps(state, overview, variant) {
  const inputs = {
    password: el('input', { type: 'password', autocomplete: 'off', placeholder: 'Network password' }),
    lanIp: el('input', { value: overview.defaults.lanIp ?? '' }),
    ssid: el('input', { value: state.wifiSsid ?? overview.defaults.wifiSsid ?? '' }),
    key: el('input', { type: 'password', value: state.wifiKey ?? overview.defaults.wifiKey ?? '', placeholder: 'At least 8 characters' }),
  };
  const hotspot = variant === 'hotspot';

  return [
    {
      render() {
        const passwordField = el('div', { hidden: !state.needsPassword }, [
          field(hotspot ? 'Hotspot password' : 'Network password', inputs.password),
        ]);
        const picker = networkPicker(state, overview, () => {
          passwordField.hidden = !state.needsPassword;
          if (state.needsPassword) inputs.password.focus();
        });

        let disconnectBlock = null;
        if (overview.current.id === 'repeater' || overview.current.id === 'hotspot') {
          const currentUplink = overview.current.uplink;
          if (currentUplink?.kind === 'wireless' && currentUplink?.ssid) {
            const btn = el('button', {
              class: 'btn btn-ghost btn-small',
              type: 'button',
              onclick: async () => {
                const { confirmDialog } = await import('../components.js');
                if (await confirmDialog({
                  title: 'Disconnect from this network?',
                  message: 'You will lose internet access.',
                  confirmLabel: 'Disconnect',
                  tone: 'danger'
                })) {
                  btn.disabled = true;
                  try {
                    await api.disconnectRepeater();
                    let seconds = 65;
                    const interval = trackInterval(() => {
                      seconds -= 1;
                      btn.textContent = `Applying... ${seconds}s`;
                      if (seconds <= 0) {
                        clearTrackedInterval(interval);
                        location.reload();
                      }
                    }, 1000);
                  } catch (e) {
                    toast('Could not disconnect', { tone: 'bad', detail: e.message });
                    btn.disabled = false;
                    btn.textContent = 'Disconnect';
                  }
                }
              },
              text: 'Disconnect'
            });

            disconnectBlock = el('div', { class: 'alert alert-info', style: 'display:flex; align-items:center; justify-content:space-between; margin-bottom:16px;' }, [
              el('div', {}, [
                el('strong', { text: `Currently connected to: ${currentUplink.ssid}` }),
                el('div', { class: 'detail', text: 'To disconnect and stop being a repeater, click Disconnect.' })
              ]),
              btn
            ]);
          }
        }

        return el('div', {}, [
          stepHero(
            hotspot ? 'smartphone' : 'wifi',
            hotspot ? 'Connect to your phone' : 'Choose a Wi-Fi network',
            hotspot
              ? 'Turn on your phone’s hotspot, then pick it from the list. Your devices keep using this router’s Wi-Fi as normal.'
              : 'Pick the network you want to extend. This router will join it and pass the connection on.',
          ),
          disconnectBlock,
          picker,
          passwordField,
          overview.wireless?.singleRadio
            ? el('p', { class: 'empty', style: 'margin-top:14px', text: 'This router has one radio, so it shares a channel between the connection and your devices. Expect around half the speed of a direct connection.' })
            : null,
        ]);
      },
      commit() {
        state.password = inputs.password.value;
      },
      validate() {
        if (!state.ssid) return 'Choose a network to continue.';
        if (state.needsPassword && !inputs.password.value) return 'Enter the network password.';
        return null;
      },
    },
    {
      render() {
        const ipv6Toggle = toggle({
          checked: Boolean(state.ipv6),
          label: 'Pass through IPv6',
          hint: `Let devices get IPv6 addresses from ${hotspot ? 'your phone' : 'the network you joined'}, when it offers them. Leave off for plain IPv4 — turn it on later in Devices if you are unsure.`,
          onChange: (checked) => {
            state.ipv6 = checked;
          },
        });

        return el('div', {}, [
          stepHero('network', 'Your home network', 'Devices connect to this router and get their addresses from it.'),
          el('div', { class: 'alert alert-info' }, [
            icon('info', { size: 18 }),
            el('div', {}, [
              el('span', {
                text: `If the ${hotspot ? 'hotspot' : 'network you joined'} uses the same address range as this router, EasyMode moves your home network out of the way automatically.`,
              }),
            ]),
          ]),
          ipv6Toggle,
          advanced('Advanced settings', [
            field('Router address', inputs.lanIp, 'Leave as it is unless you know you need a specific range.')
          ]),
        ]);
      },
      commit() {
        state.lanIp = inputs.lanIp.value.trim();
      },
    },
    wifiStep(state, inputs, 'Wi-Fi for your own devices'),
    {
      render() {
        return el('div', {}, [
          stepHero('checkCircle', 'Review your setup', 'EasyMode will join the network first, then set everything else up.'),
          reviewRows([
            ['Mode', hotspot ? 'Mobile Hotspot' : 'Wi-Fi Repeater'],
            [hotspot ? 'Phone hotspot' : 'Network to extend', state.ssid],
            ['Router address', state.lanIp || overview.defaults.lanIp],
            ['IPv6', state.ipv6 ? 'On (when available)' : 'Off (IPv4 only)'],
            ['Wi-Fi for your devices', state.changeWifi ? state.wifiSsid : 'Left unchanged'],
          ]),
        ]);
      },
    },
  ];
}

/** Shared third step: optionally rename the router's own Wi-Fi. */
function wifiStep(state, inputs, title = 'Wi-Fi for your devices', cloneHint = 'Use the name and password of the network you joined') {
  return {
    render() {
      const cloneBtn = el('button', { class: 'btn btn-ghost btn-small', style: 'margin-bottom: 12px;' }, [cloneHint]);
      cloneBtn.addEventListener('click', () => {
        if (state.ssid) inputs.ssid.value = state.ssid;
        if (inputs.password?.value) inputs.key.value = inputs.password.value;
      });

      const box = el('div', { hidden: !state.changeWifi }, [
        state.ssid ? cloneBtn : null,
        field('Wi-Fi name', inputs.ssid),
        field('Wi-Fi password', inputs.key, 'At least 8 characters.'),
      ]);
      const changeToggle = toggle({
        checked: Boolean(state.changeWifi),
        label: 'Set the Wi-Fi name and password',
        hint: 'Leave off to keep your current Wi-Fi exactly as it is.',
        onChange: (checked) => {
          state.changeWifi = checked;
          box.hidden = !checked;
        },
      });

      return el('div', {}, [
        stepHero('wifi', title, 'This is the network your phones, laptops and TV connect to.'),
        changeToggle,
        box,
      ]);
    },
    commit() {
      state.wifiSsid = inputs.ssid.value;
      state.wifiKey = inputs.key.value;
    },
    validate() {
      if (state.changeWifi && !inputs.ssid.value.trim()) return 'Enter a Wi-Fi name.';
      if (state.changeWifi && inputs.key.value && inputs.key.value.length < 8) return 'The Wi-Fi password must be at least 8 characters.';
      return null;
    },
  };
}

/* ============================================================
   Payload building — shapes are exactly what the API already accepts
   ============================================================ */
function buildPayload(modeId, state) {
  const wifi = state.changeWifi
    ? { enabled: true, ssid: state.wifiSsid, key: state.wifiKey, encryption: 'psk2' }
    : { enabled: false };

  if (modeId === 'router') {
    const payload = { connection: state.connection, lan: { leasetime: state.leasetime || '12h' }, wifi };
    if (state.lanIp) payload.lan.ip = state.lanIp;
    if (state.connection === 'pppoe') payload.pppoe = state.pppoe;
    if (state.connection === 'static') payload.static = state.static;
    if (state.macaddr) payload.macaddr = state.macaddr;
    return payload;
  }

  if (modeId === 'ap') {
    const payload = { uplink: state.uplink, wifi };
    if (state.manual) payload.manual = state.manualValues;
    return payload;
  }

  return {
    radio: state.radio,
    ssid: state.ssid,
    key: state.password ?? '',
    encryption: state.encryption ?? 'psk2',
    ipv6: Boolean(state.ipv6),
    lan: state.lanIp ? { ip: state.lanIp } : {},
    wifi,
  };
}

const APPLY = {
  router: (payload) => api.applyRouterMode(payload),
  ap: (payload) => api.applyApMode(payload),
  repeater: (payload) => api.applyRepeaterMode(payload),
  hotspot: (payload) => api.applyHotspotMode(payload),
};

/* ============================================================
   Progress
   ============================================================ */
function successLines(modeId, summary) {
  if (modeId === 'ap') {
    return [
      `This router is now reachable at ${summary.managementIp}. Write it down — you will need it to open EasyMode again.`,
      `Addresses come from your main router at ${summary.upstreamGateway}.`,
      summary.internetVerified ? null : 'The internet could not be tested from here.',
    ].filter(Boolean);
  }
  if (modeId === 'repeater' || modeId === 'hotspot') {
    return [
      `Connected to "${summary.uplinkSsid}"${summary.uplinkSignal ? ` — signal ${summary.uplinkSignal} dBm` : ''}.`,
      `Your devices reach this router at ${summary.lanIp}.`,
      summary.lanMoved ? `The home network moved to ${summary.lanMoved.to} to avoid a clash.` : null,
      summary.internetVerified ? null : 'The internet could not be tested from here.',
    ].filter(Boolean);
  }
  return [
    summary.internetVerified
      ? `Internet is working. This router has the address ${summary.wanIp}.`
      : `Connection established (${summary.wanIp ?? 'address received'}). Internet could not be tested from here.`,
    summary.lanMoved ? `Your home network moved to ${summary.lanMoved.to} to avoid a clash.` : null,
  ].filter(Boolean);
}

/**
 * Result view for backends that apply the switch synchronously (Android), where the
 * response is the outcome itself rather than a job to poll. A reverted change arrives as a
 * thrown error and is handled by the caller, so reaching here means the switch was applied.
 */
function appliedView(container, modeId, result) {
  const meta = modeById(modeId);
  // Android returns { mode, ok, pending, message? } with no per-field summary, so don't
  // reuse successLines here (it would render "reachable at undefined"). Show the backend's
  // own message plus a mode-appropriate reconnect note.
  const note = modeId === 'ap'
    ? 'This router now takes its address from your main router. If EasyMode cannot reach it, reconnect to the router and open the app again.'
    : 'Give the router a moment to finish switching, then reconnect if your device dropped off.';
  clear(container).append(
    panel({ icon: icon('router', { size: 19 }), title: `Setting up ${meta.title}`, className: 'progress-card wizard' }, [
      el('div', { class: 'result ok' }, [
        el('strong', { text: 'Settings applied.' }),
        result?.message ? el('span', { text: result.message }) : null,
        el('span', { text: note }),
      ].filter(Boolean)),
      el('button', { class: 'btn btn-primary', style: 'margin-top:16px', onclick: () => location.reload(), text: 'Done' }),
    ]),
  );
  toast('Mode applied', { tone: 'ok' });
}

function progressView(container, jobId, modeId, { onDone }) {
  const body = el('div');
  clear(container).append(
    panel({ icon: icon('router', { size: 19 }), title: `Setting up ${modeById(modeId).title}`, className: 'progress-card wizard' }, [body]),
  );

  let stopped = false;
  const icons = { pending: '○', running: '◐', done: '●', failed: '✕', skipped: '·' };

  const poll = async () => {
    try {
      const job = await api.job(jobId);
      if (stopped) return;
      clear(body).append(
        el(
          'ul',
          { class: 'steps' },
          job.steps.map((step) =>
            el('li', { class: `step ${step.status}` }, [
              el('span', { class: 'step-ico', text: icons[step.status] ?? '○' }),
              el('div', {}, [
                el('strong', { text: step.label }),
                step.detail ? el('span', { class: 'step-detail', text: step.detail }) : null,
              ]),
            ]),
          ),
        ),
      );

      if (job.status === 'running') {
        setTimeout(poll, 1200);
        return;
      }

      if (job.status === 'success') {
        body.append(
          el('div', { class: 'result ok' }, [
            el('strong', { text: 'Setup complete.' }),
            ...successLines(modeId, job.result ?? {}).map((line) => el('span', { text: line })),
          ]),
          el('button', { class: 'btn btn-primary', style: 'margin-top:16px', onclick: () => location.reload(), text: 'Done' }),
        );
        toast('Mode configured successfully', { tone: 'ok' });
      } else {
        const autoReverted = modeId === 'router' || modeId === 'repeater';
        const recovery = job.recovery ?? (autoReverted
          ? 'Your previous settings were restored.'
          : 'Check the router at its previous address; you may need to reconnect or reset it.');
        body.append(
          el('div', { class: 'result bad' }, [
            el('strong', { text: 'Setup did not complete.' }),
            el('span', { text: job.error ?? 'Unknown error.' }),
            el('span', { text: recovery }),
          ]),
          el('button', { class: 'btn btn-ghost', style: 'margin-top:16px', onclick: onDone, text: 'Back to modes' }),
        );
        toast(autoReverted ? 'Setup failed — previous settings restored' : 'Setup failed', { tone: 'bad' });
      }
    } catch (error) {
      if (stopped) return;
      clear(body).append(errorState(error), el('button', { class: 'btn btn-ghost', style: 'margin-top:14px', onclick: onDone, text: 'Back' }));
    }
  };

  poll();
  return () => {
    stopped = true;
  };
}

/* ============================================================
   Page
   ============================================================ */
export function renderModeSetup(container, { onUnauthorized }) {
  let cancelPolling = null;

  const head = el('div', { class: 'page-head' }, [
    el('div', {}, [
      el('h1', { text: 'How do you want to use this router?' }),
      el('p', { text: 'Choose a setup and EasyMode configures the network for you.' }),
    ]),
  ]);
  const body = el('div', {}, [skeleton({ rows: 6 })]);
  container.append(head, body);

  const showOverview = async () => {
    cancelPolling?.();
    cancelPolling = null;
    try {
      const overview = await api.modeOverview();
      clear(body).append(
        el('div', { class: 'current-banner' }, [
          el('span', { text: 'Right now: ' }),
          el('strong', { text: modeById(overview.current.id)?.title ?? 'Custom setup' }),
          el('span', { text: ` · Internet source: ${overview.current.internetSource}` }),
        ]),
        el(
          'div',
          { class: 'mode-grid' },
          MODES.map((mode) =>
            modeCard(mode, {
              current: overview.current.id === mode.id,
              available: overview.available[mode.id],
              onSelect: (id) => showWizard(overview, id),
              uplink: overview.current.id === mode.id ? overview.current.uplink : null,
            }),
          ),
        ),
      );
    } catch (error) {
      if (error.status === 401) return onUnauthorized();
      clear(body).append(errorState(error, showOverview));
    }
  };

  const showWizard = (overview, modeId) => {
    const meta = modeById(modeId);
    const currentUplink = (overview.current.id === 'repeater' || overview.current.id === 'hotspot') ? overview.current.uplink : null;
    const state = {
      connection: 'auto',
      uplink: overview.preflight.ap?.suggestedUplink ?? 'wan',
      radio: overview.wireless?.radios?.[0]?.id ?? null,
      ssid: currentUplink?.kind === 'wireless' ? currentUplink.ssid : null,
      encryption: currentUplink?.kind === 'wireless' ? 'psk2' : null,
      changeWifi: false,
      needsPassword: true,
    };

    const steps =
      modeId === 'router'
        ? routerSteps(state, overview)
        : modeId === 'ap'
          ? apSteps(state, overview)
          : wirelessSteps(state, overview, modeId);

    let index = 0;

    const draw = () => {
      const step = steps[index];
      const errorSlot = el('div');

      const back = el('button', { class: 'btn btn-ghost' }, [
        icon('chevronLeft', { size: 16 }),
        el('span', { text: index === 0 ? 'All modes' : 'Back' }),
      ]);
      back.addEventListener('click', () => {
        if (index === 0) return showOverview();
        steps[index].commit?.();
        index -= 1;
        draw();
      });

      const isLast = index === steps.length - 1;
      const next = el('button', { class: 'btn btn-primary' }, [
        el('span', { text: isLast ? 'Apply setup' : 'Continue' }),
        isLast ? null : icon('chevronRight', { size: 16 }),
      ]);

      next.addEventListener('click', async () => {
        step.commit?.();
        const problem = step.validate?.();
        if (problem) {
          clear(errorSlot).append(errorState({ message: problem }));
          return;
        }
        if (!isLast) {
          index += 1;
          draw();
          return;
        }

        // Router/Repeater keep a fixed LAN address, so the app can reconnect and the
        // router auto-reverts if the change locks it out. Access Point mode takes a new
        // address from the main router, so there is no safe auto-revert to promise.
        const autoReverts = modeId === 'router' || modeId === 'repeater';
        const confirmed = await confirmDialog({
          title: `Switch to ${meta.title} mode?`,
          message: 'Your devices lose connection for a few seconds while the router applies the change.',
          detail: autoReverts
            ? 'If the new settings lock the router out, it restores the previous ones by itself.'
            : 'This router will take a new address from your main router. Note the address shown when setup finishes — you will need it to open EasyMode again.',
          confirmLabel: 'Apply setup',
        });
        if (!confirmed) return;

        next.disabled = true;
        try {
          const result = await APPLY[modeId](buildPayload(modeId, state));
          if (result?.jobId) {
            // Node backend: a background job to poll for step-by-step progress.
            cancelPolling = progressView(body, result.jobId, modeId, { onDone: showOverview });
          } else {
            // Android backend: the switch already ran synchronously (a thrown error would
            // mean it reverted). There is no job to poll — show the result directly.
            appliedView(body, modeId, result);
          }
        } catch (error) {
          if (error.status === 401) return onUnauthorized();
          clear(errorSlot).append(errorState(error));
          next.disabled = false;
        }
      });

      clear(body).append(
        panel({ icon: icon(meta.icon, { size: 19 }), title: `${meta.title} setup`, className: 'wizard' }, [
          stepper(index),
          el('div', { class: 'wizard-step' }, [step.render()]),
          errorSlot,
          el('div', { class: 'wizard-foot' }, [back, el('span', { class: 'spacer' }), next]),
        ]),
      );
    };

    draw();
  };

  showOverview();
  return () => {
    cancelPolling?.();
    // Stop any in-flight countdown so it can't fire location.reload() after teardown.
    for (const id of activeTimers) clearInterval(id);
    activeTimers.clear();
  };
}
