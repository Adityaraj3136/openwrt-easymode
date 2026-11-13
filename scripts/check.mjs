import assert from 'node:assert/strict';
import {
  bandFromFrequency,
  bandFromUci,
  channelCongestion,
  channelWidthOptions,
  cpuUsageFromSamples,
  detectMode,
  encryptionLabel,
  formatUptime,
  internetSourceLabel,
  parseDhcpLeases,
  parseHtmode,
  parseProcStat,
  scanEncryption,
  signalQuality,
  uciBool,
} from '../backend/lib/derive.js';
import { parseWirelessUplinkOptions } from '../backend/lib/modes/wireless-uplink.js';
import { parseRadioSettings } from '../backend/lib/wifi-config.js';
import { normalizeMac, planRange, validateReservation } from '../backend/lib/dhcp.js';
import { parseNlbwJson, rateBetween } from '../backend/lib/bandwidth.js';
import { BACKUP_FORMAT, validateBackup } from '../backend/lib/system.js';
import { isPrivateIPv4, normalizeRouterHost } from '../backend/lib/host.js';
import {
  bitsToMask,
  hostInSubnet,
  maskToBits,
  pickManagementAddress,
  pickSafeLan,
  subnetsOverlap,
} from '../backend/lib/net.js';
import { parseApOptions } from '../backend/lib/modes/ap.js';
import { parseRouterOptions } from '../backend/lib/modes/router.js';
import { Uci, asList, findSection, findSections } from '../backend/lib/uci.js';
import { byNetworkName, mergeScanResults, normalizeScanEntry, sortScanResults } from '../backend/lib/wifi-scan.js';
import { blockingSupport, listBlocks } from '../backend/lib/clients.js';
import { getIpv6Status, lanServesIpv6 } from '../backend/lib/ipv6.js';

// --- band derivation (radio0/radio1 must never imply a band) -----------------
assert.equal(bandFromFrequency(2437), '2.4');
assert.equal(bandFromFrequency(5180), '5');
assert.equal(bandFromFrequency(6115), '6');
assert.equal(bandFromFrequency(0), null);
assert.equal(bandFromUci({ band: '5g' }), '5');
assert.equal(bandFromUci({ hwmode: '11a' }), '5');
assert.equal(bandFromUci({ hwmode: '11g' }), '2.4');
assert.equal(bandFromUci({ channel: '36' }), '5');
assert.equal(bandFromUci({}), null);

// --- UCI booleans -------------------------------------------------------------
// "0" is a truthy string, so Boolean(section.disabled) reports a working radio as off.
assert.equal(uciBool('0'), false);
assert.equal(uciBool('1'), true);
assert.equal(uciBool(''), false);
assert.equal(uciBool(undefined), false);
assert.equal(uciBool(false), false);
assert.equal(uciBool(true), true);
assert.equal(uciBool('true'), true);

// --- CPU sampling ------------------------------------------------------------
const stat1 = parseProcStat('cpu  100 0 100 800 0 0 0 0\ncpu0 1 2 3\n');
const stat2 = parseProcStat('cpu  150 0 150 900 0 0 0 0\n');
assert.deepEqual(stat1, { idle: 800, total: 1000 });
assert.equal(cpuUsageFromSamples(null, stat2), null, 'first sample yields no percentage');
assert.equal(cpuUsageFromSamples(stat1, stat2), 50);
assert.equal(cpuUsageFromSamples(stat2, stat1), null, 'counter going backwards is ignored');
assert.equal(parseProcStat('nonsense'), null);

// --- DHCP leases -------------------------------------------------------------
const now = 1_700_000_000_000;
const leases = parseDhcpLeases(
  ['1700000600 aa:bb:cc:dd:ee:ff 192.168.1.120 laptop *', '1699999000 11:22:33:44:55:66 192.168.1.130 * *'].join('\n'),
  now,
);
assert.equal(leases.length, 2);
assert.equal(leases[0].hostname, 'laptop');
assert.equal(leases[0].active, true);
assert.equal(leases[1].hostname, null, 'dnsmasq "*" hostname is not a device name');
assert.equal(leases[1].active, false, 'expired lease is not an active client');
assert.deepEqual(parseDhcpLeases(null), []);

