import {
	type ChildProcess,
	execFileSync,
	type SpawnOptions,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { renameSync, symlinkSync } from "node:fs";
import {
	chmod,
	link,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import {
	captureMessagesDiagnosticDirectory,
	MessagesDiagnosticFile,
} from "./messages-diagnostic-file.js";

const race = vi.hoisted(() => ({
	marker: "",
	inject: "",
	beforeSpawn: undefined as undefined | (() => void),
	mutate: undefined as undefined | (() => Promise<void>),
	children: [] as { exited: boolean }[],
	openBarrier: undefined as
		| undefined
		| ((handle: import("node:fs/promises").FileHandle) => Promise<void>),
}));
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: ((
			command: string,
			args: readonly string[] = [],
			options: SpawnOptions = {},
		) => {
			let changed: string[] = [...args];
			const mutate = race.mutate;
			if (mutate && race.marker) {
				if (typeof args?.[1] !== "string" || !args[1].includes(race.marker))
					throw Error("missing test race boundary");
				changed = [...args];
				changed[1] = args[1].replace(
					race.marker,
					`fs.writeSync(4,'ready');fs.readSync(5,Buffer.alloc(1),0,1,null);${race.marker}`,
				);
				race.mutate = undefined;
			}
			if (race.inject && race.marker) {
				changed[1] =
					changed[1]?.replace(race.marker, race.inject + race.marker) ?? "";
				race.inject = "";
			}
			race.beforeSpawn?.();
			race.beforeSpawn = undefined;
			const child: ChildProcess = actual.spawn(
				command,
				changed,
				mutate
					? {
							...options,
							stdio: [
								...(options.stdio as readonly unknown[]),
								"pipe",
								"pipe",
							] as never,
						}
					: options,
			);
			const record = { exited: false };
			race.children.push(record);
			child.once("close", () => {
				record.exited = true;
			});
			if (mutate)
				(child.stdio[4] as Readable).once("data", () => {
					void mutate().finally(() => {
						(
							(child.stdio as Array<Readable | Writable | null>)[5] as Writable
						).end("x");
					});
				});
			return child;
		}) as unknown as typeof actual.spawn,
	};
});
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			const barrier = race.openBarrier;
			if (barrier) {
				race.openBarrier = undefined;
				await barrier(handle);
			}
			return handle;
		},
	};
});
afterEach(() => {
	race.marker = "";
	race.inject = "";
	race.beforeSpawn = undefined;
	race.mutate = undefined;
	race.children = [];
	race.openBarrier = undefined;
});

async function fixture() {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "messages-safe-file-")),
	);
	const ref = randomUUID();
	await mkdir(join(root, ref), { mode: 0o700 });
	const directory = await captureMessagesDiagnosticDirectory(root, ref);
	return {
		root,
		ref,
		directory,
		leaf: join(root, ref, "messages-diagnostics.json"),
		async close() {
			await rm(root, { recursive: true });
		},
	};
}

it("preserves atomic JSON and private mode through reopen", async () => {
	const f = await fixture();
	try {
		const file = await MessagesDiagnosticFile.open(f.directory, {
			schemaVersion: 1,
			entries: [] as string[],
		});
		await file.update((x) => x.entries.push("safe"));
		await file.close();
		const next = await MessagesDiagnosticFile.open(f.directory, {
			schemaVersion: 1,
			entries: [] as string[],
		});
		expect(next.read()).toEqual({ schemaVersion: 1, entries: ["safe"] });
		await next.close();
		expect(race.children.every((x) => x.exited)).toBe(true);
	} finally {
		await f.close();
	}
});

