import { icon } from './icons.js';
import { clear, el } from './ui.js';

/* ============================================================
   Toasts
   ============================================================ */
let toastHost = null;

function host() {
  if (!toastHost) {
    toastHost = el('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  return toastHost;
}

/** Brief confirmation of something that already happened. */
export function toast(message, { tone = 'ok', detail = null, duration = 4000 } = {}) {
  const glyph = { ok: 'checkCircle', bad: 'xCircle', warn: 'alert', info: 'info' }[tone] ?? 'info';
  const node = el('div', { class: `toast ${tone}` }, [
    icon(glyph, { size: 19 }),
    el('div', {}, [el('strong', { text: message }), detail ? el('span', { text: detail }) : null]),
  ]);
  host().append(node);

  const remove = () => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 200);
  };
  const timer = setTimeout(remove, duration);
  node.addEventListener('click', () => {
    clearTimeout(timer);
    remove();
  });
  return remove;
}

/* ============================================================
   Modal / drawer
   ============================================================ */
/**
 * Opens a centred dialog. Returns { close, body } so callers can render into it and
 * dismiss it once their own work finishes.
 */
export function openModal({ title, subtitle = null, body, actions = [], size = 'md', onClose = null }) {
  const previouslyFocused = document.activeElement;
  const content = el('div', { class: 'modal-body' }, [].concat(body).filter(Boolean));

  const close = () => {
    overlay.classList.add('leaving');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => {
      overlay.remove();
      previouslyFocused?.focus?.();
    }, 160);
    onClose?.();
  };

  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };

  const dialog = el('div', { class: `modal modal-${size}`, role: 'dialog', 'aria-modal': 'true' }, [
    el('div', { class: 'modal-head' }, [
      el('div', {}, [
        el('h2', { text: title }),
        subtitle ? el('p', { text: subtitle }) : null,
      ]),
      el('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, [icon('close', { size: 18 })]),
    ]),
    content,
    actions.length ? el('div', { class: 'modal-foot' }, actions) : null,
  ]);

  const overlay = el('div', { class: 'modal-overlay' }, [dialog]);
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  dialog.querySelector('input, select, button')?.focus();

  return { close, body: content, dialog };
}

/** Yes/no dialog for anything destructive or disruptive. Resolves to a boolean. */
export function confirmDialog({
  title,
  message,
  detail = null,
  confirmLabel = 'Continue',
  cancelLabel = 'Cancel',
  tone = 'primary',
}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const confirm = el('button', { class: `btn btn-${tone === 'danger' ? 'danger' : 'primary'}` }, [confirmLabel]);
    const cancel = el('button', { class: 'btn btn-ghost' }, [cancelLabel]);

    const modal = openModal({
      title,
      body: [
        el('p', { class: 'modal-message', text: message }),
        detail ? el('p', { class: 'empty', text: detail }) : null,
      ],
      actions: [cancel, confirm],
      size: 'sm',
      onClose: () => finish(false),
    });

    confirm.addEventListener('click', () => {
      finish(true);
      modal.close();
    });
    cancel.addEventListener('click', () => {
      finish(false);
      modal.close();
    });
  });
}

/* ============================================================
   Form controls
   ============================================================ */
/** A real switch rather than a checkbox. Returns the wrapper; read `.input.checked`. */
export function toggle({ checked = false, label = null, hint = null, disabled = false, onChange = null } = {}) {
  const input = el('input', { type: 'checkbox', checked: checked || false, disabled: disabled || false });
  const wrap = el('label', { class: `switch-row${disabled ? ' disabled' : ''}` }, [
    el('span', { class: 'switch' }, [input, el('span', { class: 'slider' })]),
    label
      ? el('span', { class: 'switch-copy' }, [
          el('strong', { text: label }),
          hint ? el('span', { text: hint }) : null,
        ])
      : null,
  ]);
  if (onChange) input.addEventListener('change', () => onChange(input.checked));
  wrap.input = input;
  return wrap;
}

/* ============================================================
   Loading + empty states
   ============================================================ */
export function skeleton({ rows = 3, className = '' } = {}) {
  return el(
    'div',
    { class: `skeleton ${className}`.trim() },
    Array.from({ length: rows }, (_, index) =>
      el('span', { class: 'skeleton-line', style: `width:${[100, 76, 88, 62][index % 4]}%` }),
    ),
  );
}

export function skeletonCards(count = 2, rows = 4) {
  return el(
    'div',
    { class: 'grid halves' },
    Array.from({ length: count }, () => el('section', { class: 'card' }, [skeleton({ rows })])),
  );
}

export function emptyState({ glyph = 'info', title, message, action = null }) {
  return el('div', { class: 'empty-state' }, [
    el('div', { class: 'empty-glyph' }, [icon(glyph, { size: 22 })]),
    el('strong', { text: title }),
    message ? el('p', { text: message }) : null,
    action,
  ]);
}

/* ============================================================
   Errors in plain language
   ============================================================ */
const FRIENDLY = {
  NO_SESSION: 'Your session ended. Please sign in to the router again.',
  ROUTER_UNREACHABLE: 'The router is not answering. Check that it is powered on and connected.',
  ROUTER_UNREACHABLE_AFTER_CHANGE: 'The router stopped answering, so it is restoring your previous settings.',
  INVALID_CREDENTIALS: 'That username or password was not accepted.',
  RATE_LIMITED: 'Too many attempts. Please wait a few minutes and try again.',
  JOB_RUNNING: 'A setup is already running. Wait for it to finish first.',
  DHCP_MANAGED_ELSEWHERE: 'Your main router is handing out addresses while this router is an access point.',
  NO_WAN_LINK: 'No cable detected in the internet port.',
  UPLINK_NOT_ASSOCIATED: 'Could not join that Wi-Fi network. Check the password and signal.',
  SCAN_BAND_BUSY: 'This band is connected to your main router, so it can’t scan for networks at the same time. Switch to the other band to scan.',
  SCAN_FAILED: 'The router couldn’t scan for Wi-Fi networks right now. If this band also connects to your main router, try the other band.',
};

export const friendlyError = (error) => FRIENDLY[error?.code] ?? error?.message ?? 'Something went wrong.';

/** Inline error block with an optional retry. */
export function errorState(error, onRetry = null) {
  return el('div', { class: 'alert' }, [
    icon('alert', { size: 18 }),
    el('div', {}, [
      el('span', { text: friendlyError(error) }),
      error?.details ? el('span', { class: 'detail', text: error.details }) : null,
      onRetry ? el('button', { class: 'btn btn-ghost btn-small', style: 'margin-top:10px', onclick: onRetry, text: 'Try again' }) : null,
    ]),
  ]);
}

/** Replaces a container's contents with a loading state, returning a done() helper. */
export function showLoading(container, rows = 4) {
  clear(container).append(skeleton({ rows }));
  return () => clear(container);
}
