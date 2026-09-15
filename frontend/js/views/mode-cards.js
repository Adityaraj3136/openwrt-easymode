import { icon } from '../icons.js';
import { badge, el } from '../ui.js';

/** The four setups, in consumer language. */
export const MODES = [
  {
    id: 'router',
    icon: 'globe',
    title: 'Router',
    blurb: 'Your internet comes in on a cable plugged into this router.',
    visual: [
      { glyph: 'globe', label: 'Internet' },
      { hop: 'cable' },
      { glyph: 'router', label: 'This router', accent: true },
      { hop: 'cable' },
      { glyph: 'devices', label: 'Devices' },
    ],
    action: 'Set up router',
  },
  {
    id: 'ap',
    icon: 'cable',
    title: 'Access Point',
    blurb: 'Extends your main router’s network over a cable.',
    visual: [
      { glyph: 'router', label: 'Main router' },
      { hop: 'cable' },
      { glyph: 'router', label: 'This router', accent: true },
      { hop: 'wireless' },
      { glyph: 'devices', label: 'Devices' },
    ],
    action: 'Set up access point',
  },
  {
    id: 'repeater',
    icon: 'wifi',
    title: 'Wi-Fi Repeater',
    blurb: 'Joins another Wi-Fi network and extends its coverage.',
    visual: [
      { glyph: 'wifi', label: 'Main Wi-Fi' },
      { hop: 'wireless' },
      { glyph: 'router', label: 'This router', accent: true },
      { hop: 'wireless' },
      { glyph: 'devices', label: 'Devices' },
    ],
    action: 'Set up repeater',
  },
  {
    id: 'hotspot',
    icon: 'smartphone',
    title: 'Mobile Hotspot',
    blurb: 'Uses your phone’s hotspot as the internet connection.',
    visual: [
      { glyph: 'smartphone', label: 'Phone' },
      { hop: 'wireless' },
      { glyph: 'router', label: 'This router', accent: true },
      { hop: 'cable' },
      { glyph: 'devices', label: 'Devices' },
    ],
    action: 'Connect phone',
  },
];

export const modeById = (id) => MODES.find((mode) => mode.id === id) ?? MODES[0];

function visual(parts) {
  return el(
    'div',
    { class: 'mode-visual' },
    parts.map((part) =>
      part.hop
        ? el('span', { class: `hop ${part.hop}`, 'aria-hidden': 'true' }, [
            part.hop === 'wireless' ? el('span', { text: ')))' }) : icon('chevronRight', { size: 16 }),
          ])
        : el('span', { class: `node${part.accent ? ' accent' : ''}`, title: part.label }, [icon(part.glyph, { size: 20 })]),
    ),
  );
}

/** One card in the 2x2 chooser. */
export function modeCard(mode, { current, available, onSelect }) {
  const action = available
    ? el('button', {
        class: current ? 'btn btn-ghost' : 'btn btn-primary',
        onclick: () => onSelect(mode.id),
        text: current ? 'Edit setup' : mode.action,
      })
    : el('button', { class: 'btn btn-ghost', disabled: true, text: 'Not available on this router' });

  return el('section', { class: `card hoverable mode-card-new${current ? ' current' : ''}` }, [
    current ? badge('Current', 'accent', { dot: false }) : null,
    visual(mode.visual),
    el('div', {}, [el('h3', { text: mode.title }), el('p', { text: mode.blurb })]),
    action,
  ]);
}
