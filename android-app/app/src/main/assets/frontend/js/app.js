import { api } from './api.js';
import { icon } from './icons.js';
import { badge, clear, el, setChevronFactory } from './ui.js';
import { renderBandwidth } from './views/bandwidth.js';
import { renderDashboard } from './views/dashboard.js';
import { renderDhcp } from './views/dhcp.js';
import { renderDiagnostics } from './views/diagnostics.js';
import { renderLogin } from './views/login.js';
import { renderModeSetup } from './views/mode.js';
import { renderSystem } from './views/system.js';
import { renderWifi } from './views/wifi.js';

setChevronFactory(() => icon('chevronRight', { size: 15 }));

const root = document.getElementById('root');

const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { id: 'mode', label: 'Mode Setup', icon: 'router' },
  { id: 'wifi', label: 'Wi-Fi', icon: 'wifi' },
  { id: 'dhcp', label: 'DHCP', icon: 'network' },
  { id: 'bandwidth', label: 'Bandwidth', icon: 'gauge' },
  { id: 'diagnostics', label: 'Diagnostics', icon: 'alert' },
  { id: 'system', label: 'System', icon: 'settings' },
];

const state = { session: null, cleanup: null, view: 'dashboard', boot: {}, online: true };

const currentView = () => {
  const id = location.hash.replace('#/', '') || 'dashboard';
  return NAV.some((item) => item.id === id) ? id : 'dashboard';
};

function accountMenu(session) {
  const wrap = el('div', { class: 'account' });
  const toggle = el('button', { class: 'account-toggle', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, [
    el('span', { class: 'avatar', text: (session.username ?? 'A').slice(0, 2).toUpperCase() }),
    el('span', { text: session.username ?? 'Admin' }),
    icon('chevronDown', { size: 15 }),
  ]);

  let menu = null;
  const close = () => {
    menu?.remove();
    menu = null;
    toggle.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onOutside, true);
  };
  const onOutside = (event) => {
    if (!wrap.contains(event.target)) close();
  };

  toggle.addEventListener('click', () => {
    if (menu) return close();
    menu = el('div', { class: 'account-menu', role: 'menu' }, [
      el('div', { class: 'meta' }, [
        el('strong', { text: session.router?.model ?? 'OpenWrt router' }),
        el('span', { text: `${session.username}@${session.host}` }),
      ]),
      el('a', { href: `http://${session.host}/cgi-bin/luci`, target: '_blank', rel: 'noopener' }, [
        icon('external', { size: 17 }),
        el('span', { text: 'Advanced settings' }),
      ]),
      el('button', {
        onclick: async () => {
          close();
          await api.logout().catch(() => {});
          showLogin();
        },
      }, [icon('logout', { size: 17 }), el('span', { text: 'Sign out' })]),
    ]);
    wrap.append(menu);
    toggle.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', onOutside, true);
  });

  wrap.append(toggle);
  return wrap;
}

