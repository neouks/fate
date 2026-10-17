#!/bin/bash
u="$1"
echo "=== $u ==="
curl -s -o /tmp/out.$$ -w "HTTP %{http_code} len=%{size_download}\n" --path-as-is "http://144.123.22.234:9080$u" -H 'User-Agent: curl-probe'
head -c 600 /tmp/out.$$; echo; rm -f /tmp/out.$$
