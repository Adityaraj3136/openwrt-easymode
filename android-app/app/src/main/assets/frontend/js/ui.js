export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const clear = (node) => {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
};

export const dash = '—';

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return dash;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** key/value rows for a card. Values of null render as an em dash, never as fake data. */
export function kv(rows) {
  return el(
    'div',
    { class: 'kv' },
    rows
      .filter(Boolean)
      .map(([key, value, variant]) =>
        el('div', { class: 'row' }, [
          el('span', { class: 'k', text: key }),
          value instanceof Node
            ? value
            : el('span', {
                class: `v${variant ? ` ${variant}` : ''}${value == null || value === '' ? ' muted' : ''}`,
                text: value == null || value === '' ? dash : String(value),
              }),
        ]),
      ),
  );
}

/** Status chip in plain language. Tones: ok, warn, bad, accent, neutral. */
export function badge(text, tone = 'neutral', { dot = true, pulse = false } = {}) {
  return el('span', { class: `badge ${tone === 'neutral' ? '' : tone} ${pulse ? 'pulse-once' : ''}`.trim() }, [
    dot ? el('i', { class: 'dot' }) : null,
    el('span', { text }),
  ]);
}

/** Circular progress, used for the secondary health figures. */
export function ring(percent, { size = 62, tone } = {}) {
  const value = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
  const radius = (size - 7) / 2;
  const circumference = 2 * Math.PI * radius;
  const level = tone ?? (value >= 90 ? 'bad' : value >= 75 ? 'warn' : '');

  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  for (const [cls, offset] of [['track', 0], ['fill', circumference * (1 - value / 100)]]) {
    const circle = document.createElementNS(svgNs, 'circle');
    circle.setAttribute('class', cls === 'fill' ? `fill ${level}`.trim() : cls);
    circle.setAttribute('cx', String(size / 2));
    circle.setAttribute('cy', String(size / 2));
    circle.setAttribute('r', String(radius));
    if (cls === 'fill') {
      circle.setAttribute('stroke-dasharray', String(circumference));
      circle.setAttribute('stroke-dashoffset', String(offset));
    }
    svg.append(circle);
  }

  return el('div', { class: 'ring' }, [
    svg,
    el('span', { class: 'ring-value', text: Number.isFinite(percent) ? `${Math.round(percent)}%` : dash }),
  ]);
}

// Live views re-render on a timer, which would otherwise snap every open section
// shut mid-read. Open state is remembered per key for the life of the page.
const openDisclosures = new Set();

/** Progressive disclosure: everything technical hides behind one of these. */
export function disclosure(summaryText, content, { open = false, key = null } = {}) {
  const isOpen = key ? openDisclosures.has(key) : open;
  const details = el('details', { class: `disclosure ${isOpen ? 'reopen' : ''}`, open: isOpen || false }, [
    el('summary', {}, [chevron(), el('span', { text: summaryText })]),
    el('div', { class: 'body' }, [].concat(content).filter(Boolean)),
  ]);
  if (key) {
    details.addEventListener('toggle', () => {
      if (details.open) {
        openDisclosures.add(key);
        details.classList.remove('reopen');
      } else {
        openDisclosures.delete(key);
      }
    });
  }
  return details;
}

let chevronFactory = null;
export function setChevronFactory(factory) {
  chevronFactory = factory;
}
const chevron = () => (chevronFactory ? chevronFactory() : el('span', { text: '›' }));

export const formatMbps = (bytesPerSecond) => {
  if (!Number.isFinite(bytesPerSecond)) return null;
  const mbps = (bytesPerSecond * 8) / 1_000_000;
  if (mbps >= 100) return `${Math.round(mbps)}`;
  if (mbps >= 10) return mbps.toFixed(1);
  return mbps.toFixed(2);
};

export function pill(text, tone = 'neutral', { dot = true } = {}) {
  const classes = { ok: 'pill ok', bad: 'pill bad', warn: 'pill warn', neutral: 'pill' };
  return el('span', { class: classes[tone] ?? classes.neutral }, [
    dot ? el('i', { class: 'dot' }) : null,
    el('span', { text }),
  ]);
}

export function meter(percent) {
  const value = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
  const tone = value >= 90 ? 'bad' : value >= 75 ? 'warn' : '';
  return el('div', { class: 'meter' }, [el('i', { class: tone, style: `width:${value}%` })]);
}

export function card(title, children, extraClass = '') {
  return el('section', { class: `card ${extraClass}`.trim() }, [
    title ? el('h3', {}, [].concat(title)) : null,
    ...[].concat(children).filter(Boolean),
  ]);
}

/** Card with an icon, a real heading and optional trailing content. */
export function panel({ icon: iconNode, title, trailing, className = '' }, children) {
  return el('section', { class: `card ${className}`.trim() }, [
    title
      ? el('div', { class: 'card-title' }, [
          iconNode ? el('div', { class: 'card-icon' }, [iconNode]) : null,
          el('h2', { text: title }),
          el('span', { class: 'spacer' }),
          ...[].concat(trailing ?? []).filter(Boolean),
        ])
      : null,
    ...[].concat(children).filter(Boolean),
  ]);
}

export function errorAlert(error) {
  return el('div', { class: 'alert' }, [
    el('span', { text: error.message }),
    error.details ? el('span', { class: 'detail', text: error.details }) : null,
  ]);
}

export const signalText = (dbm) => (Number.isFinite(dbm) && dbm !== 0 ? `${dbm} dBm` : null);

export function select(options, selectedValue, extra = {}) {
  let currentValue = String(selectedValue ?? options[0]?.value ?? '');
  const getLabel = (v) => options.find(o => String(o.value) === String(v))?.label ?? v;

  const displayLabel = el('span', { text: getLabel(currentValue) });
  const display = el('div', { class: 'custom-select-display' }, [
    displayLabel,
    el('span', { class: 'custom-select-arrow', html: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>' })
  ]);
  
  const dropdown = el('div', { class: 'custom-select-dropdown' }, 
    options.map(opt => {
      const item = el('div', { class: `custom-select-option ${String(opt.value) === currentValue ? 'selected' : ''}`.trim(), text: opt.label });
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        currentValue = String(opt.value);
        displayLabel.textContent = opt.label;
        wrapper.classList.remove('open');
        dropdown.querySelectorAll('.custom-select-option').forEach(el => el.classList.remove('selected'));
        item.classList.add('selected');
        wrapper.dispatchEvent(new Event('change', { bubbles: true }));
      });
      return item;
    })
  );

  const wrapper = el('div', { class: `custom-select ${extra.class || ''}`.trim() }, [display, dropdown]);
  for (const [k, v] of Object.entries(extra)) {
    if (k !== 'class' && !k.startsWith('on')) wrapper.setAttribute(k, v);
    if (k.startsWith('on') && typeof v === 'function') wrapper.addEventListener(k.slice(2).toLowerCase(), v);
  }

  Object.defineProperty(wrapper, 'value', {
    get: () => currentValue,
    set: (v) => {
      currentValue = String(v);
      displayLabel.textContent = getLabel(currentValue);
      dropdown.querySelectorAll('.custom-select-option').forEach(el => el.classList.remove('selected'));
      const idx = options.findIndex(o => String(o.value) === currentValue);
      if (idx >= 0) dropdown.children[idx].classList.add('selected');
    }
  });

  display.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.custom-select.open').forEach(el => { if (el !== wrapper) el.classList.remove('open'); });
    wrapper.classList.toggle('open');
  });

  document.addEventListener('click', (e) => {
    if (!wrapper.contains(e.target)) wrapper.classList.remove('open');
  });

  return wrapper;
}
