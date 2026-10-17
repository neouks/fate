#!/bin/bash
BASE="http://144.123.22.234:9080"
FALLBACK_MD5="d983a2e44a0f5aef1a80abd16105cb15"
probe() {
  local path="$1"
  local out=$(curl -s -o /tmp/r.$$ -D /tmp/rh.$$ --path-as-is -w "%{http_code}|%{size_download}|%{content_type}" "$BASE$path")
  local md5=$(md5 -q /tmp/r.$$ 2>/dev/null)
  local snippet=$(head -c 150 /tmp/r.$$ | tr '\n' ' ')
  local tag="HIT(非兜底)"
  [ "$md5" = "$FALLBACK_MD5" ] && tag="SPA_FALLBACK"
  echo -e "$tag\t$path\t$out\tmd5=$md5\t$snippet"
  rm -f /tmp/r.$$ /tmp/rh.$$
}
# 仅探测前缀根（/prod-api/ 与 /dev-api/ 已知返回 101B text/plain 版本横幅，故前缀根本身即可判定别名存在性）；/dev-api 按指令不测
for p in /test-api/ /uat-api/ /sit-api/ /pre-api/ /stage-api/ /staging-api/ /local-api/ /mock-api/ /prod-api2/ /prod-api-v2/ /gateway-api/ /openapi/; do probe "$p"; sleep 1.1; done