// --- mode detection ----------------------------------------------------------
const routerMode = detectMode({ wanUp: true, wanDevice: 'eth0', lanDhcpDisabled: false });
assert.equal(routerMode.id, 'router');
assert.equal(routerMode.source, 'detected');

const apMode = detectMode({ wanUp: false, lanDhcpDisabled: true, lanHasGateway: true });
assert.equal(apMode.id, 'ap');

const repeater = detectMode({ staUplink: { connected: true, ssid: 'Home' }, wanUp: false });
assert.equal(repeater.id, 'repeater');

// Repeater and hotspot look identical on the wire; stored intent breaks the tie.
const hotspot = detectMode({ storedMode: 'hotspot', staUplink: { connected: true, ssid: 'Pixel' } });
assert.equal(hotspot.id, 'hotspot');
assert.equal(hotspot.source, 'stored');

// Stale stored mode must not override what the router actually does.
const stale = detectMode({ storedMode: 'ap', wanUp: true, wanDevice: 'eth1' });
assert.equal(stale.id, 'router');
assert.equal(stale.matchesStored, false);

assert.equal(detectMode({}).id, 'unknown');
assert.equal(internetSourceLabel('repeater', { staSsid: 'Home' }), 'Wi-Fi network "Home"');
assert.equal(internetSourceLabel('ap'), 'Main router via Ethernet');
assert.match(internetSourceLabel('router', { wanProto: 'pppoe', wanDevice: 'eth0' }), /PPPOE/);

// --- host validation (keeps the backend off the public internet) -------------
assert.equal(isPrivateIPv4('192.168.1.1'), true);
assert.equal(isPrivateIPv4('172.16.0.1'), true);
assert.equal(isPrivateIPv4('172.32.0.1'), false);
assert.equal(isPrivateIPv4('8.8.8.8'), false);
assert.equal(normalizeRouterHost(' 192.168.8.1 '), '192.168.8.1');
assert.equal(normalizeRouterHost('OpenWrt.lan'), 'openwrt.lan');
assert.throws(() => normalizeRouterHost('8.8.8.8'), /HOST_NOT_ALLOWED|outside the private/);
assert.throws(() => normalizeRouterHost('not a host'), /not a valid/);
assert.throws(() => normalizeRouterHost(''), /not a valid/);

// --- misc formatting ---------------------------------------------------------
assert.equal(formatUptime(90061), '1d 1h 1m');
assert.equal(formatUptime(3600), '1h 0m');
assert.equal(formatUptime(-1), null);
assert.equal(signalQuality(-50).level, 'excellent');
assert.equal(signalQuality(-80).level, 'weak');
assert.equal(signalQuality(0), null);

// --- subnet conflicts (phase 3: WAN and LAN must not overlap) ----------------
assert.equal(maskToBits('255.255.255.0'), 24);
assert.equal(maskToBits('255.255.0.0'), 16);
assert.equal(maskToBits('24'), 24);
assert.equal(maskToBits('255.0.255.0'), null, 'non-contiguous mask is rejected');
assert.equal(bitsToMask(24), '255.255.255.0');

assert.equal(
  subnetsOverlap({ ip: '192.168.1.1', mask: '255.255.255.0' }, { ip: '192.168.1.50', mask: '255.255.255.0' }),
  true,
  'the classic upstream-router clash',
);
assert.equal(
  subnetsOverlap({ ip: '192.168.1.1', mask: '255.255.255.0' }, { ip: '192.168.8.1', mask: '255.255.255.0' }),
  false,
);
// A /16 upstream swallows the /24 below it.
assert.equal(
  subnetsOverlap({ ip: '192.168.1.1', mask: '255.255.255.0' }, { ip: '192.168.200.1', mask: '255.255.0.0' }),
  true,
);

