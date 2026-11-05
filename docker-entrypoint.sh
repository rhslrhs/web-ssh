#!/bin/sh
# /data 권한을 맞춘 뒤 root 가 아닌 node 사용자로 실행
set -e
mkdir -p "$DATA_DIR"
chown -R node:node "$DATA_DIR"
chmod 700 "$DATA_DIR"
exec su-exec node "$@"
