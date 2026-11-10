import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

export * from "./codex-session-executor-binding.js";

import {
	CODEX_SESSION_EXECUTOR_BACKEND,
	CODEX_SESSION_EXECUTOR_STATUS,
	type CodexSessionExecutorBindingV1,
	codexSessionExecutorBindingDigestV1,
	parseCodexSessionExecutorBindingV1,
} from "./codex-session-executor-binding.js";

const id = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[\x21-\x7e]+$/);
const revision = z.number().int().positive().safe();
function invalid(): never {
	throw new Error("CODEX_SESSION_EXECUTOR_INVALID");
}

/** Only the trusted init container mounts the PVC root; the executor mounts its workspace subPath. */
export async function initializeCodexSessionExecutorWorkspaceV1(
	input: unknown,
): Promise<void> {
	const binding = parseCodexSessionExecutorBindingV1(input);
	const root = "/workspace";
	const base = await lstat(root);
	if (!base.isDirectory() || base.isSymbolicLink()) invalid();
	const directory = async (
		path: string,
		create: boolean,
		allowLegacyRuntime = false,
	) => {
		if (create)
			await mkdir(path, { mode: 0o700 }).catch(
				(error: NodeJS.ErrnoException) => {
					if (error.code !== "EEXIST") throw error;
				},
			);
		const info = await lstat(path);
		const legacyRuntime =
			allowLegacyRuntime &&
			path === "/workspace/runtime" &&
			(info.mode & 0o7777) === 0o755;
		if (
			!info.isDirectory() ||
			info.isSymbolicLink() ||
			info.uid !== process.getuid?.() ||
			((info.mode & 0o077) !== 0 && !legacyRuntime)
		)
			invalid();
		return info;
	};
	const runtime = await directory("/workspace/runtime", true, true);
	const legacyRuntime = (runtime.mode & 0o7777) === 0o755;
	const missing = (error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	};
	const statePath = "/workspace/runtime/codex-driver.json";
	const state = await lstat(statePath).catch(missing);
	const native = await lstat(`${statePath}.native`).catch(missing);
	// Never turn a lost mapping with surviving native data into an empty Session.
	if (
		(state && (!state.isFile() || state.isSymbolicLink())) ||
		(!state && native)
	)
		invalid();
	if (!state) {
		const file = await open(
			statePath,
			constants.O_CREAT |
				constants.O_EXCL |
				constants.O_WRONLY |
				constants.O_NOFOLLOW,
			0o600,
		);
		try {
			await file.writeFile(
				JSON.stringify({ schemaVersion: 2, sessions: {}, operations: {} }) +
					"\n",
			);
			await file.sync();
		} finally {
			await file.close();
		}
		const parent = await open("/workspace/runtime", constants.O_RDONLY);
		try {
			await parent.sync();
		} finally {
			await parent.close();
		}
	}
	let newGeneration = false;
	if (state) {
		const file = await open(
			statePath,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		try {
			const info = await file.stat();
			if (
				!info.isFile() ||
				info.nlink !== 1 ||
				info.ino !== state.ino ||
				info.dev !== state.dev ||
				info.uid !== process.getuid?.() ||
				(info.mode & 0o077) !== 0
			)
				invalid();
			const saved = z
				.object({
					schemaVersion: z.literal(2),
					sessions: z.record(
						z.string(),
						z.object({
							agentId: id,
							conversationId: id,
							sessionGeneration: revision,
						}),
					),
				})
				.parse(JSON.parse(await file.readFile("utf8")));
			const after = await file.stat();
			if (
				after.size !== info.size ||
				after.mtimeMs !== info.mtimeMs ||
				after.ctimeMs !== info.ctimeMs
			)
				invalid();
			const sessions = Object.values(saved.sessions);
			if (
				legacyRuntime &&
				(sessions.length === 0 ||
					!sessions.every(
						(session) =>
							session.agentId === binding.agentId &&
							session.conversationId === binding.conversationId &&
							session.sessionGeneration <= binding.sessionGeneration,
					))
			)
				invalid();
			newGeneration =
				sessions.length > 0 &&
				sessions.every(
					(session) =>
						session.agentId === binding.agentId &&
						session.conversationId === binding.conversationId &&
						session.sessionGeneration < binding.sessionGeneration,
				);
		} finally {
			await file.close();
		}
	}
	let current = root;
	for (const [index, part] of binding.workspaceSubPath.split("/").entries()) {
		current = posix.join(current, part);
		// Only the new generation's own directories may be created; retained native parents must survive.
		await directory(
			current,
			!state || (newGeneration && index >= 3),
			legacyRuntime,
		);
	}
	await directory(
		posix.join(posix.dirname(binding.workspaceRoot), "home"),
		!state || newGeneration,
	);
	// Earlier single-container Sessions created this parent with mkdir's default mode.
	if (legacyRuntime) {
		const file = await open(
			"/workspace/runtime",
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
		);
		try {
			const pinned = await file.stat();
			if (
				!pinned.isDirectory() ||
				pinned.uid !== runtime.uid ||
				pinned.ino !== runtime.ino ||
				pinned.dev !== runtime.dev ||
				(pinned.mode & 0o7777) !== 0o755
			)
				invalid();
			await file.chmod(0o700);
			await file.sync();
			const after = await lstat("/workspace/runtime");
			if (
				after.ino !== runtime.ino ||
				after.dev !== runtime.dev ||
				(after.mode & 0o7777) !== 0o700
			)
				invalid();
		} finally {
			await file.close();
		}
	}
}

export interface CodexSessionExecutorStatusV1 {
	schemaVersion: 1;
	podUid: string;
	bindingDigest: string;
	epoch: string;
	ready: boolean;
}

/** Trusted deployment object; never assembled from native frames or a wire command. */
export interface CodexSessionExecutorAdmissionV1 {
	readonly binding: CodexSessionExecutorBindingV1;
	readonly epoch: string;
	assertCurrent(): Promise<void>;
	onFailure(listener: () => void): () => void;
	close(): Promise<void>;
}

export async function openCodexSessionExecutorAdmissionV1(
	input: CodexSessionExecutorBindingV1,
	podUid: string,
	options: {
		fetch?: typeof fetch;
		startupTimeoutMs?: number;
		pollIntervalMs?: number;
	} = {},
): Promise<CodexSessionExecutorAdmissionV1> {
	const binding = parseCodexSessionExecutorBindingV1(input);
	if (!podUid || podUid.length > 256) invalid();
	const fetcher = options.fetch ?? fetch;
	const digest = codexSessionExecutorBindingDigestV1(binding);
	let pinnedEpoch: string | undefined;
	let failed = false;
	let closed = false;
	const listeners = new Set<() => void>();
	const lifetimeAbort = new AbortController();
	const fail = () => {
		if (!failed) {
			failed = true;
			for (const listener of [...listeners]) {
				try {
					listener();
				} catch {
					/* The gate stays closed. */
				}
			}
		}
		return invalid();
	};
	const checkStatus = (text: string): string => {
		if (text.length > 4096) invalid();
		const value = JSON.parse(text) as CodexSessionExecutorStatusV1;
		if (
			value.schemaVersion !== 1 ||
			value.podUid !== podUid ||
			value.bindingDigest !== digest ||
			value.ready !== true ||
			!/^[-a-f0-9]{36}$/.test(value.epoch) ||
			(pinnedEpoch !== undefined && value.epoch !== pinnedEpoch)
		)
			invalid();
		return value.epoch;
	};
	const read = async (): Promise<string> => {
		const response = await fetcher(CODEX_SESSION_EXECUTOR_STATUS, {
			redirect: "error",
			signal: AbortSignal.timeout(1000),
		});
		if (!response.ok) invalid();
		const reader = response.body?.getReader();
		if (!reader) invalid();
		let text = "";
		try {
			while (true) {
				const item = await reader.read();
				if (item.done) break;
				text += new TextDecoder().decode(item.value);
				if (text.length > 4096) invalid();
			}
			return checkStatus(text);
		} finally {
			void reader.cancel().catch(() => {});
		}
	};
	const deadline = Date.now() + (options.startupTimeoutMs ?? 15000);
	while (pinnedEpoch === undefined) {
		try {
			pinnedEpoch = await read();
		} catch {
			if (Date.now() >= deadline) invalid();
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	let lastHeartbeat = Date.now();
	let finishLifetime: Promise<void>;
	let lifetimeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let headerTimeout: ReturnType<typeof setTimeout> | undefined;
	try {
		headerTimeout = setTimeout(() => lifetimeAbort.abort(), 1000);
		const response = await fetcher("http://127.0.0.1:8068/lifetime", {
			redirect: "error",
			signal: lifetimeAbort.signal,
		});
		clearTimeout(headerTimeout);
		if (!response.ok || !response.body) invalid();
		const reader = response.body.getReader();
		lifetimeReader = reader;
		let buffer = "";
		const first = await Promise.race([
			reader.read(),
			new Promise<never>((_, reject) =>
				setTimeout(
					() => reject(new Error("CODEX_SESSION_EXECUTOR_INVALID")),
					1000,
				).unref(),
			),
		]);
		if (first.done) invalid();
		buffer = new TextDecoder().decode(first.value);
		const consume = () => {
			if (buffer.length > 4096) invalid();
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				checkStatus(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				lastHeartbeat = Date.now();
				newline = buffer.indexOf("\n");
			}
		};
		consume();
		finishLifetime = (async () => {
			try {
				while (!closed) {
					const item = await reader.read();
					if (item.done) invalid();
					buffer += new TextDecoder().decode(item.value);
					consume();
				}
			} finally {
				void reader.cancel().catch(() => {});
			}
		})().catch(() => {
			if (!closed) {
				try {
					fail();
				} catch {
					/* Sticky rejection is observed by callers. */
				}
			}
		});
	} catch {
		clearTimeout(headerTimeout);
		lifetimeAbort.abort();
		void lifetimeReader?.cancel().catch(() => {});
		return invalid();
	}
	const assertCurrent = async () => {
		if (failed || closed || Date.now() - lastHeartbeat > 1000) return fail();
		try {
			await read();
			if (failed || closed || Date.now() - lastHeartbeat > 1000) return fail();
		} catch {
			return fail();
		}
	};
	let checking = false;
	const timer = setInterval(() => {
		if (checking || closed || failed) return;
		checking = true;
		void assertCurrent()
			.catch(() => {})
			.finally(() => {
				checking = false;
			});
	}, options.pollIntervalMs ?? 250);
	timer.unref();
	return {
		binding: Object.freeze(binding),
		epoch: pinnedEpoch,
		assertCurrent,
		onFailure(listener) {
			listeners.add(listener);
			if (failed) listener();
			return () => {
				listeners.delete(listener);
			};
		},
		async close() {
			closed = true;
			lifetimeAbort.abort();
			await lifetimeReader?.cancel().catch(() => {});
			clearInterval(timer);
			listeners.clear();
			await finishLifetime;
		},
	};
}

/** Startup-only durable fence: a replacement executor cannot adopt the old instance's work. */
export async function pinCodexSessionExecutorEpochV1(
	directory: string,
	admission: CodexSessionExecutorAdmissionV1,
): Promise<void> {
	await admission.assertCurrent();
	const path = posix.join(
		directory,
		`.executor-${codexSessionExecutorBindingDigestV1(admission.binding)}.json`,
	);
	const bytes = JSON.stringify({ schemaVersion: 1, epoch: admission.epoch });
	let file: Awaited<ReturnType<typeof open>>;
	let created = false;
	try {
		file = await open(
			path,
			constants.O_CREAT |
				constants.O_EXCL |
				constants.O_WRONLY |
				constants.O_NOFOLLOW,
			0o600,
		);
		created = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	}
	try {
		const info = await file.stat();
		if (
			!info.isFile() ||
			info.nlink !== 1 ||
			info.uid !== process.getuid?.() ||
			(info.mode & 0o077) !== 0 ||
			info.size > 256
		)
			invalid();
		if (created) {
			await file.writeFile(bytes);
			await file.sync();
		} else if ((await file.readFile("utf8")) !== bytes) invalid();
	} finally {
		await file.close();
	}
	await admission.assertCurrent();
}

/** Fixed upstream exec-server protocol; used only during credential-free deployment initialization. */
export class CodexExecServerStartupClientV1 {
	private nextId = 0;
	private pending = new Map<
		number,
		{
			resolve(value: unknown): void;
			reject(error: Error): void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	private constructor(private readonly socket: WebSocket) {
		socket.addEventListener("message", (event) => {
			try {
				if (typeof event.data !== "string" || event.data.length > 1024 * 1024)
					throw new Error();
				const frame = JSON.parse(event.data);
				const pending = this.pending.get(frame.id);
				if (!pending) return;
				this.pending.delete(frame.id);
				clearTimeout(pending.timer);
				if (frame.error)
					pending.reject(new Error("CODEX_EXECUTOR_STARTUP_FAILED"));
				else pending.resolve(frame.result);
			} catch {
				this.close();
			}
		});
		for (const event of ["error", "close"])
			socket.addEventListener(event, () => this.close());
	}
	static async open(endpoint = CODEX_SESSION_EXECUTOR_BACKEND) {
		if (endpoint !== CODEX_SESSION_EXECUTOR_BACKEND) invalid();
		const deadline = Date.now() + 5000;
		let socket: WebSocket | undefined;
		while (!socket) {
			const candidate = new WebSocket(endpoint);
			try {
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(() => {
						candidate.close();
						reject(new Error("CODEX_EXECUTOR_STARTUP_FAILED"));
					}, 1000);
					candidate.addEventListener(
						"open",
						() => {
							clearTimeout(timer);
							resolve();
						},
						{ once: true },
					);
					candidate.addEventListener(
						"error",
						() => {
							clearTimeout(timer);
							reject(new Error("CODEX_EXECUTOR_STARTUP_FAILED"));
						},
						{ once: true },
					);
				});
				socket = candidate;
			} catch {
				if (candidate.readyState === WebSocket.OPEN) candidate.close();
				if (Date.now() >= deadline) invalid();
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
		const client = new CodexExecServerStartupClientV1(socket);
		try {
			const result = await client.request("initialize", {
				clientName: "agent-infra-session-startup",
				resumeSessionId: null,
			});
			if (
				!result ||
				typeof (result as { sessionId?: unknown }).sessionId !== "string"
			)
				invalid();
			socket.send(JSON.stringify({ method: "initialized", params: {} }));
			return client;
		} catch (error) {
			client.close();
			throw error;
		}
	}
	request(method: string, params: unknown): Promise<unknown> {
		if (this.socket.readyState !== WebSocket.OPEN)
			return Promise.reject(new Error("CODEX_EXECUTOR_STARTUP_FAILED"));
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error("CODEX_EXECUTOR_STARTUP_FAILED"));
			}, 2000);
			this.pending.set(id, { resolve, reject, timer });
			this.socket.send(JSON.stringify({ id, method, params }));
		});
	}
	close() {
		for (const value of this.pending.values()) {
			clearTimeout(value.timer);
			value.reject(new Error("CODEX_EXECUTOR_STARTUP_FAILED"));
		}
		this.pending.clear();
		if (this.socket.readyState === WebSocket.OPEN) this.socket.close();
	}
}