assert.equal(pickSafeLan([{ ip: '192.168.1.10', mask: '255.255.255.0' }]), '192.168.8.1');
assert.equal(
  pickSafeLan([{ ip: '192.168.8.5', mask: '255.255.255.0' }], '192.168.1.1'),
  '192.168.1.1',
  'a preferred address that does not clash is kept',
);
assert.equal(
  pickSafeLan([{ ip: '192.168.8.5', mask: '255.255.255.0' }], '192.168.8.1'),
  '192.168.9.1',
  'a preferred address that clashes is replaced',
);
assert.equal(pickSafeLan([{ ip: '10.0.0.1', mask: '255.0.0.0' }], null), '192.168.8.1');
assert.equal(hostInSubnet('192.168.8.1', '255.255.255.0', 100), '192.168.8.100');

// --- Router Mode option validation ------------------------------------------
const auto = parseRouterOptions({ connection: 'auto' });
assert.equal(auto.connection, 'auto');
assert.equal(auto.lan.leasetime, '12h');
assert.equal(auto.wifi.enabled, false);

const pppoe = parseRouterOptions({ connection: 'pppoe', pppoe: { username: 'user@isp', password: 'x' } });
assert.equal(pppoe.pppoe.username, 'user@isp');
assert.throws(() => parseRouterOptions({ connection: 'pppoe', pppoe: {} }), /username/i);

const staticCfg = parseRouterOptions({
  connection: 'static',
  static: { ip: '203.0.113.10', netmask: '255.255.255.0', gateway: '203.0.113.1', dns: '1.1.1.1, 8.8.8.8' },
});
assert.deepEqual(staticCfg.static.dns, ['1.1.1.1', '8.8.8.8']);
assert.throws(() => parseRouterOptions({ connection: 'static', static: { ip: 'nope' } }), /not a valid IP/);
assert.throws(
  () => parseRouterOptions({ connection: 'static', static: { ip: '203.0.113.10', netmask: '255.255.255.0' } }),
  /not a valid IP/,
  'a static WAN without a gateway is refused',
);
assert.throws(() => parseRouterOptions({ connection: 'bridge' }), /Choose one of/);
assert.throws(() => parseRouterOptions({ connection: 'auto', lan: { leasetime: 'forever' } }), /Lease time/);

const withWifi = parseRouterOptions({ connection: 'auto', wifi: { enabled: true, ssid: 'Home', key: 'longenough' } });
assert.equal(withWifi.wifi.encryption, 'psk2');
assert.throws(
  () => parseRouterOptions({ connection: 'auto', wifi: { enabled: true, ssid: 'Home', key: 'short' } }),
  /8-63 characters/,
);
assert.throws(
  () => parseRouterOptions({ connection: 'auto', wifi: { enabled: true, ssid: '', key: 'longenough' } }),
  /1-32 characters/,
);
assert.equal(
  parseRouterOptions({ connection: 'auto', wifi: { enabled: true, ssid: 'Open', encryption: 'none' } }).wifi.key,
  '',
  'an open network needs no key',
);

// --- Access Point: management address + options ------------------------------
// High addresses first: DHCP pools almost always start low.
assert.equal(
  pickManagementAddress({ ip: '192.168.1.137', mask: '255.255.255.0', gateway: '192.168.1.1' }),
  '192.168.1.250',
);
assert.equal(
  pickManagementAddress({ ip: '192.168.1.250', mask: '255.255.255.0', gateway: '192.168.1.1' }, ['192.168.1.250']),
  '192.168.1.251',
  'the borrowed lease address is never kept',
);
assert.equal(
  pickManagementAddress({ ip: '10.0.0.5', mask: '255.255.0.0', gateway: '10.0.0.1' }),
  '10.0.255.250',
);
assert.equal(pickManagementAddress({ ip: 'nope', mask: '255.255.255.0', gateway: '1.1.1.1' }), null);

