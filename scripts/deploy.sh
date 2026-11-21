#!/usr/bin/env bash
# 部署 Astro 博客到腾讯云轻量服务器（OpenResty 静态站点）
# 用法：./scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

SITE_DIR=/opt/1panel/apps/openresty/openresty/www/sites/www.geekrlee.com/index
OPENRESTY=1Panel-openresty-2ex7

echo "== 1/3 构建 =="
npm run build

echo "== 2/3 上传到服务器暂存 =="
rsync -az --delete dist/ -e "ssh -o BatchMode=yes" tecent_light:/tmp/www-static/

echo "== 3/3 发布并重载 OpenResty =="
ssh -o BatchMode=yes tecent_light "sudo rsync -a --delete /tmp/www-static/ ${SITE_DIR}/ && sudo docker exec ${OPENRESTY} openresty -s reload"

echo "== 验证 =="
curl -sS -o /dev/null -w "https://www.geekrlee.com/ -> %{http_code}\n" https://www.geekrlee.com/
