# OpenCode Plugin

This folder contains the OpenCode plugin entrypoint for claude-mem.

## Install

1. Copy the plugin file into the OpenCode plugins directory:

```bash
mkdir -p ~/.config/opencode/plugins
cp OpenCode/claude-mem.js ~/.config/opencode/plugins/claude-mem.js
```

2. Register the plugin in `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    "/home/<user>/.config/opencode/plugins/claude-mem.js"
  ]
}
```

3. Restart OpenCode.

## Requirements

- Bun (required)
- uv (required for vector search)

If Bun is missing, install it and ensure it is on PATH before restarting OpenCode.

## Development

The plugin resolves the claude-mem root automatically based on its own location.
If you want to point it at a specific checkout, set `CLAUDE_MEM_ROOT`:

```bash
export CLAUDE_MEM_ROOT="/path/to/claude-mem"
```

## Verify

```bash
curl -sS http://127.0.0.1:37777/api/health
curl -sS "http://127.0.0.1:37777/api/prompts?limit=5"
```