const apAuto = parseApOptions({});
assert.equal(apAuto.uplink, 'wan');
assert.equal(apAuto.manual, null);
assert.equal(parseApOptions({ uplink: 'lan' }).uplink, 'lan');
assert.throws(() => parseApOptions({ uplink: 'wifi' }), /Choose one of/);

const apManual = parseApOptions({
  manual: { ip: '192.168.1.250', netmask: '255.255.255.0', gateway: '192.168.1.1' },
});
assert.equal(apManual.manual.gateway, '192.168.1.1');
assert.throws(
  () => parseApOptions({ manual: { ip: '192.168.1.250', netmask: '255.255.255.0' } }),
  /not a valid IP/,
  'a manual setup without the main router address is refused',
);

// --- Wireless uplink: scan encryption mapping + options ----------------------
// Getting this wrong is the usual cause of a repeater that associates then drops.
assert.equal(scanEncryption({ enabled: false }), 'none');
assert.equal(scanEncryption({ enabled: true, wpa: [2], authentication: ['psk'] }), 'psk2');
assert.equal(scanEncryption({ enabled: true, wpa: [1], authentication: ['psk'] }), 'psk');
assert.equal(scanEncryption({ enabled: true, wpa: [2, 3], authentication: ['psk', 'sae'] }), 'sae-mixed');
assert.equal(scanEncryption({ enabled: true, wpa: [3], authentication: ['sae'] }), 'sae-mixed');
assert.equal(scanEncryption(undefined), 'none');
assert.equal(encryptionLabel('none'), 'Open — no password');
assert.equal(encryptionLabel('sae-mixed'), 'WPA3');

const uplink = parseWirelessUplinkOptions({ radio: 'radio0', ssid: 'Home', key: 'longenough' });
assert.equal(uplink.radio, 'radio0');
assert.equal(uplink.encryption, 'psk2');
assert.equal(uplink.wifi.enabled, false);
assert.equal(
  parseWirelessUplinkOptions({ radio: 'radio0', ssid: 'Cafe', encryption: 'none' }).key,
  '',
  'an open uplink needs no password',
);
assert.throws(() => parseWirelessUplinkOptions({ ssid: 'Home', key: 'longenough' }), /which Wi-Fi radio/);
assert.throws(() => parseWirelessUplinkOptions({ radio: 'radio0', ssid: 'Home', key: 'short' }), /8-63/);
assert.throws(() => parseWirelessUplinkOptions({ radio: 'radio0', ssid: '', key: 'longenough' }), /1-32/);
assert.throws(
  () => parseWirelessUplinkOptions({ radio: 'radio0', ssid: 'Home', key: 'longenough', encryption: 'wep' }),
  /Choose one of/,
  'WEP is not offered',
);

// --- Channel widths: one entry per width, and only what the band can use -----
assert.deepEqual(parseHtmode('HE80'), { family: 'HE', width: 80 });
assert.deepEqual(parseHtmode('HT20'), { family: 'HT', width: 20 });
assert.equal(parseHtmode('NOHT'), null);

const modes24 = ['HT20', 'HT40', 'HE20', 'HE40'];
const widths24 = channelWidthOptions(modes24, '2.4');
assert.deepEqual(widths24.map((w) => w.label), ['20 MHz', '40 MHz'], 'no duplicate widths per generation');
assert.deepEqual(widths24.map((w) => w.value), ['HE20', 'HE40'], 'newest standard wins for each width');

const modes5 = ['HT20', 'HT40', 'VHT20', 'VHT40', 'VHT80', 'VHT160', 'HE20', 'HE40', 'HE80'];
assert.deepEqual(
  channelWidthOptions(modes5, '5').map((w) => w.label),
  ['20 MHz', '40 MHz', '80 MHz', '160 MHz'],
);
assert.equal(
  channelWidthOptions(modes5, '5').find((w) => w.width === 80).value,
  'HE80',
  'HE80 preferred over VHT80',
);
// A dual-band chip advertises 80/160 even while tuned to 2.4 GHz, where they are impossible.
assert.deepEqual(
  channelWidthOptions(modes5, '2.4').map((w) => w.width),
  [20, 40],
  '2.4 GHz is capped at 40 MHz',
);
assert.deepEqual(channelWidthOptions([], '5'), []);

