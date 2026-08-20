# dsh-chatgpt-bridge

> Let the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) agent chat with **ChatGPT** through the **official** Codex CLI — no API key, no browser automation, no reverse engineering. Conversations keep **persistent per-thread memory** across calls, sessions, and restarts.

[中文文档](README.zh.md)

## Features

- ✅ **Official channel**: [`@openai/codex`](https://www.npmjs.com/package/@openai/codex) with ChatGPT account sign-in (free usage for Plus/Pro). No reverse engineering, no ToS violations — safe to distribute.
- ✅ **Built-in memory**: one JSONL file per thread (`~/.dsh/chatgpt-bridge/threads/`). Conversation history is attached automatically — you never repeat context.
- ✅ **Dual surface**: type `/chatgpt <prompt>` to chat directly (human command plane, zero model tokens), or ask the dsh agent to use the `chatgpt_chat` tool. Both share the same threads.
- ✅ **Session-thread binding**: `/chatgpt use <name>` binds the current dsh session to a thread, so both you and the agent always land in the same conversation.
- ✅ **Safe**: Codex runs with `--sandbox read-only` in a dedicated scratch directory — the chat channel cannot touch your files.
- ✅ **Zero dependencies**: only Node built-ins; loads from any location on any machine.

## How it works

```
dsh session
 ├─ user types /chatgpt <prompt>   ─┐
 ├─ agent calls chatgpt_chat tool   ─┼→ thread file (JSONL) → codex exec (official CLI) → ChatGPT account
 └─ /chatgpt list/use/new/clear     ─┘       ↑ memory          (gpt-5.x, read-only sandbox)
```

Each round: read the thread history → assemble `[System] + history (newest within budget) + new message` → one-shot `codex exec` → append the reply to the thread file. Codex processes are stateless and ephemeral; the conversation's identity is the thread name — it can never connect to the wrong conversation.

## Requirements

- dsh (web or headless profile)
- Node.js ≥ 18
- Codex CLI: `npm i -g @openai/codex`
- A ChatGPT account (Plus/Pro for free usage; free accounts may not work)
- Network access to `chatgpt.com` / `auth.openai.com` (set `HTTPS_PROXY` in your shell if needed — the plugin inherits the environment)

## Installation

```bash
# 1. Install Codex and sign in once (official browser OAuth)
npm i -g @openai/codex
codex login                # on headless machines: codex login --device-auth

# 2. Get the plugin (npm is the official distribution channel)
npm i -g @cloudymountain/dsh-chatgpt-bridge   # install anywhere in PATH
#    For dsh profile linking, prefer the clone + installer (dev method):
#    git clone https://github.com/CloudyMountain/dsh-chatgpt-bridge
#    cd dsh-chatgpt-bridge

# 3. One-shot installer (links into profiles + injects the patch row; idempotent, auto-backup)
./install.sh
#    or manually:
#   npm install @cloudymountain/dsh-chatgpt-bridge --prefix ~/.dsh/profiles
#   #   (or symlink: ln -s "$PWD" ~/.dsh/profiles/node_modules/@cloudymountain/dsh-chatgpt-bridge)
#   then append to ~/.dsh/profiles/web/cordis.patch.yml (and headless):
#   - insert:
#       - id: dsh-chatgpt-bridge
#         name: @cloudymountain/dsh-chatgpt-bridge

# 4. Restart the dsh web service (systemd user service example)
systemctl --user restart dsh-web      # or restart your dsh process your way

# 5. Open a NEW conversation and type /chatgpt to verify
```

## Usage

### Command (human command plane — no model turn)

| Command | Effect |
|---|---|
| `/chatgpt <prompt>` | Chat directly (on this session's bound thread) |
| `/chatgpt list` | List all stored conversations |
| `/chatgpt use <name>` | Bind this dsh session to a thread |
| `/chatgpt new <name>` | Create a fresh thread |
| `/chatgpt clear <name>` | Reset a thread |
| `/chatgpt` | Help (shows current binding) |

### Tools (agent plane)

| Tool | Effect |
|---|---|
| `chatgpt_chat(prompt, thread?)` | Chat (defaults to this session's bound thread; history attached automatically) |
| `chatgpt_list_threads()` | List threads |
| `chatgpt_new_thread(name?)` | Create a thread |
| `chatgpt_clear_thread(thread)` | Reset a thread |

Just tell the agent "ask ChatGPT: …". Thread names accept any text (Chinese included); path-unsafe characters are filtered automatically.

## Configuration (`config` in the cordis.patch.yml row)

| Key | Default | Description |
|---|---|---|
| `codexBin` | `codex` | Codex executable path |
| `model` | unset (Codex default, e.g. gpt-5.x) | Explicit model id |
| `threadsDir` | `~/.dsh/chatgpt-bridge/threads` | Thread memory directory |
| `scratchDir` | `~/.dsh/chatgpt-bridge/scratch` | Codex working dir (read-only sandbox) |
| `systemPrompt` | built-in chat persona | Custom system prompt |
| `maxHistoryMessages` | `40` | Max history messages fed to Codex |
| `maxHistoryChars` | `120000` | History character budget (oldest trimmed) |
| `timeoutMs` | `300000` | Per-round timeout (ms) |
| `extraArgs` | `[]` | Extra arguments passed to `codex exec` |

## Memory & privacy

- Thread memory is **plain-text JSONL** (`~/.dsh/chatgpt-bridge/threads/<name>.jsonl`) containing the full conversation — keep it safe; `/chatgpt clear` removes it anytime.
- Conversation content is sent to OpenAI (that's what "chatting with ChatGPT" means) and billed against your ChatGPT account's usage.
- Bridge memory works by feeding history in every round — it is **not** ChatGPT web's Memory feature.
- Session-thread bindings live in memory only (back to `default` after restart).

## Known limitations

- Codex usage under ChatGPT-account mode has **quotas** (limited for Plus) — not for high-frequency use.
- Rounds are serialized per instance (one Codex process at a time); concurrent writes to the same thread from **multiple dsh instances** are not file-locked (single-instance deployments are fine).
- Needs access to OpenAI (use a proxy from CN networks).
- Reply quality depends on history completeness (the budget trims the oldest messages).

## Uninstall

```bash
rm ~/.dsh/profiles/node_modules/@cloudymountain/dsh-chatgpt-bridge
rmdir ~/.dsh/profiles/node_modules/@cloudymountain 2>/dev/null || true
# remove the dsh-chatgpt-bridge insert block from both cordis.patch.yml files
rm -rf ~/.dsh/chatgpt-bridge        # memory data (optional)
```

## License

MIT
