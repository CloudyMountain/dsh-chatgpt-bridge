#!/usr/bin/env bash
# @cloudymountain/dsh-chatgpt-bridge installer — links the plugin into dsh
# profiles and injects the patch row (idempotent; backs up before editing).
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILES="$DSH_HOME/profiles"
PLUGIN_PKG="@cloudymountain/dsh-chatgpt-bridge"
PLUGIN_ID="dsh-chatgpt-bridge"

echo "==> 检查 codex CLI"
if ! command -v codex >/dev/null 2>&1; then
  echo "未找到 codex。请先安装：npm i -g @openai/codex"
  exit 1
fi

echo "==> 检查 codex 登录状态"
if ! codex login status >/dev/null 2>&1; then
  echo "codex 未登录。请先执行：codex login  （无头机：codex login --device-auth）"
  exit 1
fi

echo "==> 链接插件到 profiles node_modules ($PLUGIN_PKG)"
# scoped 包需要 @scope/ 父目录
SCOPE_DIR="$PROFILES/node_modules/$(dirname "$PLUGIN_PKG")"
LINK="$PROFILES/node_modules/$PLUGIN_PKG"
mkdir -p "$SCOPE_DIR"
if [ -e "$LINK" ]; then
  echo "    $LINK 已存在，跳过"
else
  ln -s "$SRC" "$LINK"
  echo "    已链接: $LINK -> $SRC"
fi

patch_file() {
  local f="$1"
  if [ ! -f "$f" ]; then
    echo "    (无 $f，跳过)"
    return
  fi
  if grep -q "id: $PLUGIN_ID" "$f"; then
    echo "    $f 已注入，跳过"
    return
  fi
  cp "$f" "$f.bak-$(date +%s)"
  printf '\n- insert:\n    - id: %s\n      name: %s\n' "$PLUGIN_ID" "$PLUGIN_PKG" >> "$f"
  echo "    已注入 $f（备份: $f.bak-*）"
}

echo "==> 注入 patch 行"
patch_file "$PROFILES/web/cordis.patch.yml"
patch_file "$PROFILES/headless/cordis.patch.yml"

echo
echo "完成！最后一步：重启 dsh web 服务（例如 systemctl --user restart dsh-web），"
echo "然后开一个新会话，敲 /chatgpt 验证。"