// --- Wi-Fi management: congestion + per-radio validation ---------------------
const congestion = channelCongestion([
  { channel: 1 }, { channel: 1 }, { channel: 1 }, { channel: 1 }, { channel: 1 },
  { channel: 6 }, { channel: 6 }, { channel: 6 },
  { channel: 11 },
  { channel: null },
]);
assert.deepEqual(congestion.map((entry) => entry.channel), [1, 6, 11], 'sorted, unusable entries dropped');
assert.equal(congestion[0].level, 'crowded');
assert.equal(congestion[1].level, 'busy');
assert.equal(congestion[2].level, 'quiet');
assert.deepEqual(channelCongestion([]), []);

const radioCaps = {
  channels: [{ channel: 1 }, { channel: 6 }, { channel: 11 }],
  htmodes: ['HT20', 'HT40'],
  txpower: { min: 0, max: 20 },
};
assert.equal(parseRadioSettings({ channel: '6' }, radioCaps).channel, '6');
assert.equal(parseRadioSettings({ channel: 'auto' }, radioCaps).channel, 'auto');
assert.throws(() => parseRadioSettings({ channel: '36' }, radioCaps), /cannot use that channel/);
assert.throws(() => parseRadioSettings({ htmode: 'VHT80' }, radioCaps), /channel width/);
assert.throws(() => parseRadioSettings({ txpower: 30 }, radioCaps), /between 0 and 20/);
assert.throws(() => parseRadioSettings({}, radioCaps), /Nothing to change/);
assert.equal(
  parseRadioSettings({ ssid: 'Home' }, radioCaps).key,
  undefined,
  'an empty password means keep the current one',
);
assert.equal(parseRadioSettings({ encryption: 'none', ssid: 'Open' }, radioCaps).key, '');
assert.throws(() => parseRadioSettings({ key: 'short' }, radioCaps), /8-63/);
assert.equal(parseRadioSettings({ enabled: false }, radioCaps).enabled, false);
assert.throws(
  () => parseRadioSettings({ txpower: 10 }, { ...radioCaps, txpower: null }),
  /does not allow changing transmit power/,
);

// --- DHCP: range planning and reservations -----------------------------------
const range = planRange({ routerIp: '192.168.1.1', netmask: '255.255.255.0', start: 100, limit: 150 });
assert.equal(range.firstIp, '192.168.1.100');
assert.equal(range.lastIp, '192.168.1.249');

assert.throws(
  () => planRange({ routerIp: '192.168.1.1', netmask: '255.255.255.0', start: 100, limit: 200 }),
  /does not fit/,
  'the range may not run past the broadcast address',
);
assert.throws(
  () => planRange({ routerIp: '192.168.1.50', netmask: '255.255.255.0', start: 10, limit: 100 }),
  /router's own address/,
  'the range may never contain the router itself',
);
assert.throws(() => planRange({ routerIp: '192.168.1.1', netmask: '255.255.255.0', start: 0, limit: 10 }), /start at 1/);
assert.throws(() => planRange({ routerIp: 'nope', netmask: '255.255.255.0', start: 10, limit: 10 }), /not valid/);

assert.equal(normalizeMac('AA-BB-CC-DD-EE-FF'), 'aa:bb:cc:dd:ee:ff');
assert.throws(() => normalizeMac('aa:bb:cc'), /not a valid device address/);

