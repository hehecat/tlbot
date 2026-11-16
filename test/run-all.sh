#!/bin/sh
# 全量测试：离线单测 + extension 真实加载
set -e
cd "$(dirname "$0")/.."
NODE=${NODE:-/Applications/Alma.app/Contents/Resources/alma-server/runtime/node}

echo "=== 1/2 离线单测（不联网）==="
"$NODE" --test test/*.test.mjs

echo ""
echo "=== 2/2 extension 真实加载（mock pi，不联网）==="
"$NODE" --experimental-strip-types test/extension-smoke.mjs

echo ""
echo "全部测试通过。"
