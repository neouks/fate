#!/bin/bash
BASE="http://144.123.22.234:9080"
FALLBACK_MD5="d983a2e44a0f5aef1a80abd16105cb15"
probe() {
  local path="$1"
  local out=$(curl -s -o /tmp/p.$$ -D /tmp/h.$$ --path-as-is -w "%{http_code}|%{size_download}|%{content_type}" "$BASE$path")
  local md5=$(md5 -q /tmp/p.$$ 2>/dev/null)
  local snippet=$(head -c 140 /tmp/p.$$ | tr '\n' ' ')
  local tag="PASS"
  if [ "$md5" = "$FALLBACK_MD5" ]; then tag="SPA_FALLBACK"; fi
  echo -e "$tag\t$path\t$out\tmd5=$md5\t$snippet"
  rm -f /tmp/p.$$ /tmp/h.$$
}
PREFIXES="/api/ /api/v1/ /app-api/ /admin-api/ /mini-api/ /wx-api/ /open-api/ /mobile-api/ /app/ /wx/ /mini/ /h5/ /mobile/ /gateway/ /proxy/ /rest/ /v1/ /v2/ /file/ /oss/ /upload/"
echo "=== PHASE A: auth/code ==="
for p in $PREFIXES; do probe "${p}auth/code"; sleep 1; done
echo "=== PHASE B: ping ==="
for p in $PREFIXES; do probe "${p}ping"; sleep 1; done
