import { api } from '../api.js';
import { emptyState, errorState, openModal, skeletonCards, toast, toggle } from '../components.js';
import { icon } from '../icons.js';
import { badge, clear, dash, el, formatBytes, formatMbps, panel } from '../ui.js';

const PRESETS = [1000, 500, 250, 100, 50, 25, 10, 5];

const field = (label, input, hint) =>
  el('div', { class: 'field' }, [
    el('label', { text: label }),
    input,
    hint ? el('span', { class: 'hint', text: hint }) : null,
  ]);

/* ============================================================
   Live usage
   ============================================================ */
function usagePanel(total, limits) {
  if (!total.available) {
    return panel({ icon: icon('gauge', { size: 19 }), title: 'Network usage' }, [
      emptyState({ glyph: 'gauge', title: 'Nothing to measure yet', message: total.reason }),
    ]);
  }

  const down = formatMbps(total.rxRate);
  const up = formatMbps(total.txRate);
  const capacity = limits.enabled ? limits.downloadMbps : null;
  const usedShare = capacity && down ? Math.min(100, (Number(down) / capacity) * 100) : null;

  return panel(
    {
      icon: icon('gauge', { size: 19 }),
      title: 'Network usage',
      trailing: limits.enabled ? badge(`Limited to ${limits.downloadMbps} Mbps`, 'accent', { dot: false }) : null,
    },
    [
      el('div', { class: 'rate-row' }, [
        el('div', { class: 'rate' }, [
          el('span', { class: 'rate-label' }, [icon('arrowDown', { size: 14 }), el('span', { text: 'Download' })]),
          el('span', { class: 'big' }, [el('span', { text: down ?? dash }), el('small', { style: 'font-size:14px;color:var(--text-faint)', text: ' Mbps' })]),
          usedShare == null ? null : el('div', { class: 'meter' }, [el('i', { style: `width:${usedShare}%` })]),
        ]),
        el('div', { class: 'rate' }, [
          el('span', { class: 'rate-label' }, [icon('arrowUp', { size: 14 }), el('span', { text: 'Upload' })]),
          el('span', { class: 'big' }, [el('span', { text: up ?? dash }), el('small', { style: 'font-size:14px;color:var(--text-faint)', text: ' Mbps' })]),
        ]),
      ]),
      total.reason ? el('p', { class: 'empty', style: 'margin-top:10px', text: total.reason }) : null,
      el('details', { class: 'advanced' }, [
        el('summary', { text: 'View details' }),
        el('div', { class: 'kv' }, [
          el('div', { class: 'row' }, [
            el('span', { class: 'k', text: 'Downloaded since restart' }),
            el('span', { class: 'v', text: total.rxBytes == null ? dash : formatBytes(total.rxBytes) }),
          ]),
          el('div', { class: 'row' }, [
            el('span', { class: 'k', text: 'Uploaded since restart' }),
            el('span', { class: 'v', text: total.txBytes == null ? dash : formatBytes(total.txBytes) }),
          ]),
          el('div', { class: 'row' }, [
            el('span', { class: 'k', text: 'Measured on' }),
            el('span', { class: 'v', text: total.interface ?? dash }),
          ]),
        ]),
      ]),
    ],
  );
}

/* ============================================================
   Connection speed limit
   ============================================================ */
function limitsPanel(limits, { onSaved, onUnauthorized }) {
  if (!limits.available) {
    return panel({ icon: icon('signal', { size: 19 }), title: 'Speed limits' }, [
      emptyState({
        glyph: 'signal',
        title: 'Speed limits are not available',
        message: `${limits.reason} Install sqm-scripts on the router to enable them.`,
      }),
    ]);
  }

  const enabled = toggle({
    checked: limits.enabled,
    label: 'Keep the connection responsive',
    hint: 'Stops big downloads from making video calls and games stutter.',
  });
  const download = el('input', { type: 'number', min: 1, max: 10000, value: limits.downloadMbps ?? '', placeholder: '100' });
  const upload = el('input', { type: 'number', min: 1, max: 10000, value: limits.uploadMbps ?? '', placeholder: '20' });
  const errorSlot = el('div');
  const save = el('button', { class: 'btn btn-primary' }, ['Save limits']);

  const presets = (input) =>
    el(
      'div',
      { class: 'presets' },
      PRESETS.map((value) =>
        el('button', {
          type: 'button',
          class: 'chip',
          onclick: () => {
            input.value = String(value);
          },
          text: String(value),
        }),
      ),
    );

  save.addEventListener('click', async () => {
    clear(errorSlot);
    save.disabled = true;
    save.textContent = 'Applying…';
    try {
      await api.setBandwidthLimits({
        enabled: enabled.input.checked,
        downloadMbps: download.value ? Number(download.value) : null,
        uploadMbps: upload.value ? Number(upload.value) : null,
      });
      toast('Speed limits saved', { tone: 'ok' });
      onSaved();
    } catch (error) {
      if (error.status === 401) return onUnauthorized();
      errorSlot.append(errorState(error));
    } finally {
      save.disabled = false;
      save.textContent = 'Save limits';
    }
  });

  return panel(
    {
      icon: icon('signal', { size: 19 }),
      title: 'Speed limits',
      trailing: badge(limits.enabled ? 'Active' : 'Off', limits.enabled ? 'ok' : 'neutral'),
    },
    [
      enabled,
      el('p', { class: 'empty', style: 'margin:14px 0' }, [
        el('span', { text: 'Enter the speed your internet plan actually gives you. Setting it slightly below the real speed is what keeps everything else smooth.' }),
      ]),
      el('div', { class: 'field' }, [el('label', { text: 'Download speed (Mbps)' }), download, presets(download)]),
      el('div', { class: 'field' }, [el('label', { text: 'Upload speed (Mbps)' }), upload, presets(upload)]),
      errorSlot,
      el('div', { class: 'button-row' }, [save]),
    ],
  );
}