function shell(session) {
  const main = el('main', { class: 'main', id: 'main', tabindex: '-1' });

  // ── Top nav links (desktop) ─────────────────────────────
  const navLinks = NAV.map((item) =>
    el(
      'a',
      {
        href: `#/${item.id}`,
        class: `nav-link${item.id === state.view ? ' active' : ''}`,
        'aria-current': item.id === state.view ? 'page' : false,
      },
      [icon(item.icon, { size: 18 }), el('span', { text: item.label })],
    ),
  );
  const nav = el('div', { class: 'navbar-inner' }, navLinks);

  const navToggle = el('button', { class: 'btn btn-ghost btn-small nav-toggle', 'aria-label': 'Menu' }, [
    icon('menu', { size: 18 }),
  ]);
  navToggle.addEventListener('click', () => nav.classList.toggle('open'));
  nav.addEventListener('click', (event) => {
    if (event.target.closest('.nav-link')) nav.classList.remove('open');
  });

  // ── Bottom nav bar (mobile) ─────────────────────────────
  // Show only 5 most important items to avoid cramping
  const BOTTOM_NAV = [
    { id: 'dashboard', label: 'Home', icon: 'dashboard' },
    { id: 'wifi',      label: 'Wi-Fi', icon: 'wifi' },
    { id: 'dhcp',      label: 'Devices', icon: 'network' },
    { id: 'mode',      label: 'Mode', icon: 'router' },
    { id: 'system',    label: 'System', icon: 'settings' },
  ];
  const bottomNavItems = BOTTOM_NAV.map((item) =>
    el('a', {
      href: `#/${item.id}`,
      class: `bottom-nav-item${item.id === state.view ? ' active' : ''}`,
      'aria-label': item.label,
    }, [icon(item.icon, { size: 22 }), el('span', { text: item.label })]),
  );
  const bottomNav = el('nav', { class: 'bottom-nav', 'aria-label': 'Main navigation' }, bottomNavItems);

  const statusBadge = badge(state.online ? 'Router online' : 'Router not answering', state.online ? 'ok' : 'bad');

  const app = el('div', { class: 'app' }, [
    el('header', { class: 'appbar' }, [
      el('div', { class: 'appbar-inner' }, [
        navToggle,
        el('a', { class: 'brand', href: '#/dashboard' }, [
          el('span', { class: 'brand-mark' }, [icon('router', { size: 21 })]),
          el('span', { class: 'brand-text' }, [
            el('strong', { text: 'EasyMode' }),
            el('span', { text: 'OpenWrt made simple' }),
          ]),
        ]),
        el('span', { class: 'appbar-spacer' }),
        el('div', { class: 'appbar-right' }, [
          el('div', { class: 'router-chip', id: 'router-chip' }, [
            statusBadge,
            el('span', { class: 'name', text: session.router?.model ?? session.host }),
          ]),
          accountMenu(session),
        ]),
      ]),
    ]),
    el('nav', { class: 'navbar', 'aria-label': 'Sections' }, [nav]),
    session.demo
      ? el('div', { class: 'demo-ribbon' }, [
          icon('info', { size: 15 }),
          el('span', { text: 'Demo mode — this is a simulated router, no hardware is being changed.' }),
        ])
      : null,
    main,
    bottomNav,
  ]);

  clear(root).className = '';
  root.append(el('a', { class: 'skip-link', href: '#main', text: 'Skip to content' }), app);
  return main;
}


/** Views report reachability so the header badge reflects reality. */
function setOnline(online) {
  if (state.online === online) return;
  state.online = online;
  const chip = document.getElementById('router-chip');
  if (!chip) return;
  const fresh = badge(online ? 'Router online' : 'Router not answering', online ? 'ok' : 'bad', { pulse: true });
  chip.replaceChild(fresh, chip.firstChild);
}

const VIEWS = {
  dashboard: (main) =>
    renderDashboard(main, {
      onChangeMode: () => {
        location.hash = '#/mode';
      },
      onUnauthorized: showLogin,
      onReachability: setOnline,
    }),
  mode: (main, context) => renderModeSetup(main, { session: context, onUnauthorized: showLogin }),
  wifi: (main) => renderWifi(main, { onUnauthorized: showLogin }),
  dhcp: (main) => renderDhcp(main, { onUnauthorized: showLogin }),
  bandwidth: (main) => renderBandwidth(main, { onUnauthorized: showLogin }),
  diagnostics: (main) => renderDiagnostics(main, { onUnauthorized: showLogin }),
  system: (main) => renderSystem(main, { onUnauthorized: showLogin, onLoggedOut: showLogin }),
};

function mount() {
  if (!state.session) return;
  state.cleanup?.();
  state.view = currentView();
  const main = shell(state.session);
  const context = { ...state.session, luciUrl: `http://${state.session.host}/cgi-bin/luci` };
  state.cleanup = VIEWS[state.view](main, context);
  document.title = `${NAV.find((item) => item.id === state.view).label} · EasyMode`;
}

function showLogin() {
  state.cleanup?.();
  state.cleanup = null;
  state.session = null;
  document.title = 'EasyMode';
  renderLogin(root, {
    defaultHost: state.boot.defaultRouterHost ?? '192.168.1.1',
    demoAvailable: state.boot.demoAvailable ?? false,
    onConnected: (session) => {
      state.session = session;
      state.online = true;
      location.hash = '#/dashboard';
      mount();
    },
  });
}

window.addEventListener('hashchange', () => {
  if (state.session) mount();
});

async function boot() {
  state.boot = await api.bootConfig().catch(() => ({ defaultRouterHost: '192.168.1.1' }));
  try {
    state.session = await api.session();
    mount();
  } catch {
    showLogin();
  }
}

boot();