export async function probeCodexSessionExecutorStartupV1(
	input: unknown,
): Promise<void> {
	const binding = parseCodexSessionExecutorBindingV1(input);
	const client = await CodexExecServerStartupClientV1.open();
	const processId = `startup-${randomUUID()}`;
	const scratch = pathToFileURL(
		`${binding.workspaceRoot}/.executor-${processId}`,
	).href;
	let created = false;
	try {
		await client.request("fs/createDirectory", {
			path: scratch,
			recursive: false,
			followSymlinks: false,
			sandbox: null,
		});
		created = true;
		await client.request("fs/writeFile", {
			path: `${scratch}/input`,
			dataBase64: "b2sK",
			followSymlinks: false,
			sandbox: null,
		});
		await client.request("process/start", {
			processId,
			argv: [
				"/usr/local/bin/node",
				"-e",
				"const f=require('node:fs');if(f.readFileSync('input','utf8')!=='ok\\n')process.exit(41);f.writeFileSync('output','ok\\n',{flag:'wx',mode:384});process.stdout.write('ok\\n');",
			],
			cwd: scratch,
			env: {
				PATH: "/usr/local/bin:/usr/bin:/bin",
				HOME: "/tmp",
				TMPDIR: "/tmp",
			},
			tty: false,
			pipeStdin: false,
			arg0: null,
			sandbox: null,
			enforceManagedNetwork: false,
		});
		let afterSeq = 0;
		let output = "";
		let finished = false;
		for (let count = 0; count < 8; count++) {
			const result = (await client.request("process/read", {
				processId,
				afterSeq,
				maxBytes: 8192,
				waitMs: 500,
			})) as {
				chunks: { seq: number; stream: string; chunk: string }[];
				nextSeq: number;
				exited: boolean;
				closed: boolean;
				exitCode: number | null;
				failure: unknown;
				sandboxDenied: boolean;
			};
			if (
				!Array.isArray(result.chunks) ||
				!Number.isSafeInteger(result.nextSeq) ||
				result.failure ||
				result.sandboxDenied
			)
				invalid();
			for (const chunk of result.chunks)
				output += Buffer.from(chunk.chunk, "base64").toString("utf8");
			if (output.length > 1024) invalid();
			afterSeq = result.nextSeq - 1;
			if (result.exited && result.closed) {
				if (result.exitCode !== 0 || output !== "ok\n") invalid();
				finished = true;
				break;
			}
		}
		if (!finished) invalid();
		const result = (await client.request("fs/readFile", {
			path: `${scratch}/output`,
			followSymlinks: false,
			sandbox: null,
		})) as { dataBase64?: unknown };
		if (result.dataBase64 !== "b2sK") invalid();
	} finally {
		try {
			if (created) {
				// The pinned remote FS rejects recursive no-follow removal. Only these fixed probe files can exist.
				for (const path of [`${scratch}/input`, `${scratch}/output`, scratch])
					await client.request("fs/remove", {
						path,
						recursive: false,
						force: path !== scratch,
						followSymlinks: false,
						sandbox: null,
					});
			}
		} finally {
			client.close();
		}
	}
}