it.each(["symlink", "fifo", "hardlink", "oversized", "mode"] as const)(
	"rejects a racing %s before reading its content",
	async (kind) => {
		const f = await fixture();
		const outside = await mkdtemp(join(tmpdir(), "messages-safe-outside-"));
		try {
			const foreign = join(outside, "foreign");
			await writeFile(foreign, '{"secret":"synthetic-private"}', {
				mode: 0o600,
			});
			race.marker = "if(value.operation==='read'){";
			race.mutate = async () => {
				if (kind === "symlink") await symlink(foreign, f.leaf);
				else if (kind === "fifo") execFileSync("mkfifo", [f.leaf]);
				else if (kind === "hardlink") await link(foreign, f.leaf);
				else if (kind === "oversized")
					await writeFile(f.leaf, '"' + "界".repeat(90000) + '"', {
						mode: 0o600,
					});
				else {
					await writeFile(f.leaf, "{}", { mode: 0o600 });
					await chmod(f.leaf, 0o644);
				}
			};
			await expect(
				MessagesDiagnosticFile.open(f.directory, {}),
			).rejects.toThrow("RUNTIME_MESSAGES_DIAGNOSTIC_UNAVAILABLE");
			expect(race.children.every((x) => x.exited)).toBe(true);
			expect(await readFile(foreign, "utf8")).toBe(
				'{"secret":"synthetic-private"}',
			);
		} finally {
			await f.close();
			await rm(outside, { recursive: true });
		}
	},
);

it("does not reinterpret an existing JSON null as a missing sidecar", async () => {
	const f = await fixture();
	try {
		await writeFile(f.leaf, "null", { mode: 0o600 });
		const file = await MessagesDiagnosticFile.open(f.directory, {
			initial: true,
		});
		expect(file.read()).toBeNull();
		await file.close();
	} finally {
		await f.close();
	}
});

it("rejects the replacement of the captured Session identity before child entry", async () => {
	const f = await fixture();
	try {
		await rename(join(f.root, f.ref), join(f.root, "old"));
		await mkdir(join(f.root, f.ref), { mode: 0o700 });
		await expect(MessagesDiagnosticFile.open(f.directory, {})).rejects.toThrow(
			"RUNTIME_MESSAGES_DIAGNOSTIC_UNAVAILABLE",
		);
	} finally {
		await f.close();
	}
});

it.each(["root", "session"] as const)(
	"keeps writes anchored after %s rename and replacement",
	async (target) => {
		const f = await fixture();
		const outside = await mkdtemp(join(tmpdir(), "messages-safe-outside-"));
		let displaced: string | undefined;
		try {
			const file = await MessagesDiagnosticFile.open(f.directory, {
				entries: [] as string[],
			});
			race.marker = "if(value.operation==='read'){";
			race.mutate = async () => {
				const original = target === "root" ? f.root : join(f.root, f.ref);
				displaced = original + "-old";
				await rename(original, displaced);
				await symlink(outside, original);
			};
			await file.update((x) => x.entries.push("safe"));
			await file.close();
			await expect(
				readFile(join(outside, "messages-diagnostics.json"), "utf8"),
			).rejects.toMatchObject({ code: "ENOENT" });
			const saved =
				target === "root"
					? join(displaced ?? "", f.ref, "messages-diagnostics.json")
					: join(displaced ?? "", "messages-diagnostics.json");
			expect(JSON.parse(await readFile(saved, "utf8"))).toEqual({
				entries: ["safe"],
			});
		} finally {
			if (displaced) {
				const original = target === "root" ? f.root : join(f.root, f.ref);
				await rm(original);
				await rename(displaced, original);
			}
			await f.close();
			await rm(outside, { recursive: true });
		}
	},
);

it("bounds actual bytes if the opened file grows after fstat", async () => {
	const f = await fixture();
	try {
		await writeFile(f.leaf, "{}", { mode: 0o600 });
		race.marker = "const bytes=Buffer.alloc(limit+1)";
		race.mutate = async () => {
			await writeFile(f.leaf, '"' + "界".repeat(90000) + '"');
		};
		await expect(MessagesDiagnosticFile.open(f.directory, {})).rejects.toThrow(
			"RUNTIME_MESSAGES_DIAGNOSTIC_UNAVAILABLE",
		);
		expect(race.children.every((x) => x.exited)).toBe(true);
	} finally {
		await f.close();
	}
});

