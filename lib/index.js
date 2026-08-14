/**
 * chatgpt-bridge — a DeepSeek Harness profile plugin.
 *
 * Lets the dsh agent chat with ChatGPT through the OFFICIAL Codex CLI
 * (`@openai/codex`) authenticated with the user's ChatGPT account (Plus/Pro
 * sign-in mode). No API key, no browser automation, no reverse engineering.
 *
 * Memory model — the plugin owns per-thread persistent history:
 *
 *   ~/.dsh/chatgpt-bridge/threads/<thread>.jsonl
 *
 * Each `chatgpt_chat` call appends the thread's full history (trimmed to a
 * configurable budget) to the prompt sent to Codex, so conversations
 * continue across calls, dsh sessions, and restarts — equivalent to opening
 * a saved conversation in the ChatGPT web app.
 *
 * Tools:
 *   - chatgpt_chat(prompt, thread?)      — continue (or start) a thread
 *   - chatgpt_list_threads()             — list threads with stats
 *   - chatgpt_new_thread(name?)          — create a fresh thread
 *   - chatgpt_clear_thread(thread)       — reset a thread
 *
 * Safety: Codex runs with `--sandbox read-only` in a dedicated scratch
 * directory, so the chat channel cannot touch user files.
 *
 * Deliberately dependency-free: imports only Node builtins, so the plugin
 * loads from any location on any machine (no @deepseek-ai/* resolution).
 * Tool definitions are plain ToolSchema objects (name/description/
 * parameters/output/execute) accepted directly by `ctx.tools.register`.
 */
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const name = "chatgpt-bridge";
const inject = ["tools", "commands"];

const DEFAULT_SYSTEM_PROMPT =
	"You are ChatGPT, reached through a bridge from the DeepSeek Harness (dsh). " +
	"Reply conversationally to the latest user message, continuing the conversation history below. " +
	"Do not propose file operations, commands, or tool use: this channel is pure chat. " +
	"If you do not know something, say so plainly.";

const home = os.homedir();
const DEFAULT_THREADS_DIR = path.join(home, ".dsh", "chatgpt-bridge", "threads");
const DEFAULT_SCRATCH_DIR = path.join(home, ".dsh", "chatgpt-bridge", "scratch");

function sanitizeThreadName(thread) {
	// Keep any text (including Chinese), strip only path-unsafe characters;
	// reject pure-dot names and empty names.
	let s = String(thread ?? "default")
		.trim()
		.normalize("NFC")
		.replace(/[\\/\u0000-\u001f]+/g, "_")
		.replace(/^\.+$/, "");
	if (!s) s = "default";
	const chars = [...s];
	if (chars.length > 64) s = chars.slice(0, 64).join("");
	return s;
}

