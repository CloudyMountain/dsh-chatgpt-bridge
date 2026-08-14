# dsh-chatgpt-bridge

> Let the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) agent chat with **ChatGPT** through the **official** Codex CLI — no API key, no browser automation, no reverse engineering. Conversations keep **persistent per-thread memory** across calls, sessions, and restarts.

让 dsh 与 ChatGPT 对话的插件：走 **Codex CLI 的 ChatGPT 账号登录模式**（官方通道，Plus/Pro 免费），自带**线程级持久记忆**——跨调用、跨会话、跨重启保持，等价于 ChatGPT 网页版的会话列表。

## 特性

- ✅ **官方通道**：`@openai/codex` + ChatGPT 账号登录（Plus/Pro 免费额度），不逆向、不违反条款，可安全分发；
- ✅ **自带记忆**：每个线程一个 JSONL 文件（`~/.dsh/chatgpt-bridge/threads/`），对话历史自动带上，**不需要每次重复上下文**；
- ✅ **双通道**：用户敲 `/chatgpt` 命令直接对话（不走模型、零 token），代理也能通过 `chatgpt_chat` 工具代问——两条路共享同一份线程；
- ✅ **会话-线程绑定**：`/chatgpt use <名字>` 把当前 dsh 会话绑到某线程，人和代理都落进同一个对话，不会"选错历史"；
- ✅ **安全**：codex 以 `--sandbox read-only` 运行在独立 scratch 目录，聊天通道**不可能修改你的文件**；
- ✅ **零依赖**：插件只 import Node 内置模块，任何机器、任何位置直接加载。

## 原理

```
dsh 会话
 ├─ 用户敲 /chatgpt <prompt>   ─┐
 ├─ 代理调 chatgpt_chat 工具    ─┼→ 线程文件(JSONL) → codex exec(官方CLI) → ChatGPT 账号
 └─ /chatgpt list/use/new/clear ─┘        ↑ 记忆          （gpt-5.x，read-only 沙箱）
```

每次对话：读线程历史 → 组装 `[System] + 历史(预算内最新) + 新消息` → 一次性 `codex exec` → 回复写回线程文件。codex 进程无状态，对话身份 = 线程名，进程用完即焚——**永远接不错对话**。

## 要求

- dsh（web profile 或 headless）
- Node.js ≥ 18
- Codex CLI：`npm i -g @openai/codex`
- ChatGPT 账号（Plus/Pro 免费额度；普通账号可能不可用）
- 能访问 `chatgpt.com` / `auth.openai.com`（需要代理时给 shell 配 `HTTPS_PROXY` 即可，插件继承环境变量）

## 安装

```bash
# 1. 安装 codex 并登录一次（官方浏览器 OAuth）
npm i -g @openai/codex
codex login                # 无头机用 codex login --device-auth

# 2. 拿到插件目录（clone 或复制本仓库）
git clone https://github.com/CloudyMountain/dsh-chatgpt-bridge
cd dsh-chatgpt-bridge

# 3. 一键安装（链接到 profiles + 注入 patch，幂等、自动备份）
./install.sh
#   或手动：ln -s "$PWD" ~/.dsh/profiles/node_modules/chatgpt-bridge
#   并在 ~/.dsh/profiles/web/cordis.patch.yml（及 headless）追加：
#   - insert:
#       - id: chatgpt-bridge
#         name: chatgpt-bridge

# 4. 重启 dsh web 服务（systemd 用户服务示例）
systemctl --user restart dsh-web      # 或按你的方式重启 dsh 进程

# 5. 开新会话 → 敲 /chatgpt 验证
```

## 使用

### 命令（人类命令平面，不走模型）

| 命令 | 作用 |
|---|---|
| `/chatgpt <prompt>` | 直接对话（落在本会话绑定的线程） |
| `/chatgpt list` | 列出所有存储的会话 |
| `/chatgpt use <名字>` | 把当前 dsh 会话绑定到某线程 |
| `/chatgpt new <名字>` | 新建线程 |
| `/chatgpt clear <名字>` | 重置线程 |
| `/chatgpt` | 帮助（显示当前绑定） |

### 工具（代理平面）

| 工具 | 作用 |
|---|---|
| `chatgpt_chat(prompt, thread?)` | 对话（缺省用本会话绑定线程，自动带历史） |
| `chatgpt_list_threads()` | 列出线程 |
| `chatgpt_new_thread(name?)` | 新建线程 |
| `chatgpt_clear_thread(thread)` | 重置线程 |

对代理说"帮我问 ChatGPT：……"即可；指定线程就加一句"在 xx 线程里"。线程名支持中文等任意文本（自动过滤路径危险字符）。

## 配置（cordis.patch.yml 的 config）

| 键 | 默认 | 说明 |
|---|---|---|
| `codexBin` | `codex` | codex 可执行文件路径 |
| `model` | 不指定（codex 默认，如 gpt-5.x） | 显式指定模型 |
| `threadsDir` | `~/.dsh/chatgpt-bridge/threads` | 线程记忆目录 |
| `scratchDir` | `~/.dsh/chatgpt-bridge/scratch` | codex 工作目录（只读沙箱） |
| `systemPrompt` | 内置聊天人格 | 自定义 system 提示 |
| `maxHistoryMessages` | `40` | 喂给 codex 的历史消息数上限 |
| `maxHistoryChars` | `120000` | 历史总字符预算（超限截最旧） |
| `timeoutMs` | `300000` | 单轮超时（毫秒） |
| `extraArgs` | `[]` | 透传给 `codex exec` 的附加参数 |

## 记忆与隐私

- 线程记忆 = **明文 JSONL**（`~/.dsh/chatgpt-bridge/threads/<名字>.jsonl`），含全部对话内容——请妥善保管，可随时用 `/chatgpt clear` 删除；
- 对话内容会发送给 OpenAI（这是"和 ChatGPT 对话"的题中之义），由你的 ChatGPT 账号额度计费；
- 桥的记忆是"每次把历史喂进去"实现的，**不是 ChatGPT 网页版的 Memory**；
- 会话-线程绑定在内存中（重启后回到 `default`）。

## 已知限制

- ChatGPT 账号模式的 Codex 有**使用额度**（Plus 有限额），不适合高频调用；
- 单实例内全局串行（一次一个 codex 进程）；**跨 dsh 实例**同时写同一线程文件无文件锁（单实例部署无此问题）；
- 需要能访问 OpenAI（国内网络需代理）；
- 回复质量取决于历史完整度（预算截断会丢最早的消息）。

## 卸载

```bash
rm ~/.dsh/profiles/node_modules/chatgpt-bridge
# 删除两个 cordis.patch.yml 里的 chatgpt-bridge insert 块
rm -rf ~/.dsh/chatgpt-bridge        # 记忆数据（可选）
```

## License

MIT
