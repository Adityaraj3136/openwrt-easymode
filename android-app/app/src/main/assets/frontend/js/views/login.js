import { api } from '../api.js';
import { clear, el, errorAlert } from '../ui.js';

const MODE_CHIPS = ['Router', 'Access Point', 'Wireless Repeater', 'Phone Hotspot'];

export function renderLogin(root, { defaultHost = '192.168.1.1', demoAvailable = false, onConnected }) {
  clear(root).className = '';

  const errorSlot = el('div');
  const submit = el('button', { class: 'btn btn-primary', type: 'submit' }, ['Connect to router']);

  const hostInput = el('input', { name: 'host', value: defaultHost, autocomplete: 'off', spellcheck: 'false', required: true });
  const userInput = el('input', { name: 'username', value: 'root', autocomplete: 'username', required: true });
  const passInput = el('input', { name: 'password', type: 'password', autocomplete: 'current-password' });

  const form = el(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        clear(errorSlot);
        submit.disabled = true;
        submit.textContent = 'Connecting…';
        try {
          const session = await api.login({
            host: hostInput.value.trim(),
            username: userInput.value.trim(),
            password: passInput.value,
          });
          passInput.value = '';
          onConnected(session);
        } catch (error) {
          errorSlot.append(errorAlert(error));
          submit.disabled = false;
          submit.textContent = 'Connect to router';
        }
      },
    },
    [
      el('div', { class: 'field' }, [
        el('label', { for: 'host', text: 'Router address' }),
        hostInput,
        el('span', { class: 'hint', text: 'The address you use to open your router settings.' }),
      ]),
      el('div', { class: 'field' }, [el('label', { text: 'Username' }), userInput]),
      el('div', { class: 'field' }, [el('label', { text: 'Password' }), passInput]),
      submit,
    ],
  );

  root.append(
    el('div', { class: 'login-wrap' }, [
      el('aside', { class: 'login-art' }, [
        el('div', { class: 'brand-text' }, [el('strong', { text: 'OpenWrt EasyMode' })]),
        el('div', {}, [
          el('h1', { text: 'Your router, without the networking jargon.' }),
          el('p', {
            text: 'Switch your OpenWrt device between the four setups people actually need, and see what it is doing right now.',
          }),
        ]),
        el('div', { class: 'mode-chips' }, MODE_CHIPS.map((label) => el('span', { text: label }))),
      ]),
      el('div', { class: 'login-panel' }, [
        el('div', { class: 'login-card' }, [
          el('h2', { text: 'Connect to your router' }),
          el('p', { class: 'sub', text: 'EasyMode talks to the router directly. Nothing is stored in your browser.' }),
          errorSlot,
          form,
          demoAvailable
            ? el('div', { class: 'demo-strip' }, [
                el('span', { text: 'No router to hand?' }),
                el('button', {
                  class: 'btn btn-ghost',
                  type: 'button',
                  onclick: async () => {
                    clear(errorSlot);
                    try {
                      onConnected(await api.login({ host: 'demo', username: 'demo', password: '' }));
                    } catch (error) {
                      errorSlot.append(errorAlert(error));
                    }
                  },
                  text: 'Explore with a simulated router',
                }),
              ])
            : null,
        ]),
      ]),
    ]),
  );

  (passInput.value ? submit : passInput).focus();
}
