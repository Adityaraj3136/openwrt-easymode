import { api } from '../api.js';
import { errorState, skeletonCards } from '../components.js';
import { icon } from '../icons.js';
import { clear, el, panel } from '../ui.js';

function diagnosticsPanel({ onUnauthorized }) {
  const errorSlot = el('div');
  const hostInput = el('input', { type: 'text', placeholder: 'e.g. 8.8.8.8 or google.com', value: '8.8.8.8' });
  const outputBox = el('pre', { class: 'mono', style: 'background:var(--bg);padding:12px;border-radius:6px;min-height:100px;overflow-x:auto;font-size:13px;white-space:pre-wrap;', text: 'Ready.\n' });

  const runButton = (label, fn) => {
    const btn = el('button', { class: 'btn btn-primary' }, [label]);
    btn.addEventListener('click', async () => {
      const host = hostInput.value.trim();
      if (!host) {
        outputBox.textContent = 'Please enter a host or IP address.';
        return;
      }
      
      clear(errorSlot);
      btn.disabled = true;
      outputBox.textContent = `Running ${label.toLowerCase()} to ${host}...\n`;
      
      try {
        const res = await fn(host);
        outputBox.textContent += res.output;
      } catch (error) {
        if (error.status === 401) return onUnauthorized();
        errorSlot.append(errorState(error));
        outputBox.textContent += `Failed: ${error.message}\n`;
      } finally {
        btn.disabled = false;
      }
    });
    return btn;
  };

  const pingBtn = runButton('Ping', api.ping);
  const traceBtn = runButton('Traceroute', api.traceroute);

  return panel({ icon: icon('settings', { size: 19 }), title: 'Network tools' }, [
    el('p', { class: 'empty', style: 'margin-bottom:14px', text: 'Use these tools to figure out why the internet is not working.' }),
    el('div', { class: 'field' }, [
      el('label', { text: 'Host or IP address' }),
      hostInput,
    ]),
    el('div', { class: 'button-row', style: 'margin-bottom:16px' }, [
      pingBtn,
      traceBtn
    ]),
    outputBox,
    errorSlot
  ]);
}

export function renderDiagnostics(container, { onUnauthorized }) {
  const head = el('div', { class: 'page-head' }, [
    el('div', {}, [
      el('h1', { text: 'Diagnostics' }),
      el('p', { text: 'Test your internet connection directly from the router.' }),
    ]),
  ]);
  const body = el('div', {}, [skeletonCards(1, 5)]);
  container.append(head, body);

  const load = () => {
    clear(body).append(
      el('div', { class: 'grid halves' }, [diagnosticsPanel({ onUnauthorized })])
    );
  };

  load();
  return () => {};
}
