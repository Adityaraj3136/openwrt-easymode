import { api } from '../api.js';
import { confirmDialog, errorState, skeletonCards, toast } from '../components.js';
import { icon } from '../icons.js';
import { badge, clear, dash, el, formatBytes, kv, panel } from '../ui.js';

const CAPABILITY_LABELS = {
  cpuUsage: 'Processor usage readings',
  dhcpLeases: 'List of connected devices',
  iwinfo: 'Wi-Fi details and scanning',
  wirelessControl: 'Wi-Fi configuration',
  sqm: 'Connection speed limits',
  fileRead: 'Reading status files',
  hostapdControl: 'Direct Wi-Fi control',
};

/** Saves a JSON object to the visitor's machine. */
function download(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/* ============================================================
   1 — Router information
   ============================================================ */
function infoPanel(data) {
  const { system, router } = data;
  return panel(
    {
      icon: icon('router', { size: 19 }),
      title: 'Router information',
      trailing: badge(`Up ${system.uptime ?? dash}`, 'ok', { dot: false }),
    },
    [
      kv([
        ['Model', system.model],
        ['Router name', system.hostname],
        ['OpenWrt version', system.version],
        ['Router address', router.host, 'mono'],
        ['Signed in as', router.username],
        ['Memory', system.memory.total ? `${formatBytes(system.memory.used)} of ${formatBytes(system.memory.total)}` : null],
      ]),
      el('details', { class: 'advanced' }, [
        el('summary', { text: 'Router capabilities' }),
        el('p', { class: 'empty', style: 'margin-bottom:12px', text: 'EasyMode hides anything your router cannot do, rather than showing controls that would fail.' }),
        el(
          'div',
          { class: 'caps' },
          Object.entries(CAPABILITY_LABELS).map(([key, label]) =>
            badge(label, data.capabilities[key] ? 'ok' : 'neutral', { dot: Boolean(data.capabilities[key]) }),
          ),
        ),
        el('div', { style: 'height:14px' }),
        kv([['Full firmware', system.firmware], ['Kernel', system.kernel]]),
      ]),
    ],
  );
}

/* ============================================================
   2 — Backup and restore
   ============================================================ */
function backupPanel({ onUnauthorized }) {
  const errorSlot = el('div');
  const fileInput = el('input', { type: 'file', accept: 'application/json,.json' });

  const backupButton = el('button', { class: 'btn btn-primary' }, [icon('download', { size: 16 }), el('span', { text: 'Save a backup' })]);
  backupButton.addEventListener('click', async () => {
    clear(errorSlot);
    backupButton.disabled = true;
    try {
      const backup = await api.backup();
      download(`easymode-backup-${backup.takenAt.slice(0, 10)}.json`, backup);
      toast('Backup saved to your downloads', { tone: 'ok' });
    } catch (error) {
      if (error.status === 401) return onUnauthorized();
      errorSlot.append(errorState(error));
    } finally {
      backupButton.disabled = false;
    }
  });

  const restoreButton = el('button', { class: 'btn btn-ghost' }, [icon('upload', { size: 16 }), el('span', { text: 'Restore from file' })]);
  restoreButton.addEventListener('click', async () => {
    clear(errorSlot);
    const file = fileInput.files?.[0];
    if (!file) {
      errorSlot.append(errorState({ message: 'Choose a backup file first.' }));
      return;
    }

    const confirmed = await confirmDialog({
      title: 'Restore these settings?',
      message: 'Your network goes down briefly while the router applies the backup.',
      detail: 'If the restored settings do not work, the router puts back what it had.',
      confirmLabel: 'Restore',
      tone: 'danger',
    });
    if (!confirmed) return;

    restoreButton.disabled = true;
    try {
      const result = await api.restore(JSON.parse(await file.text()));
      toast('Settings restored', {
        tone: 'ok',
        detail: result.restoredFrom ? `From the backup taken ${new Date(result.restoredFrom).toLocaleString()}` : null,
      });
    } catch (error) {
      if (error.status === 401) return onUnauthorized();
      errorSlot.append(error instanceof SyntaxError ? errorState({ message: 'That file is not a readable backup.' }) : errorState(error));
    } finally {
      restoreButton.disabled = false;
    }
  });

  return panel({ icon: icon('save', { size: 19 }), title: 'Backup & restore' }, [
    el('p', { class: 'empty', style: 'margin-bottom:14px', text: 'A backup holds your network, Wi-Fi, address and speed-limit settings. Keep one before making big changes.' }),
    el('div', { class: 'button-row' }, [backupButton]),
    el('div', { class: 'field', style: 'margin-top:18px' }, [el('label', { text: 'Restore a saved backup' }), fileInput]),
    el('div', { class: 'button-row' }, [restoreButton]),
    errorSlot,
  ]);
}

/* ============================================================
   3 — Router actions
   ============================================================ */
function actionsPanel(systemData, { onUnauthorized, onLoggedOut }) {
  const { system, router } = systemData;
  const errorSlot = el('div');

  const reboot = el('button', { class: 'btn btn-danger' }, [icon('power', { size: 16 }), el('span', { text: 'Restart router' })]);
  reboot.addEventListener('click', async () => {
    const confirmed = await confirmDialog({
      title: 'Restart the router?',
      message: 'Everyone loses their connection for a minute or two.',
      confirmLabel: 'Restart',
      tone: 'danger',
    });
    if (!confirmed) return;
    clear(errorSlot);
    reboot.disabled = true;
    try {
      await api.reboot();
      toast('Router is restarting', { tone: 'info', detail: 'This page works again once it is back, usually within two minutes.', duration: 8000 });
    } catch (error) {
      if (error.status === 401) return onUnauthorized();
      errorSlot.append(errorState(error));
      reboot.disabled = false;
    }
  });

  const signOut = el('button', { class: 'btn btn-ghost' }, [icon('logout', { size: 16 }), el('span', { text: 'Sign out' })]);
  signOut.addEventListener('click', async () => {
    await api.logout().catch(() => {});
    onLoggedOut();
  });

  const autoRebootToggle = el('input', { type: 'checkbox', checked: system.autoReboot?.enabled ?? false });
  autoRebootToggle.addEventListener('change', async () => {
    autoRebootToggle.disabled = true;
    try {
      await api.setAutoReboot(autoRebootToggle.checked ? { enabled: true, day: 0, hour: 3, minute: 0 } : { enabled: false });
      toast(autoRebootToggle.checked ? 'Scheduled to reboot Sunday at 3 AM' : 'Auto-reboot disabled', { tone: 'ok' });
    } catch (error) {
      autoRebootToggle.checked = !autoRebootToggle.checked;
      errorSlot.append(errorState(error));
    } finally {
      autoRebootToggle.disabled = false;
    }
  });

  return panel({ icon: icon('settings', { size: 19 }), title: 'Router actions' }, [
    el('a', { class: 'action-row', href: router.luciUrl, target: '_blank', rel: 'noopener' }, [
      el('div', { class: 'card-icon' }, [icon('external', { size: 18 })]),
      el('div', {}, [
        el('strong', { text: 'Advanced settings' }),
        el('span', { text: 'Opens the full OpenWrt LuCI interface.' }),
      ]),
      icon('chevronRight', { size: 18 }),
    ]),

    el('div', { class: 'field', style: 'margin-top:12px; display:flex; align-items:center; justify-content:space-between; padding:12px; border:1px solid var(--border); border-radius:8px;' }, [
      el('div', {}, [
        el('strong', { text: 'Auto-Reboot Schedule', style: 'display:block; margin-bottom:4px;' }),
        el('span', { class: 'sub', text: 'Automatically restart the router every Sunday at 3:00 AM to keep things fresh.' })
      ]),
      el('label', { class: 'switch' }, [autoRebootToggle, el('span', { class: 'slider' })])
    ]),

    el('div', { class: 'button-row', style: 'margin-top:16px' }, [signOut, reboot]),
    errorSlot,
  ]);
}

/* ============================================================
   Page
   ============================================================ */
export function renderSystem(container, { onUnauthorized, onLoggedOut }) {
  const head = el('div', { class: 'page-head' }, [
    el('div', {}, [
      el('h1', { text: 'System' }),
      el('p', { text: 'Router details, backups, and the things you rarely need.' }),
    ]),
  ]);
  const body = el('div', {}, [skeletonCards(2, 5)]);
  container.append(head, body);

  const load = async () => {
    try {
      const data = await api.systemOverview();
      clear(body).append(
        el('div', { class: 'grid halves' }, [infoPanel(data), backupPanel({ onUnauthorized })]),
        el('div', { style: 'height:16px' }),
        el('div', { class: 'grid halves' }, [actionsPanel(data, { onUnauthorized, onLoggedOut })]),
      );
    } catch (error) {
      if (error.status === 401) return onUnauthorized();
      clear(body).append(errorState(error, load));
    }
  };

  load();
  return () => {};
}
