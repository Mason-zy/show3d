#!/usr/bin/env bash
# 构建并发布到 gx。文件是挂载进去的，传完立刻生效，不用重启容器。
set -euo pipefail

HOST=${HOST:-gx}
REMOTE_DIR=${REMOTE_DIR:-/data/home/kit/Project/show3d}
TARBALL=/tmp/show3d-dist.tgz

echo "→ 构建"
npm run build

echo "→ 打包"
tar -czf "$TARBALL" -C dist .

echo "→ 上传到 $HOST"
scp "$TARBALL" "$HOST:/tmp/"

echo "→ 解包"
ssh "$HOST" "mkdir -p $REMOTE_DIR && find $REMOTE_DIR -mindepth 1 -delete && tar -xzf /tmp/show3d-dist.tgz -C $REMOTE_DIR && rm -f /tmp/show3d-dist.tgz"

echo "→ 自检"
ssh "$HOST" 'curl -s -o /dev/null -w "index %{http_code}\n" http://172.17.0.1:18080/'

echo "完成。https://<你的域名> 已更新。"