it("kills and reaps only its bounded diagnostic child at the private deadline", async () => {
	const f = await fixture();
	let entered!: () => void;
	const ready = new Promise<void>((resolve) => {
		entered = resolve;
	});
	try {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		race.marker = "if(value.operation==='read'){";
		race.mutate = () => {
			entered();
			return new Promise<void>(() => {});
		};
		const opening = MessagesDiagnosticFile.open(f.directory, {});
		const rejected = expect(opening).rejects.toThrow(
			"RUNTIME_MESSAGES_DIAGNOSTIC_UNAVAILABLE",
		);
		await ready;
		await vi.advanceTimersByTimeAsync(5000);
		await rejected;
		expect(race.children.every((child) => child.exited)).toBe(true);
	} finally {
		vi.useRealTimers();
		await f.close();
	}
});

it.each(["symlink", "fifo"] as const)(
	"atomically replaces a racing %s leaf without following its content",
	async (kind) => {
		const f = await fixture();
		const outside = await mkdtemp(join(tmpdir(), "messages-write-outside-"));
		try {
			const target = join(outside, "untouched");
			await writeFile(target, "original", { mode: 0o600 });
			const file = await MessagesDiagnosticFile.open(f.directory, {
				entries: [] as string[],
			});
			race.marker = "if(value.operation==='read'){";
			race.mutate = async () => {
				if (kind === "symlink") await symlink(target, f.leaf);
				else execFileSync("mkfifo", [f.leaf]);
			};
			await file.update((draft) => draft.entries.push("safe"));
			await file.close();
			expect(await readFile(target, "utf8")).toBe("original");
			expect(JSON.parse(await readFile(f.leaf, "utf8"))).toEqual({
				entries: ["safe"],
			});
		} finally {
			await f.close();
			await rm(outside, { recursive: true });
		}
	},
);

it.each(["invalid-json", "invalid-utf8", "empty"] as const)(
	"rejects %s content without using the initial state",
	async (value) => {
		const f = await fixture();
		try {
			await writeFile(
				f.leaf,
				value === "invalid-json"
					? "not-json"
					: value === "empty"
						? ""
						: Buffer.from([0xff, 0xfe]),
				{ mode: 0o600 },
			);
			await expect(
				MessagesDiagnosticFile.open(f.directory, { replacement: true }),
			).rejects.toThrow("RUNTIME_MESSAGES_DIAGNOSTIC_UNAVAILABLE");
		} finally {
			await f.close();
		}
	},
);

it("rejects a root replaced between parent open and child cwd entry", async () => {
	const f = await fixture();
	const outside = await mkdtemp(join(tmpdir(), "messages-root-outside-"));
	const old = f.root + "-old";
	let replaced = false;
	try {
		race.beforeSpawn = () => {
			renameSync(f.root, old);
			symlinkSync(outside, f.root);
			replaced = true;
		};
		await expect(MessagesDiagnosticFile.open(f.directory, {})).rejects.toThrow(
			"RUNTIME_MESSAGES_DIAGNOSTIC_UNAVAILABLE",
		);
		expect(race.children.every((x) => x.exited)).toBe(true);
	} finally {
		if (replaced) {
			await rm(f.root);
			await rename(old, f.root);
		}
		await f.close();
		await rm(outside, { recursive: true });
	}
});

it("rejects a Session replaced after descriptor open and before chdir", async () => {
	const f = await fixture();
	const outside = await mkdtemp(join(tmpdir(), "messages-session-outside-"));
	const original = join(f.root, f.ref);
	const old = original + "-old";
	let replaced = false;
	try {
		race.marker = "process.chdir(value.sessionRef);";
		race.mutate = async () => {
			await rename(original, old);
			await symlink(outside, original);
			replaced = true;
		};
		await expect(MessagesDiagnosticFile.open(f.directory, {})).rejects.toThrow(
			"RUNTIME_MESSAGES_DIAGNOSTIC_UNAVAILABLE",
		);
		await expect(
			readFile(join(outside, "messages-diagnostics.json")),
		).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		if (replaced) {
			await rm(original);
			await rename(old, original);
		}
		await f.close();
		await rm(outside, { recursive: true });
	}
});

