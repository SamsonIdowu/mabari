#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# After an install or upgrade, restart Mabari for each logged-in user who runs it as a service,
# so the new version takes over. Users who don't run it are left alone.
command -v loginctl >/dev/null 2>&1 || exit 0
systemctl --global daemon-reload >/dev/null 2>&1 || true
loginctl list-users --no-legend 2>/dev/null | while read -r uid name _; do
  [ -n "$name" ] || continue
  systemctl --user -M "$name@" daemon-reload >/dev/null 2>&1 || true
  systemctl --user -M "$name@" try-restart mabari.service >/dev/null 2>&1 || true
done
exit 0
