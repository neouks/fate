#!/bin/bash
BASE="http://144.123.22.234:9080"
probe() {
  local path="$1"
  local out=$(curl -s -o /tmp/q.$$ -D /tmp/qh.$$ --path-as-is -w "%{http_code}|%{size_download}|%{content_type}" "$BASE$path")
  local body=$(head -c 260 /tmp/q.$$ | tr '\n' ' ')
  echo -e "$path\t$out\t$body"
  rm -f /tmp/q.$$ /tmp/qh.$$
}
PATHS="/prod-api/app/auth/code /prod-api/api/auth/code /prod-api/wx/auth/code /prod-api/mini/auth/code /prod-api/h5/auth/code /prod-api/mobile/auth/code /prod-api/open/auth/code /prod-api/public/auth/code /prod-api/client/auth/code /prod-api/applet/auth/code /prod-api/wx/login /prod-api/app/user/info"
echo "=== PHASE C: /prod-api multi-client prefixes ==="
for p in $PATHS; do probe "$p"; sleep 1.2; done