const lanArgs = { routerIp: '192.168.1.1', netmask: '255.255.255.0' };
assert.deepEqual(
  validateReservation({ ip: '192.168.1.120', mac: 'AA:BB:CC:DD:EE:FF', ...lanArgs }),
  { ip: '192.168.1.120', mac: 'aa:bb:cc:dd:ee:ff' },
);
assert.throws(
  () => validateReservation({ ip: '10.0.0.5', mac: 'aa:bb:cc:dd:ee:ff', ...lanArgs }),
  /not on your home network/,
);
assert.throws(
  () => validateReservation({ ip: '192.168.1.1', mac: 'aa:bb:cc:dd:ee:ff', ...lanArgs }),
  /router’s own address/,
);
const taken = [{ section: 'cfg01', ip: '192.168.1.120', mac: '11:22:33:44:55:66' }];
assert.throws(
  () => validateReservation({ ip: '192.168.1.120', mac: 'aa:bb:cc:dd:ee:ff', ...lanArgs, existing: taken }),
  /already reserved/,
);
assert.throws(
  () => validateReservation({ ip: '192.168.1.121', mac: '11:22:33:44:55:66', ...lanArgs, existing: taken }),
  /already has a reserved address/,
);
assert.doesNotThrow(
  () => validateReservation({ ip: '192.168.1.120', mac: '11:22:33:44:55:66', ...lanArgs, existing: taken, section: 'cfg01' }),
  'editing an existing reservation does not clash with itself',
);

// --- Bandwidth: counter rates and accounting output --------------------------
const t0 = { at: 1_000_000, rx: 1000, tx: 500 };
const t1 = { at: 1_002_000, rx: 3000, tx: 1500 };
assert.deepEqual(rateBetween(t0, t1), { rx: 1000, tx: 500 }, 'bytes per second over two seconds');
assert.equal(rateBetween(null, t1), null, 'no rate until a second sample');
assert.equal(rateBetween(t1, t0), null, 'a reset counter is reported as unknown, not negative');
assert.equal(rateBetween(t0, { ...t0, at: t0.at + 100 }), null, 'samples too close together are ignored');

const nlbw = parseNlbwJson(
  JSON.stringify({
    columns: ['mac', 'ip', 'conns', 'rx_bytes', 'tx_bytes'],
    data: [
      ['aa:bb:cc:dd:ee:ff', '192.168.1.10', 4, 100, 50],
      ['11:22:33:44:55:66', '192.168.1.11', 2, 900, 20],
    ],
  }),
);
assert.equal(nlbw.length, 2);
assert.equal(nlbw[0].ip, '192.168.1.11', 'busiest device first');
assert.equal(nlbw[0].rxBytes, 900);
assert.deepEqual(parseNlbwJson('not json'), [], 'unparseable output yields no rows, never invented ones');
assert.deepEqual(parseNlbwJson(JSON.stringify({ columns: ['mac'], data: [['aa']] })), [], 'missing counters yield nothing');
assert.deepEqual(parseNlbwJson(''), []);

// --- Backup files are untrusted input ----------------------------------------
const goodBackup = {
  format: BACKUP_FORMAT,
  takenAt: '2026-01-01T00:00:00.000Z',
  configs: { network: { lan: { '.type': 'interface', ipaddr: '192.168.1.1' } } },
};
assert.equal(validateBackup(goodBackup).configs.network.lan.ipaddr, '192.168.1.1');
assert.throws(() => validateBackup({ configs: {} }), /not an EasyMode backup/);
assert.throws(() => validateBackup({ format: BACKUP_FORMAT }), /no settings in it/);
assert.throws(() => validateBackup(null), /not an EasyMode backup/);
assert.throws(
  () => validateBackup({ ...goodBackup, configs: { ...goodBackup.configs, rpcd: { login: {} } } }),
  /does not manage/,
  'a crafted backup may not write configs outside the managed set',
);
assert.throws(
  () => validateBackup({ ...goodBackup, configs: { network: 'oops' } }),
  /damaged/,
);

