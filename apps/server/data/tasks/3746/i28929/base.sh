#!/bin/bash
# baseline
echo "=== B1 protected fingerprint ==="
curl -s -i --path-as-is "http://144.123.22.234:9080/prod-api/system/user/list?pageNum=1&pageSize=1" -H 'User-Agent: curl-probe' | head -c 800
echo
sleep 1.6
echo "=== B2 whitelist fingerprint ==="
curl -s -i --path-as-is "http://144.123.22.234:9080/prod-api/auth/tenant/list" -H 'User-Agent: curl-probe' | head -c 1200
echo
