import { AppError } from './errors.js';
import { isIpv4, maskToBits } from './net.js';

const fail = (message, field) =>
  new AppError('INVALID_SETTINGS', message, { status: 400, details: field ? `Field: ${field}` : undefined });

export const str = (value) => (typeof value === 'string' ? value.trim() : '');

export function requireIpv4(value, field) {
  const ip = str(value);
  if (!isIpv4(ip)) throw fail(`"${value}" is not a valid IP address.`, field);
  return ip;
}

export function requireNetmask(value, field) {
  const mask = str(value) || '255.255.255.0';
  const bits = maskToBits(mask);
  if (bits == null || bits < 8 || bits > 30) throw fail(`"${value}" is not a usable network mask.`, field);
  return mask;
}

export function optionalIpv4(value, field) {
  const ip = str(value);
  return ip ? requireIpv4(ip, field) : null;
}

export function requireOneOf(value, allowed, field) {
  const picked = str(value);
  if (!allowed.includes(picked)) throw fail(`Choose one of: ${allowed.join(', ')}.`, field);
  return picked;
}

export function requireSsid(value, field = 'ssid') {
  const ssid = str(value);
  if (ssid.length < 1 || ssid.length > 32) throw fail('The Wi-Fi name must be 1-32 characters.', field);
  return ssid;
}

/** WPA keys are 8-63 characters; an empty key is only valid for an open network. */
export function requireWifiKey(value, encryption, field = 'key') {
  const key = typeof value === 'string' ? value : '';
  if (encryption === 'none') return '';
  if (key.length < 8 || key.length > 63) throw fail('The Wi-Fi password must be 8-63 characters.', field);
  return key;
}

export function optionalDnsList(value, field = 'dns') {
  if (value == null || value === '') return [];
  const list = Array.isArray(value) ? value : String(value).split(/[,\s]+/);
  return list.filter(Boolean).map((entry) => requireIpv4(entry, field));
}

export function requireLeaseTime(value, field = 'leasetime') {
  const lease = str(value) || '12h';
  if (!/^\d+[smhd]$/.test(lease)) throw fail('Lease time looks like "12h" or "30m".', field);
  return lease;
}

export function requireRange(value, { min, max, fallback }, field) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw fail(`Enter a whole number between ${min} and ${max}.`, field);
  }
  return number;
}

export { fail as invalidSettings };
