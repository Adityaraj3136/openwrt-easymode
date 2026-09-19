/**
 * Lucide-style stroke icons, hand-authored so the set stays consistent and needs no
 * network fetch: 24x24 box, 1.75 stroke, round caps and joins.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';

const PATHS = {
  dashboard: ['<rect x="3" y="3" width="7" height="8" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="11" width="7" height="10" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>'],
  router: ['<rect x="3" y="13" width="18" height="8" rx="2"/><path d="M7 17h.01M11 17h.01"/><path d="M12 13V9"/><path d="M8.5 6.5a5 5 0 0 1 7 0"/><path d="M6 4a8 8 0 0 1 12 0"/>'],
  wifi: ['<path d="M2.5 8.5a16 16 0 0 1 19 0"/><path d="M5.5 12.2a11 11 0 0 1 13 0"/><path d="M8.5 15.9a6 6 0 0 1 7 0"/><path d="M12 20h.01"/>'],
  network: ['<rect x="9" y="3" width="6" height="5" rx="1.5"/><rect x="2" y="16" width="6" height="5" rx="1.5"/><rect x="16" y="16" width="6" height="5" rx="1.5"/><path d="M12 8v4M5 16v-2h14v2"/>'],
  gauge: ['<path d="M4 17a8.5 8.5 0 1 1 16 0"/><path d="M12 17l4-5"/><circle cx="12" cy="17" r="1.2"/>'],
  settings: ['<circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'],
  globe: ['<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z"/>'],
  laptop: ['<rect x="4" y="5" width="16" height="10" rx="1.5"/><path d="M2 19h20"/>'],
  smartphone: ['<rect x="7" y="2" width="10" height="20" rx="2.5"/><path d="M11 18h2"/>'],
  cable: ['<path d="M4 4v5a3 3 0 0 0 3 3h10a3 3 0 0 1 3 3v5"/><path d="M2 4h4M18 20h4"/>'],
  cpu: ['<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 2v3M14 2v3M10 19v3M14 19v3M2 10h3M2 14h3M19 10h3M19 14h3"/>'],
  memory: ['<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 17v3M12 17v3M17 17v3"/>'],
  clock: ['<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'],
  check: ['<path d="M20 6.5L9.5 17L4 11.5"/>'],
  checkCircle: ['<circle cx="12" cy="12" r="9"/><path d="M8.5 12.2l2.4 2.4l4.6-4.9"/>'],
  alert: ['<path d="M12 3.5L22 19H2z"/><path d="M12 9.5v4M12 16.5h.01"/>'],
  xCircle: ['<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>'],
  chevronRight: ['<path d="M9 5l7 7l-7 7"/>'],
  chevronDown: ['<path d="M5 9l7 7l7-7"/>'],
  chevronLeft: ['<path d="M15 5l-7 7l7 7"/>'],
  logout: ['<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 16l4-4l-4-4"/><path d="M14 12H3"/>'],
  refresh: ['<path d="M20 11a8 8 0 0 0-13.7-5.2L3 9"/><path d="M4 13a8 8 0 0 0 13.7 5.2L21 15"/><path d="M3 4v5h5M21 20v-5h-5"/>'],
  arrowDown: ['<path d="M12 4v15"/><path d="M6 13l6 6l6-6"/>'],
  arrowUp: ['<path d="M12 20V5"/><path d="M6 11l6-6l6 6"/>'],
  plus: ['<path d="M12 5v14M5 12h14"/>'],
  trash: ['<path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7l1 13h10l1-13"/>'],
  pencil: ['<path d="M4 20h4L20 8l-4-4L4 16z"/><path d="M14 6l4 4"/>'],
  shield: ['<path d="M12 3l8 3v6c0 4.5-3.2 8.3-8 9.5C7.2 20.3 4 16.5 4 12V6z"/><path d="M9 12l2 2l4-4"/>'],
  power: ['<path d="M12 3v9"/><path d="M7 6.5a8 8 0 1 0 10 0"/>'],
  download: ['<path d="M12 3v12"/><path d="M7 11l5 5l5-5"/><path d="M4 20h16"/>'],
  upload: ['<path d="M12 21V9"/><path d="M7 13l5-5l5 5"/><path d="M4 4h16"/>'],
  devices: ['<rect x="3" y="5" width="12" height="9" rx="1.5"/><path d="M2 18h14"/><rect x="17" y="9" width="5" height="10" rx="1.5"/>'],
  lock: ['<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>'],
  signal: ['<path d="M4 18v-3M9 18v-6M14 18v-9M19 18V6"/>'],
  external: ['<path d="M14 4h6v6"/><path d="M20 4l-8 8"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>'],
  menu: ['<path d="M4 7h16M4 12h16M4 17h16"/>'],
  close: ['<path d="M6 6l12 12M18 6L6 18"/>'],
  save: ['<path d="M5 4h11l3 3v13H5z"/><path d="M9 4v5h6V4"/><rect x="8" y="13" width="8" height="7"/>'],
  zap: ['<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>'],
  info: ['<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'],
};

export function icon(name, { size = 20, className = '' } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  svg.innerHTML = (PATHS[name] ?? PATHS.info).join('');
  return svg;
}