// --- Scan merging (LuCI keys its cache by BSSID and accumulates passes) ------
const pass1 = [
  { bssid: 'aa:00', ssid: 'Home', channel: 6, signal: -50 },
  { bssid: 'aa:01', ssid: 'Home', channel: 11, signal: -70 },
];
const pass2 = [
  { bssid: 'aa:02', ssid: 'Neighbour', channel: 1, signal: -80 },
  { bssid: 'aa:00', ssid: 'Home', channel: 6, signal: -47 },
];

const afterFirst = mergeScanResults({}, pass1, 1000);
assert.equal(Object.keys(afterFirst).length, 2);
const afterSecond = mergeScanResults(afterFirst, pass2, 2000);
assert.equal(
  Object.keys(afterSecond).length,
  3,
  'a second pass adds what it finds instead of replacing the list',
);
assert.equal(afterSecond['aa:00'].signal, -47, 'a re-seen network refreshes rather than duplicating');
// Two access points sharing a name must stay separate, or the congestion view lies.
assert.equal(sortScanResults(afterSecond).filter((entry) => entry.ssid === 'Home').length, 2);
assert.equal(sortScanResults(afterSecond)[0].bssid, 'aa:00', 'strongest first');
// Stale entries expire so a moved router stops haunting the list.
assert.equal(Object.keys(mergeScanResults(afterSecond, [], 2000 + 6 * 60 * 1000)).length, 0);

// Joining happens by name, so that list is deduplicated and drops hidden networks.
const joinable = byNetworkName(sortScanResults(afterSecond).concat([{ ssid: null, bssid: 'aa:03', signal: -60 }]));
assert.deepEqual(joinable.map((entry) => entry.ssid), ['Home', 'Neighbour']);
assert.equal(joinable[0].signal, -47, 'the strongest access point represents the name');

assert.equal(normalizeScanEntry({ ssid: '  ', bssid: 'x', channel: 1 }).hidden, true);
assert.equal(normalizeScanEntry({ ssid: 'Home', bssid: 'x', channel: 1 }).hidden, false);

// --- Blocking a device --------------------------------------------------------
const firewallWithBlock = {
  cfg01: { '.type': 'zone', name: 'lan' },
  cfg09: { '.type': 'rule', name: 'easymode_block_aabbccddeeff', src: 'lan', src_mac: 'aa:bb:cc:dd:ee:ff', dest: '*', target: 'REJECT' },
  cfg10: { '.type': 'rule', name: 'Allow-Ping', src: 'wan', target: 'ACCEPT' },
};
const blocks = listBlocks(firewallWithBlock);
assert.equal(blocks.length, 1, 'only rules EasyMode created are listed');
assert.equal(blocks[0].mac, 'aa:bb:cc:dd:ee:ff');
assert.equal(blocks[0].section, 'cfg09');
assert.deepEqual(listBlocks({}), []);
assert.deepEqual(listBlocks(null), []);

// Blocking relies on the firewall, which an access point never sees.
assert.equal(blockingSupport('router').available, true);
assert.equal(blockingSupport('repeater').available, true);
assert.equal(blockingSupport(null).available, true);
assert.equal(blockingSupport('ap').available, false);
assert.match(blockingSupport('ap').reason, /access point/);

// --- UCI writer argument shapes ----------------------------------------------
// A named section is named by the top-level `name` argument. Passing it inside
// `values` silently creates an anonymous section with a stray `option name`, which
// is exactly the kind of mistake that only shows up on real hardware.
function stubClient(configs = {}) {
  const calls = [];
  return {
    calls,
    async call(object, method, args) {
      calls.push({ object, method, args });
      if (method === 'add') return { section: 'cfg99' };
      return {};
    },
    async tryCall(object, method, args) {
      calls.push({ object, method, args, soft: true });
      if (method === 'get') {
        const section = configs[args.config]?.[args.section];
        if (!section) return null;
        return args.option ? { value: section[args.option] } : { values: section };
      }
      return {};
    },
  };
}

