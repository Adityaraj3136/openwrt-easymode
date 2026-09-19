export async function isInternetPaused(ubus) {
  const firewall = await ubus.uciGet('firewall');
  if (!firewall) return false;
  const rule = Object.values(firewall).find(
    (s) => s['.type'] === 'rule' && s.name === 'pause-internet'
  );
  return rule ? rule.enabled === '1' : false;
}
