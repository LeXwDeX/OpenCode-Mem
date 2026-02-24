#!/usr/bin/env bash
set -euo pipefail

OPENCODE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
PLUGIN_DIR="$OPENCODE_DIR/plugins"
PLUGIN_SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_SRC="$PLUGIN_SRC_DIR/claude-mem.js"
PLUGIN_DST="$PLUGIN_DIR/claude-mem.js"
REPO_ROOT="$(cd "$PLUGIN_SRC_DIR/.." && pwd)"
RUNTIME_ROOT="$PLUGIN_DIR/claude-mem"
CONFIG="$OPENCODE_DIR/opencode.json"

mkdir -p "$PLUGIN_DIR"
mkdir -p "$RUNTIME_ROOT"

if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete "$REPO_ROOT/" "$RUNTIME_ROOT/"
else
  rm -rf "$RUNTIME_ROOT"
  cp -a "$REPO_ROOT" "$RUNTIME_ROOT"
fi

cp "$PLUGIN_SRC" "$PLUGIN_DST"

node -e '
const fs = require("fs");
const configPath = process.argv[1];
const pluginPath = process.argv[2];
let data = {};
if (fs.existsSync(configPath)) {
  const raw = fs.readFileSync(configPath, "utf8").trim();
  if (raw) data = JSON.parse(raw);
}
if (!Array.isArray(data.plugin)) data.plugin = [];
if (!data.plugin.includes(pluginPath)) data.plugin.push(pluginPath);
fs.writeFileSync(configPath, JSON.stringify(data, null, 2) + "\n");
' "$CONFIG" "$PLUGIN_DST"

echo "Installed claude-mem OpenCode plugin: $PLUGIN_DST"
echo "Restart OpenCode to load the plugin."