async function loadThread(file) {
	try {
		const raw = await fsp.readFile(file, "utf8");
		return raw
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch (err) {
		if (err?.code === "ENOENT") return [];
		throw err;
	}
}

async function appendThread(file, records) {
	await fsp.mkdir(path.dirname(file), { recursive: true });
	await fsp.appendFile(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

/** Assemble the Codex prompt: system + trimmed history (newest kept) + latest user message. */
function buildPrompt(systemPrompt, history, userPrompt, maxHistoryMessages, maxHistoryChars) {
	const head = `[System] ${systemPrompt}\n\nYou are continuing a conversation. History (newest kept, oldest trimmed as needed):\n`;
	const tail = `\n---\nNow reply to the latest user message:\n${userPrompt}`;
	const budget = Math.max(maxHistoryChars - head.length - tail.length, 0);
	const recent = history.slice(-maxHistoryMessages);
	const picked = [];
	let remaining = budget;
	for (let i = recent.length - 1; i >= 0; i--) {
		const line = `${recent[i].role}: ${recent[i].content}`;
		if (line.length > remaining) break;
		remaining -= line.length;
		picked.push(line);
	}
	picked.reverse();
	return head + picked.join("\n") + tail;
}

/**
 * Run one `codex exec` chat round. The prompt goes over stdin (`-`), the
 * final assistant message is written by Codex to a per-call output file.
 */
function runCodex(codexBin, args, scratchDir, promptText, signal, timeoutMs, outputFile) {
	return new Promise((resolve, reject) => {
		const lastMsgFile = outputFile ?? path.join(scratchDir, `last-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
		const child = spawn(codexBin, args, {
			cwd: scratchDir,
			stdio: ["pipe", "pipe", "pipe"]
		});
		let stderr = "";
		child.stderr.on("data", (d) => {
			stderr += d;
		});
		child.stdin.write(promptText, () => child.stdin.end());
		const kill = () => child.kill("SIGKILL");
		if (signal?.aborted) {
			kill();
			reject(new Error("chatgpt_chat aborted before start"));
			return;
		}
		signal?.addEventListener("abort", kill, { once: true });
		const timer = setTimeout(() => {
			kill();
			reject(new Error(`codex timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		child.on("error", (err) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", kill);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", kill);
			if (code !== 0) {
				reject(new Error(`codex exited with status ${code}: ${stderr.slice(-2000) || "(no stderr)"}`));
				return;
			}
			fsp
				.readFile(lastMsgFile, "utf8")
				.then((text) => resolve(text.trim()))
				.catch(() => resolve(""))
				.finally(() => fsp.unlink(lastMsgFile).catch(() => {}));
		});
	});
}

function apply(ctx, config = {}) {
	const resolved = {
		codexBin: config.codexBin ?? "codex",
		model: config.model,
		threadsDir: config.threadsDir ?? DEFAULT_THREADS_DIR,
		scratchDir: config.scratchDir ?? DEFAULT_SCRATCH_DIR,
		systemPrompt: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
		maxHistoryMessages: Number.isFinite(config.maxHistoryMessages) ? config.maxHistoryMessages : 40,
		maxHistoryChars: Number.isFinite(config.maxHistoryChars) ? config.maxHistoryChars : 120000,
		timeoutMs: Number.isFinite(config.timeoutMs) ? config.timeoutMs : 300000,
		extraArgs: Array.isArray(config.extraArgs) ? config.extraArgs : []
	};

	// Per-session current-thread binding: which ChatGPT thread this dsh
	// session is talking into. Keyed by session id; in-memory only (the
	// binding is a UI choice, not conversation data).
	const sessionThreads = new Map();
	const boundThread = (agent) => sessionThreads.get(agent?.session?.header?.id) ?? "default";

	// Serialize Codex rounds: one at a time.
	let chain = Promise.resolve();
	const serialized = (fn) => {
		const run = chain.then(fn, fn);
		chain = run.then(
			() => undefined,
			() => undefined
		);
		return run;
	};

	const threadFile = (thread) => path.join(resolved.threadsDir, `${thread}.jsonl`);
	const baseArgs = (lastMsgFile) => [
		"exec",
		"--skip-git-repo-check",
		"--sandbox",
		"read-only",
		"--ephemeral",
		"-C",
		resolved.scratchDir,
		"-o",
		lastMsgFile,
		...(resolved.model ? ["-m", resolved.model] : []),
		...resolved.extraArgs,
		"-"
	];

	// One chat round on a thread: load history, assemble context, call
	// Codex, persist both sides.
	const chat = (thread, promptText, signal) =>
		serialized(async () => {
			const file = threadFile(thread);
			const history = await loadThread(file);
			const lastMsgFile = path.join(resolved.scratchDir, `out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
			const prompt = buildPrompt(resolved.systemPrompt, history, promptText, resolved.maxHistoryMessages, resolved.maxHistoryChars);
			const reply = await runCodex(resolved.codexBin, baseArgs(lastMsgFile), resolved.scratchDir, prompt, signal, resolved.timeoutMs, lastMsgFile);
			if (!reply) throw new Error("codex returned an empty reply");
			await appendThread(file, [
				{ role: "user", content: promptText, ts: Date.now() },
				{ role: "assistant", content: reply, ts: Date.now() }
			]);
			return { reply, thread, historyMessages: history.length + 1 };
		});

	ctx.tools.register({
		name: "chatgpt_chat",
		description:
			"Chat with ChatGPT (via the official Codex CLI authenticated with your ChatGPT account). " +
			"Conversations are stored per thread and remembered automatically — you do NOT need to repeat earlier context. " +
			"Pass an existing thread name to continue it, or omit for the default thread; use chatgpt_new_thread to start a fresh topic. " +
			"This is a real-time external service: replies can take 5-60 seconds.",
		parameters: {
			type: "object",
			properties: {
				prompt: { type: "string", description: "The message to send to ChatGPT." },
				thread: { type: "string", description: "Thread name to continue (default: \"default\")." }
			},
			required: ["prompt"],
			additionalProperties: false
		},
		output: {
			schema: {
				type: "object",
				properties: {
					reply: { type: "string" },
					thread: { type: "string" },
					historyMessages: { type: "number" }
				},
				required: ["reply", "thread", "historyMessages"],
				additionalProperties: false
			},
			render: (_args, value) => [{ type: "text", text: value.reply }]
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Ask ChatGPT${args.thread ? ` (${args.thread})` : ""}`,
			kind: "other",
			rawInput: args.prompt
		}),
		timeoutMs: resolved.timeoutMs,
		async execute(args, exec) {
			if (typeof args?.prompt !== "string" || args.prompt.trim().length === 0) {
				throw new Error("prompt is required");
			}
			// Explicit thread wins; otherwise use this session's /chatgpt use binding.
			const thread = args.thread ? sanitizeThreadName(args.thread) : boundThread(exec.agent);
			return chat(thread, args.prompt, exec.signal);
		}
	});

	// Shared thread listing used by both the tool and the /chatgpt command.
	const listThreads = async () => {
		await fsp.mkdir(resolved.threadsDir, { recursive: true });
		const files = (await fsp.readdir(resolved.threadsDir)).filter((f) => f.endsWith(".jsonl"));
		const threads = [];
		for (const f of files) {
			const records = await loadThread(path.join(resolved.threadsDir, f));
			const last = records[records.length - 1];
			const firstUser = records.find((r) => r.role === "user");
			threads.push({
				name: f.slice(0, -6),
				messages: records.length,
				lastAt: last?.ts ?? 0,
				preview: firstUser?.content.slice(0, 80) ?? ""
			});
		}
		threads.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
		return { threads };
	};

	ctx.tools.register({
		name: "chatgpt_list_threads",
		description: "List all ChatGPT bridge threads (name, message count, last activity, preview).",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		output: {
			schema: {
				type: "object",
				properties: {
					threads: {
						type: "array",
						items: {
							type: "object",
							properties: {
								name: { type: "string" },
								messages: { type: "number" },
								lastAt: { type: "number" },
								preview: { type: "string" }
							},
							required: ["name", "messages", "lastAt", "preview"],
							additionalProperties: false
						}
					}
				},
				required: ["threads"],
				additionalProperties: false
			},
			render: (_args, value) => [
				{
					type: "text",
					text: value.threads.length
						? value.threads.map((t) => `${t.name}: ${t.messages} msgs — ${t.preview}`).join("\n")
						: "(no threads yet)"
				}
			]
		},
		async execute() {
			return listThreads();
		}
	});

	ctx.tools.register({
		name: "chatgpt_new_thread",
		description: "Create a fresh ChatGPT bridge thread (empty history). Returns the thread name; created=false if it already exists.",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "Thread name; a timestamped name is generated when omitted." }
			},
			additionalProperties: false
		},
		output: {
			schema: {
				type: "object",
				properties: { thread: { type: "string" }, created: { type: "boolean" } },
				required: ["thread", "created"],
				additionalProperties: false
			},
			render: (_args, value) => [
				{ type: "text", text: value.created ? `thread "${value.thread}" created` : `thread "${value.thread}" already exists` }
			]
		},
		async execute(args) {
			const thread = sanitizeThreadName(args?.name ?? `thread-${Date.now()}`);
			const file = threadFile(thread);
			let created = false;
			try {
				await fsp.access(file);
			} catch {
				await appendThread(file, []);
				created = true;
			}
			return { thread, created };
		}
	});

	ctx.tools.register({
		name: "chatgpt_clear_thread",
		description: "Reset a ChatGPT bridge thread: delete its stored history. The next chatgpt_chat call on it starts fresh.",
		parameters: {
			type: "object",
			properties: {
				thread: { type: "string", description: "Thread name to clear." }
			},
			required: ["thread"],
			additionalProperties: false
		},
		output: {
			schema: {
				type: "object",
				properties: { thread: { type: "string" }, removed: { type: "number" } },
				required: ["thread", "removed"],
				additionalProperties: false
			},
			render: (_args, value) => [
				{ type: "text", text: `thread "${value.thread}" cleared (${value.removed} messages removed)` }
			]
		},
		async execute(args) {
			const thread = sanitizeThreadName(args?.thread);
			const records = await loadThread(threadFile(thread));
			await fsp.unlink(threadFile(thread)).catch(() => {});
			return { thread, removed: records.length };
		}
	});

	// Human-command plane: /chatgpt — chat directly with ChatGPT and manage
	// threads, without any model turn. Grammar (rawInput):
	//   /chatgpt <prompt>        chat on this session's bound thread
	//   /chatgpt list            list stored threads
	//   /chatgpt use <name>      bind this dsh session to a thread
	//   /chatgpt new <name>      create a fresh thread
	//   /chatgpt clear <name>    reset a thread
	//   /chatgpt                 usage help
	ctx.effect(() =>
			ctx.commands.register({
				name: "chatgpt",
				description: "Chat with ChatGPT directly (no model turn): /chatgpt <prompt> | list | use <name> | new <name> | clear <name>",
				handler: async (invocation) => {
					const agent = invocation.agent;
					const signal = invocation.signal;
					const raw = invocation.rawInput.trim();
					const [head, ...rest] = raw.split(/\s+/);
					const arg = rest.join(" ").trim();
					try {
						if (!raw) {
							return {
								kind: "success",
								text: [
									`chatgpt-bridge — current thread: ${boundThread(agent)}`,
									"",
									"/chatgpt <prompt>        chat (on this session's bound thread)",
									"/chatgpt list            list stored threads",
									'/chatgpt use <name>      bind this session to a thread (e.g. "投资A")',
									"/chatgpt new <name>      create a fresh thread",
									"/chatgpt clear <name>    reset a thread"
								].join("\n")
							};
						}
						if (head === "list") {
							const { threads } = await listThreads();
							return {
								kind: "success",
								text: threads.length
									? threads.map((t) => `${t.name}: ${t.messages} msgs — ${t.preview}`).join("\n")
									: "(no threads yet)"
							};
						}
						if (head === "use") {
							if (!arg) return { kind: "error", text: "usage: /chatgpt use <name>" };
							const thread = sanitizeThreadName(arg);
							const records = await loadThread(threadFile(thread));
							if (records.length === 0 && (await fsp.readdir(resolved.threadsDir).catch(() => [])).every((f) => f !== `${thread}.jsonl`)) {
								await appendThread(threadFile(thread), []);
							}
							sessionThreads.set(agent?.session?.header?.id, thread);
							return { kind: "success", text: `this session is now bound to thread "${thread}" (${records.length} messages)` };
						}
						if (head === "new") {
							if (!arg) return { kind: "error", text: "usage: /chatgpt new <name>" };
							const thread = sanitizeThreadName(arg);
							let created = false;
							try {
								await fsp.access(threadFile(thread));
							} catch {
								await appendThread(threadFile(thread), []);
								created = true;
							}
							return { kind: "success", text: created ? `thread "${thread}" created` : `thread "${thread}" already exists` };
						}
						if (head === "clear") {
							if (!arg) return { kind: "error", text: "usage: /chatgpt clear <name>" };
							const thread = sanitizeThreadName(arg);
							const records = await loadThread(threadFile(thread));
							await fsp.unlink(threadFile(thread)).catch(() => {});
							return { kind: "success", text: `thread "${thread}" cleared (${records.length} messages removed)` };
						}
						// Default: chat on the session-bound thread.
						const thread = boundThread(agent);
						const result = await chat(thread, raw, signal);
						return { kind: "success", text: `${result.reply}\n\n(thread: ${thread})` };
					} catch (err) {
						return { kind: "error", text: `chatgpt: ${err?.message ?? String(err)}` };
					}
				}
			}),
			"chatgpt-bridge: command"
		);
}

export { apply, buildPrompt, inject, name, sanitizeThreadName };