const addClient = stubClient();
const addUci = new Uci(addClient);
await addUci.add('dhcp', 'host', { ip: '192.168.1.5', name: 'tv' });
const anonAdd = addClient.calls.at(-1);
assert.equal(anonAdd.args.name, undefined, 'an anonymous section passes no name argument');
assert.equal(anonAdd.args.values.name, 'tv', 'host name stays an option, because that is what it is');

await addUci.add('network', 'interface', { proto: 'dhcp' }, 'wan');
const namedAdd = addClient.calls.at(-1);
assert.equal(namedAdd.args.name, 'wan', 'a section name is a top-level argument');
assert.equal(namedAdd.args.values.name, undefined, 'and never leaks into the options');

const ensureClient = stubClient({ network: { lan: { '.type': 'interface', ipaddr: '192.168.1.1' } } });
const ensureUci = new Uci(ensureClient);
const created = await ensureUci.ensure('network', 'wwan', 'interface', { proto: 'dhcp' });
const createCall = ensureClient.calls.at(-1);
assert.equal(created, true);
assert.equal(createCall.method, 'add', 'a missing section is created with a named add');
assert.equal(createCall.args.name, 'wwan');
assert.equal(createCall.args.type, 'interface', 'creating a missing section must carry its type');

const existed = await ensureUci.ensure('network', 'lan', 'interface', { ipaddr: '192.168.8.1' });
const updateCall = ensureClient.calls.at(-1);
assert.equal(existed, false);
assert.equal(updateCall.args.type, undefined, 'updating an existing section sends no type');
assert.equal(updateCall.args.values.ipaddr, '192.168.8.1');

const clearClient = stubClient({ network: { wan: { '.type': 'interface', proto: 'pppoe', username: 'a' } } });
const clearUci = new Uci(clearClient);
await clearUci.clearOptions('network', 'wan', ['username', 'password', 'ipaddr']);
const deleteCall = clearClient.calls.at(-1);
assert.equal(deleteCall.method, 'delete');
assert.deepEqual(deleteCall.args.options, ['username'], 'only options that exist are deleted');

// --- UCI section helpers -----------------------------------------------------
const firewall = {
  cfg01: { '.type': 'zone', name: 'lan', network: 'lan' },
  cfg02: { '.type': 'zone', name: 'wan', network: ['wan', 'wan6'] },
  cfg03: { '.type': 'forwarding', src: 'lan', dest: 'wan' },
};
assert.equal(findSection(firewall, 'zone', (s) => s.name === 'wan').name, 'cfg02');
assert.equal(findSection(firewall, 'zone', (s) => s.name === 'guest'), null);
assert.equal(findSections(firewall, 'zone').length, 2);
assert.deepEqual(asList('lan'), ['lan'], 'a single-value UCI list is still a list');
assert.deepEqual(asList(['wan', 'wan6']), ['wan', 'wan6']);
assert.deepEqual(asList(undefined), []);

// --- IPv6 state ---------------------------------------------------------------
// DHCP saves preserve IPv6 based on this, so a wrong answer silently flips IPv6 off.
assert.equal(lanServesIpv6({ ra: 'server' }), true);
assert.equal(lanServesIpv6({ dhcpv6: 'relay' }), true);
assert.equal(lanServesIpv6({ ra: 'disabled', dhcpv6: 'disabled' }), false);
assert.equal(lanServesIpv6(undefined), false);
const ipv6Client = (dhcp, network) => ({ uciGet: async (c) => (c === 'dhcp' ? dhcp : network) });
assert.equal((await getIpv6Status(ipv6Client({ lan: { '.type': 'dhcp', interface: 'lan', ra: 'server' } }, { wan6: { proto: 'dhcpv6' } }))).mode, 'global');
assert.equal((await getIpv6Status(ipv6Client({ lan: { '.type': 'dhcp', interface: 'lan', ra: 'server' } }, {}))).mode, 'local');
assert.equal((await getIpv6Status(ipv6Client({ lan: { '.type': 'dhcp', interface: 'lan' } }, { wan6: { proto: 'dhcpv6' } }))).enabled, false);

console.log('all checks passed');