/* ============================================================
   Per-device usage
   ============================================================ */
function openDeviceModal(device, perDeviceLimits) {
  const controlsAvailable = perDeviceLimits.available;
  const close = el('button', { class: 'btn btn-ghost' }, ['Close']);

  const modal = openModal({
    title: device.ip ?? device.mac ?? 'Device',
    subtitle: device.mac ?? null,
    size: 'sm',
    body: [
      el('div', { class: 'stat-row' }, [
        el('div', { class: 'stat' }, [
          el('span', { class: 'label' }, [icon('arrowDown', { size: 14 }), el('span', { text: 'Downloaded' })]),
          el('div', { class: 'value', style: 'font-size:20px', text: formatBytes(device.rxBytes) }),
        ]),
        el('div', { class: 'stat' }, [
          el('span', { class: 'label' }, [icon('arrowUp', { size: 14 }), el('span', { text: 'Uploaded' })]),
          el('div', { class: 'value', style: 'font-size:20px', text: formatBytes(device.txBytes) }),
        ]),
      ]),
      el('div', { style: 'height:18px' }),
      controlsAvailable
        ? null
        : el('div', { class: 'alert alert-info' }, [
            icon('info', { size: 18 }),
            el('div', {}, [
              el('span', { text: 'Per-device priority and speed limits are not available on this router.' }),
              el('span', { class: 'detail', text: perDeviceLimits.reason }),
            ]),
          ]),
    ],
    actions: [close],
  });

  close.addEventListener('click', modal.close);
}

function devicesPanel(perDevice, perDeviceLimits) {
  if (!perDevice.available) {
    return panel({ icon: icon('devices', { size: 19 }), title: 'Usage by device' }, [
      emptyState({ glyph: 'devices', title: 'Per-device usage is not available', message: perDevice.reason }),
    ]);
  }

  const busiest = perDevice.devices[0];
  const peak = busiest ? busiest.rxBytes + busiest.txBytes : 0;

  return panel({ icon: icon('devices', { size: 19 }), title: 'Usage by device' }, [
    el('div', { class: 'table-wrap' }, [
      el('table', { class: 'data-table' }, [
        el('thead', {}, [
          el('tr', {}, [el('th', { text: 'Device' }), el('th', { text: 'Downloaded' }), el('th', { text: 'Uploaded' }), el('th', {})]),
        ]),
        el(
          'tbody',
          {},
          perDevice.devices.slice(0, 25).map((device) => {
            const share = peak ? ((device.rxBytes + device.txBytes) / peak) * 100 : 0;
            return el('tr', {}, [
              el('td', {}, [
                el('strong', { text: device.ip ?? device.mac ?? 'Unknown' }),
                el('div', { class: 'meter', style: 'margin-top:6px;max-width:180px' }, [el('i', { style: `width:${share}%` })]),
              ]),
              el('td', { text: formatBytes(device.rxBytes) }),
              el('td', { text: formatBytes(device.txBytes) }),
              el('td', { style: 'text-align:right' }, [
                el('button', {
                  class: 'btn btn-quiet btn-small',
                  onclick: () => openDeviceModal(device, perDeviceLimits),
                  text: 'Manage',
                }),
              ]),
            ]);
          }),
        ),
      ]),
    ]),
  ]);
}

/* ============================================================
   Page
   ============================================================ */
export function renderBandwidth(container, { onUnauthorized }) {
  const head = el('div', { class: 'page-head' }, [
    el('div', {}, [
      el('h1', { text: 'Bandwidth' }),
      el('p', { text: 'What your connection is doing, and how to keep it responsive.' }),
    ]),
  ]);
  const body = el('div', {}, [skeletonCards(2, 4)]);
  container.append(head, body);

  let stopped = false;
  let timer = null;

  const load = async ({ poll = true } = {}) => {
    // Cancel any pending poll so a manual reload (e.g. after saving limits) doesn't
    // leave a second poll chain running alongside this one.
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      const data = await api.bandwidth();
      if (stopped) return;
      clear(body).append(
        el('div', { class: 'grid halves' }, [
          usagePanel(data.total, data.limits),
          limitsPanel(data.limits, { onSaved: () => load({ poll: false }), onUnauthorized }),
        ]),
        el('div', { style: 'height:16px' }),
        devicesPanel(data.perDevice, data.perDeviceLimits),
      );
    } catch (error) {
      if (stopped) return;
      if (error.status === 401) return onUnauthorized();
      clear(body).append(errorState(error, () => load()));
    }
    if (poll && !stopped) timer = setTimeout(() => load(), 5000);
  };

  load();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
