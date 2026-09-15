#!/bin/sh
# Run this ON the OpenWrt router (ash, not bash).
#
# It installs the packages EasyMode needs, adds a least-privilege "easymode"
# rpcd user, and restarts the HTTP server. Root login keeps working; EasyMode
# does not need it.
#
#   scp -r router-agent root@192.168.1.1:/tmp/
#   ssh root@192.168.1.1 "sh /tmp/router-agent/install.sh"

set -e

ACL_SRC_DIR="$(dirname "$0")/acl.d"
ACL_DIR=/usr/share/rpcd/acl.d

echo "==> Installing required packages"
opkg update
opkg install uhttpd-mod-ubus rpcd rpcd-mod-file || true
# iwinfo is normally present; installing it is harmless if it already is.
opkg install rpcd-mod-iwinfo 2>/dev/null || true

echo "==> Installing ACLs"
mkdir -p "$ACL_DIR"
cp "$ACL_SRC_DIR"/easymode-read.json "$ACL_DIR"/
cp "$ACL_SRC_DIR"/easymode-write.json "$ACL_DIR"/

if ! uci show rpcd | grep -q "username='easymode'"; then
  echo "==> Creating rpcd user 'easymode'"
  printf 'Password for the new easymode user: '
  read -r EM_PASS
  HASH=$(uhttpd -m "$EM_PASS")
  uci add rpcd login >/dev/null
  uci set rpcd.@login[-1].username='easymode'
  uci set rpcd.@login[-1].password="$HASH"
  uci add_list rpcd.@login[-1].read='easymode-read'
  uci add_list rpcd.@login[-1].read='easymode-write'
  uci add_list rpcd.@login[-1].write='easymode-write'
  uci commit rpcd
else
  echo "==> rpcd user 'easymode' already exists, leaving it alone"
fi

echo "==> Enabling ubus over HTTP"
if ! uci show uhttpd.main.ubus_prefix >/dev/null 2>&1; then
  uci set uhttpd.main.ubus_prefix='/ubus'
  uci commit uhttpd
fi

echo "==> Restarting services"
/etc/init.d/rpcd restart
/etc/init.d/uhttpd restart

echo "Done. Sign in to EasyMode with username 'easymode'."
