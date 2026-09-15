import { Uci, findSections } from './uci.js';
import { snapshotConfigs } from './backup.js';
import { commitWithRollback } from './apply.js';
import { listRadios } from './wireless.js';

export async function getGuestStatus(client) {
  const network = (await client.uciGet('network')) ?? {};
  const wireless = (await client.uciGet('wireless')) ?? {};

  let ssid = 'Guest Network';
  let key = '';
  let encryption = 'psk2';
  let ipaddr = network.guest?.ipaddr ?? '192.168.22.1';
  let isolate = true;
  let hidden = false;

  const guestInterfaces = Object.values(wireless).filter(
    (s) => s['.type'] === 'wifi-iface' && s.network === 'guest'
  );

  let enabled = false;
  if (guestInterfaces.length > 0) {
    enabled = guestInterfaces.some(i => i.disabled !== '1');
    ssid = guestInterfaces[0].ssid ?? ssid;
    key = guestInterfaces[0].key ?? key;
    encryption = guestInterfaces[0].encryption ?? encryption;
    isolate = guestInterfaces[0].isolate !== '0';
    hidden = guestInterfaces[0].hidden === '1';
  }

  return { enabled, ssid, key, encryption, ipaddr, isolate, hidden };
}

export async function updateGuest(client, session, { enabled, ssid, key, encryption, ipaddr, isolate, hidden }) {
  const snapshot = await snapshotConfigs(client, ['network', 'wireless', 'firewall', 'dhcp']);
  const uci = new Uci(client);

  const network = (await client.uciGet('network')) ?? {};
  
  let guestIp = ipaddr || '192.168.22.1';
  const { subnetsOverlap, pickSafeLan } = await import('./net.js');
  
  // Collect all other network subnets to avoid collisions
  const existingSubnets = Object.entries(network)
    .filter(([name, sec]) => name !== 'guest' && sec.ipaddr && sec.netmask)
    .map(([_, sec]) => ({ ip: sec.ipaddr, mask: sec.netmask }));

  const conflict = existingSubnets.some((sn) => subnetsOverlap({ ip: guestIp, mask: '255.255.255.0' }, sn));
  if (conflict) {
    const safe = pickSafeLan(existingSubnets, null, '255.255.255.0');
    if (safe) guestIp = safe;
  }

  // Always write guest network interface (not just on first create).
  // NOTE: Do NOT set type:'bridge' — on MediaTek MT7986 (and most OpenWrt drivers)
  // netifd bridges the Wi-Fi AP interface automatically via the wifi-iface 'network' option.
  // Adding type:'bridge' makes netifd try to create br-guest, which the MTK driver refuses,
  // leaving the interface down and DHCP broken.
  const existingGuest = await uci.get('network', 'guest');
  if (existingGuest) {
    await uci.set('network', 'guest', {
      proto: 'static',
      ipaddr: guestIp,
      netmask: '255.255.255.0',
    });
  } else {
    await uci.add('network', 'interface', {
      proto: 'static',
      ipaddr: guestIp,
      netmask: '255.255.255.0',
    }, 'guest');
  }

  // Always write guest DHCP server.
  const existingDhcp = await uci.get('dhcp', 'guest');
  if (existingDhcp) {
    await uci.set('dhcp', 'guest', {
      interface: 'guest',
      start: '100',
      limit: '150',
      leasetime: '12h',
      ignore: '0',
    });
  } else {
    await uci.add('dhcp', 'dhcp', {
      interface: 'guest',
      start: '100',
      limit: '150',
      leasetime: '12h',
      ignore: '0',
    }, 'guest');
  }

  const radios = await listRadios(client);
  const wireless = (await client.uciGet('wireless')) ?? {};

  // Firewall: ensure guest zone, forwarding, and DNS/DHCP allow rules.
  const firewall = (await client.uciGet('firewall')) ?? {};
  const guestZone = Object.values(firewall).find((s) => s['.type'] === 'zone' && s.name === 'guest');
  if (!guestZone) {
    await uci.add('firewall', 'zone', { name: 'guest', network: ['guest'], input: 'REJECT', output: 'ACCEPT', forward: 'REJECT' });
  }
  const hasForward = Object.values(firewall).some((s) => s['.type'] === 'forwarding' && s.src === 'guest' && s.dest === 'wan');
  if (!hasForward) await uci.add('firewall', 'forwarding', { src: 'guest', dest: 'wan' });
  const hasDns = Object.values(firewall).some((s) => s['.type'] === 'rule' && s.name === 'Guest_DNS');
  if (!hasDns) await uci.add('firewall', 'rule', { name: 'Guest_DNS', src: 'guest', dest_port: '53', proto: 'tcp udp', target: 'ACCEPT' });
  const hasDhcpRule = Object.values(firewall).some((s) => s['.type'] === 'rule' && s.name === 'Guest_DHCP');
  if (!hasDhcpRule) await uci.add('firewall', 'rule', { name: 'Guest_DHCP', src: 'guest', dest_port: '67', proto: 'udp', target: 'ACCEPT' });

  // Track which radios get the guest AP so we reload only those (not the STA uplink radio).
  const guestRadios = [];

  for (const radio of radios) {
    // If this radio is actively being used as a repeater uplink (STA mode), skip adding a
    // guest AP on it. The MediaTek MT7986 chip (and most hw) cannot run AP+STA+AP concurrently.
    // The 5GHz band will simply not get a guest AP when it's the repeater link.
    const hasSta = radio.interfaces.some((i) => i.mode === 'sta' && !i.disabled);
    if (hasSta) {
      // Clean up any existing guest section on this radio to avoid conflicts.
      const existingGuestOnSta = Object.entries(wireless).find(
        ([_, s]) => s['.type'] === 'wifi-iface' && s.device === radio.id && s.network === 'guest'
      );
      if (existingGuestOnSta) await uci.delete('wireless', existingGuestOnSta[0]);
      continue;
    }

    guestRadios.push(radio.id); // e.g. 'radio0'

    const guestSection = Object.entries(wireless).find(([_, s]) => s['.type'] === 'wifi-iface' && s.device === radio.id && s.network === 'guest');
    const updates = {
      mode: 'ap',
      network: 'guest',
      ssid: ssid ?? 'Guest Network',
      encryption: encryption ?? 'psk2',
      key: key ?? '',
      disabled: enabled ? '0' : '1',
      isolate: isolate === false ? '0' : '1',
      hidden: hidden ? '1' : '0',
    };

    if (encryption === 'none') delete updates.key;

    if (!guestSection) {
      updates.device = radio.id;
      await uci.add('wireless', 'wifi-iface', updates);
    } else {
      if (encryption === 'none') await uci.clearOptions('wireless', guestSection[0], ['key']);
      const { key: _k, ...updatesNoKey } = updates;
      await uci.set('wireless', guestSection[0], updatesNoKey);
      if (encryption !== 'none' && key) await uci.set('wireless', guestSection[0], { key });
    }
  }

  await commitWithRollback({ client, session, uci, snapshot, settleMs: 2000 });

  // Reload only the radios that host the guest AP (not the STA uplink radio).
  // Using `wifi reload radio0` instead of `wifi reload` avoids restarting the 5GHz STA
  // (which would drop internet) and prevents unnecessary disruption to other radios.
  // On JioRouter MT7986, `network.wireless` ubus doesn't exist, so we use file.exec.
  if (guestRadios.length > 0) {
    for (const radioId of guestRadios) {
      await client.tryCall('file', 'exec', { command: '/sbin/wifi', params: ['reload', radioId] });
    }
  } else {
    // Fallback: full reload if no guest radios were identified
    await client.tryCall('file', 'exec', { command: '/sbin/wifi', params: ['reload'] });
  }
  await client.tryCall('network.wireless', 'reload', {}); // standard OpenWrt fallback

  // Wait for hostapd to create the AP, then explicitly ask netifd to bring up guest
  await new Promise(resolve => setTimeout(resolve, 5000));
  await client.tryCall('network.interface.guest', 'up', {});

  return await getGuestStatus(client);
}