it("caps child output and discards native stderr rather than exposing it", async () => {
	const f = await fixture();
	try {
		race.marker = "if(value.operation==='read'){";
		race.inject =
			"process.stderr.write('synthetic-private-error');process.stdout.write(Buffer.alloc(limit+2,120));";
		await expect(MessagesDiagnosticFile.open(f.directory, {})).rejects.toThrow(
			/^RUNTIME_MESSAGES_DIAGNOSTIC_UNAVAILABLE$/,
		);
		expect(race.children.every((x) => x.exited)).toBe(true);
		race.marker = "if(value.operation==='read'){";
		race.inject = "process.stderr.write('synthetic-private-error');";
		const file = await MessagesDiagnosticFile.open(f.directory, { safe: true });
		expect(file.read()).toEqual({ safe: true });
		await file.close();
	} finally {
		await f.close();
	}
});

it("measures a normal read and two atomic writes without a resident child", async () => {
	const f = await fixture();
	try {
		const start = performance.now();
		const file = await MessagesDiagnosticFile.open(f.directory, {
			phase: "none",
		});
		const opened = performance.now();
		await file.update((x) => {
			x.phase = "sent";
		});
		const sent = performance.now();
		await file.update((x) => {
			x.phase = "completed";
		});
		await file.close();
		const finished = performance.now();
		expect(race.children).toHaveLength(3);
		expect(race.children.every((x) => x.exited)).toBe(true);
		console.info(
			JSON.stringify({
				kind: "diagnostic-local-cost",
				platform: process.platform,
				openMs: Math.round(opened - start),
				firstWriteMs: Math.round(sent - opened),
				secondWriteMs: Math.round(finished - sent),
				totalMs: Math.round(finished - start),
				childCount: race.children.length,
			}),
		);
	} finally {
		await f.close();
	}
});

it.each([
	"initialization",
	"before-write",
	"after-write",
	"native-close-error",
] as const)(
	"quiesces a Session diagnostic child before close permits immediate directory removal: %s",
	async (stage) => {
		const { SessionRuntimeDriver } = await import(
			"./session-runtime-driver.js"
		);
		const root = await realpath(
			await mkdtemp(join(tmpdir(), "diagnostic-close-race-")),
		);
		let receipt:
			| import("./messages-model-transport.js").RuntimeMessagesDiagnosticReceipt
			| undefined;
		let entered!: () => void;
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const runtime = await SessionRuntimeDriver.open({
			path: root,
			configVersion: "close-configuration",
			defaultModelOptionId: "primary",
			defaultReasoningLevel: "high",
			modelOptions: [
				{
					modelOptionId: "primary",
					nativeModelId: "configured/model",
					reasoningLevels: ["high"],
				},
			],
			cursorPrefix: "test",
			retireSession: async () => {},
			completionStatus: () => "completed",
			openSession: async (options) => ({
				nativeId: "native-close",
				select: async () => {},
				cancel: async () => {},
				close: async () => {
					if (stage === "native-close-error")
						throw Error("synthetic native close failure");
				},
				prompt: async () => {
					const model = options.modelFact?.();
					if (!model) throw Error();
					const operationRef = randomUUID();
					const attemptRef = randomUUID();
					await options.recordOperationFact?.({
						kind: "model",
						operationRef,
						attemptRef,
						phase: "intent",
						model,
					});
					await options.recordOperationFact?.({
						kind: "model",
						operationRef,
						attemptRef,
						phase: "started",
						model,
					});
					receipt = options.openDiagnosticReceipt?.();
					await options.admit();
					await options.recordOperationFact?.({
						kind: "model",
						operationRef,
						attemptRef,
						phase: "completed",
						model,
					});
					return { stopReason: "completed" };
				},
			}),
		});
		let recording: Promise<void> | undefined;
		try {
			const accepted = await runtime.execute({
				schemaVersion: 2,
				kind: "submit-turn",
				agentId: "agent-close",
				conversationId: "conversation-close",
				sessionGeneration: 1,
				executionId: "execution-close",
				turnId: "turn-close",
				operationId: "operation-close",
				input: { text: "synthetic input", attachments: [] },
				selection: {
					schemaVersion: 1,
					modelOptionId: "primary",
					reasoningLevel: "high",
				},
			});
			await vi.waitFor(async () =>
				expect(
					await runtime.getStatus(accepted.nativeSessionRef, "execution-close"),
				).toBe("completed"),
			);
			if (!receipt) throw Error();
			if (stage !== "initialization")
				await receipt("sent", false, {
					stage: "upstream_http",
					sent: false,
					durationMs: 0,
				});
			race.marker =
				stage === "initialization"
					? "if(value.operation==='read'){"
					: stage === "after-write"
						? "fs.renameSync(tmp,leaf);"
						: "tmp='.'+leaf";
			race.mutate = () => {
				entered();
				return held;
			};
			recording = receipt("unknown", false, {
				stage: "upstream_http",
				sent: true,
				statusCode: 502,
				statusClass: "5xx",
				durationMs: 2,
			});
			await ready;
			const closing = runtime.close();
			expect(runtime.close()).toBe(closing);
			if (stage === "native-close-error")
				await expect(closing).rejects.toThrow("synthetic native close failure");
			else await closing;
			expect(race.children.at(-1)?.exited).toBe(true);
			await rm(root, { recursive: true });
			await recording;
			await expect(
				readFile(
					join(root, accepted.nativeSessionRef, "messages-diagnostics.json"),
				),
			).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			release();
			await recording;
			await runtime.close().catch(() => {});
			await rm(root, { recursive: true, force: true });
		}
	},
);

it("cancels a pending root open before any child can spawn", async () => {
	const f = await fixture();
	let entered!: () => void;
	const ready = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let fd: import("node:fs/promises").FileHandle | undefined;
	const controller = new AbortController();
	try {
		race.openBarrier = async (handle) => {
			fd = handle;
			entered();
			await held;
		};
		const opening = MessagesDiagnosticFile.open(
			f.directory,
			{},
			controller.signal,
		);
		const failed = expect(opening).rejects.toBeDefined();
		await ready;
		controller.abort();
		release();
		await failed;
		expect(race.children).toHaveLength(0);
		await expect(fd?.stat()).rejects.toMatchObject({ code: "EBADF" });
	} finally {
		release();
		await f.close();
	}
});

it("drops queued diagnostic updates and reaps the active writer before close", async () => {
	const f = await fixture();
	let entered!: () => void;
	const ready = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let file: MessagesDiagnosticFile<{ phase: string }> | undefined;
	try {
		file = await MessagesDiagnosticFile.open(f.directory, { phase: "initial" });
		race.marker = "tmp='.'+leaf";
		race.mutate = () => {
			entered();
			return held;
		};
		const first = file.update((value) => {
			value.phase = "first";
		});
		const result = first.catch(() => {});
		await ready;
		const queued = Array.from({ length: 8 }, () =>
			file?.update((value) => {
				value.phase = "queued";
			}),
		);
		const closing = file.close();
		expect(file.close()).toBe(closing);
		await closing;
		await result;
		await Promise.all(queued);
		expect(race.children).toHaveLength(2);
		expect(race.children.every((child) => child.exited)).toBe(true);
		await rm(join(f.root, f.ref), { recursive: true });
	} finally {
		release();
		await file?.close();
		await f.close();
	}
});
