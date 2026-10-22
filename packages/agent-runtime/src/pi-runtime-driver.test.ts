import { createHash } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FileDescriptorV1 } from "@agent-infra/contracts/files";
import { expect, it, vi } from "vitest";
import {
	PiRuntimeDriver,
	type PiRuntimeDriverOptions,
} from "./pi-runtime-driver.js";
import { createRuntimeFileResultReceiptV1 } from "./runtime-file-bridge.js";
import type { SessionNativeCommandReadContext } from "./session-runtime-driver.js";

const command = {
	schemaVersion: 2 as const,
	kind: "submit-turn" as const,
	agentId: "agent-a",
	conversationId: "conversation-a",
	sessionGeneration: 1,
	executionId: "execution-a",
	turnId: "turn-a",
	operationId: "operation-a",
	input: { text: "synthetic input", attachments: [] },
	selection: {
		schemaVersion: 1 as const,
		modelOptionId: "primary",
		reasoningLevel: "high",
	},
};
async function fixture(mode = "normal", withExecutionKeys = false) {
	const path = await mkdtemp(join(tmpdir(), "pi-driver-"));
	const keyResolvers: Array<() => Promise<string>> = [];
	const authorizeModelAction: NonNullable<
		PiRuntimeDriverOptions["authorizeModelAction"]
	> = async (action) => ({
		relayKey: action.executionId === "execution-a" ? "key-a" : "key-b",
	});
	const launch: PiRuntimeDriverOptions["launch"] = async (
		_directory,
		_selection,
		_admit,
		resolveModelCredential,
	) => {
		if (withExecutionKeys && resolveModelCredential)
			keyResolvers.push(resolveModelCredential);
		return {
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./pi-peer.test-support.mjs", import.meta.url)),
			],
			env: { PI_PEER_MODE: mode },
		};
	};
	const options = {
		path,
		configVersion: "configuration-a",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				nativeModelId: "configured/model",
				reasoningLevels: ["high"],
			},
		],
		...(withExecutionKeys ? { authorizeModelAction } : {}),
		launch,
	};
	let driver = await PiRuntimeDriver.open(options);
	return {
		path,
		get driver() {
			return driver;
		},
		keyResolvers,
		async restart() {
			await driver.close();
			driver = await PiRuntimeDriver.open(options);
		},
		async close() {
			await driver.close();
			await rm(path, { recursive: true, force: true });
		},
	};
}

function resultFileBridge() {
	const writeResult = vi.fn(
		async (
			descriptor: FileDescriptorV1,
			body: ReadableStream<Uint8Array>,
			options?: { workspaceReference: string | null },
		) => {
			for await (const _chunk of body);
			return createRuntimeFileResultReceiptV1(
				{
					actorId: "actor-a",
					channelId: "web",
					agentId: "agent-a",
					conversationId: "conversation-a",
					executionId: "execution-a",
					sessionGeneration: 1,
					grantId: "grant-a",
					expiresAt: Date.now() + 60_000,
					inputFileIds: [],
				},
				{
					schemaVersion: 1,
					fileId: "result-file-pi",
					kind: "result",
					descriptor,
					status: "available",
					createdAt: new Date().toISOString(),
					expiresAt: new Date(Date.now() + 60_000).toISOString(),
				},
				options,
			);
		},
	);
	return {
		writeResult,
		fileBridge: {
			readInput: async () => {
				throw new Error("unused");
			},
			writeResult,
			revalidate: () => {},
		},
	};
}

it("keeps protected Connection MCP unavailable", async () => {
	const value = await fixture();
	try {
		expect(await value.driver.getCapabilities()).toMatchObject({
			connection: false,
			resultFiles: true,
		});
	} finally {
		await value.close();
	}
});

it.each(["result-file", "result-file-edit"] as const)(
	"does not publish a completed Pi %s implicitly while its tool events stay (#3226)",
	async (mode) => {
		const f = await fixture(mode);
		const { writeResult, fileBridge } = resultFileBridge();
		try {
			const accepted = await f.driver.execute(command, { fileBridge });
			await vi.waitFor(
				async () =>
					expect(
						await f.driver.getStatus(
							accepted.nativeSessionRef,
							command.executionId,
						),
					).toBe("completed"),
				{ timeout: 10_000 },
			);
			expect(writeResult).not.toHaveBeenCalled();
			const events = await f.driver.replayEvents(
				accepted.nativeSessionRef,
				command.executionId,
			);
			expect(events.filter((event) => event.type === "file")).toHaveLength(0);
			expect(
				events
					.filter((event) => event.type === "tool")
					.map((event) => event.payload.phase),
			).toEqual(["started", "completed"]);
		} finally {
			await f.close();
		}
	},
	15_000,
);

it("publishes a Pi answer reference to a file produced by the write tool (#3226)", async () => {
	const f = await fixture("result-reference");
	const { writeResult, fileBridge } = resultFileBridge();
	try {
		const accepted = await f.driver.execute(command, { fileBridge });
		await vi.waitFor(
			async () =>
				expect(
					await f.driver.getStatus(
						accepted.nativeSessionRef,
						command.executionId,
					),
				).toBe("completed"),
			{ timeout: 10_000 },
		);
		expect(writeResult).toHaveBeenCalledOnce();
		expect(writeResult.mock.calls[0]?.[0]).toMatchObject({
			name: "chart.png",
			mediaType: "image/png",
		});
		expect(writeResult.mock.calls[0]?.[2]).toEqual({
			workspaceReference: "out/chart.png",
		});
		const files = (
			await f.driver.replayEvents(
				accepted.nativeSessionRef,
				command.executionId,
			)
		).filter((event) => event.type === "file");
		expect(
			files.map((event) =>
				event.schemaVersion === 2 && event.type === "file"
					? event.payload.workspaceReference
					: undefined,
			),
		).toEqual(["out/chart.png"]);
	} finally {
		await f.close();
	}
}, 15_000);

it("ignores failed, unknown, duplicate, outside, symlink, oversized and late Pi tool completions", async () => {
	const f = await fixture("result-file-negative");
	const { writeResult, fileBridge } = resultFileBridge();
	try {
		const accepted = await f.driver.execute(command, { fileBridge });
		await vi.waitFor(
			async () =>
				expect(
					await f.driver.getStatus(
						accepted.nativeSessionRef,
						command.executionId,
					),
				).toBe("completed"),
			{ timeout: 10_000 },
		);
		expect(writeResult).not.toHaveBeenCalled();
		expect(
			(
				await f.driver.replayEvents(
					accepted.nativeSessionRef,
					command.executionId,
				)
			).filter((event) => event.type === "file"),
		).toHaveLength(0);
	} finally {
		await f.close();
	}
}, 15_000);

it("does not publish Pi result files without a request File Bridge", async () => {
	const f = await fixture("result-reference");
	try {
		const accepted = await f.driver.execute(command);
		await vi.waitFor(
			async () =>
				expect(
					await f.driver.getStatus(
						accepted.nativeSessionRef,
						command.executionId,
					),
				).toBe("completed"),
			{ timeout: 10_000 },
		);
		expect(
			(
				await f.driver.replayEvents(
					accepted.nativeSessionRef,
					command.executionId,
				)
			).filter((event) => event.type === "file"),
		).toHaveLength(0);
	} finally {
		await f.close();
	}
}, 15_000);

const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const imageCommand = {
	...command,
	input: { text: "describe this image", attachments: ["file-1"] },
};

/**
 * Request-scoped File Bridge double for one authorized image attachment.
 */
function imageBridge(
	overrides: {
		readonly mediaType?: string;
		readonly sizeBytes?: number;
		readonly sha256?: string;
		readonly revalidate?: () => void;
	} = {},
) {
	const readInput = vi.fn(async (fileId: string) => ({
		fileId,
		descriptor: {
			name: "screen.png",
			mediaType: overrides.mediaType ?? "image/png",
			sizeBytes: overrides.sizeBytes ?? imageBytes.byteLength,
			sha256:
				overrides.sha256 ??
				createHash("sha256").update(imageBytes).digest("hex"),
		},
		body: new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(imageBytes);
				controller.close();
			},
		}),
	}));
	const revalidate = vi.fn(overrides.revalidate);
	return {
		readInput,
		revalidate,
		fileBridge: {
			readInput,
			revalidate,
			writeResult: async () => {
				throw new Error("unused");
			},
		},
	};
}

const piAttachmentRef = (fileId: string) =>
	createHash("sha256").update(fileId).digest("hex").slice(0, 16);

/** #3225：四种常见附件；只有 PNG 另外作为原生图片。 */
const piAttachments: Record<
	string,
	{ name: string; mediaType: string; bytes: Buffer }
> = {
	"file-pdf": {
		name: "report.pdf",
		mediaType: "application/pdf",
		bytes: Buffer.from("%PDF-1.4\n%pi-attachment-pdf\n"),
	},
	"file-csv": {
		name: "table.csv",
		mediaType: "text/csv",
		bytes: Buffer.from("name,value\npi-attachment-csv,1\n"),
	},
	"file-txt": {
		name: "notes.txt",
		mediaType: "text/plain",
		bytes: Buffer.from("pi-attachment-text\n"),
	},
	"file-png": {
		name: "screen.png",
		mediaType: "image/png",
		bytes: Buffer.from(imageBytes),
	},
};

function piAttachmentBridge(reads: string[] = []) {
	return {
		readInput: async (fileId: string) => {
			reads.push(fileId);
			const fixture = piAttachments[fileId];
			if (!fixture) throw new Error("RUNTIME_FILE_INPUT_NOT_AUTHORIZED");
			return {
				fileId,
				descriptor: {
					name: fixture.name,
					mediaType: fixture.mediaType,
					sizeBytes: fixture.bytes.byteLength,
					sha256: createHash("sha256").update(fixture.bytes).digest("hex"),
				},
				body: new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new Uint8Array(fixture.bytes));
						controller.close();
					},
				}),
			};
		},
		revalidate: () => {},
		writeResult: async () => {
			throw new Error("unused");
		},
	};
}

async function nativeMessages(path: string, ref: string) {
	const file = join(path, ref, "native/session.jsonl");
	return (await readFile(file, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
		.filter((entry) => entry.type === "message")
		.map((entry) => entry.message);
}

/** Every user Turn persisted across the Driver's owned native Sessions. */
async function attachedUserMessages(path: string) {
	const index = JSON.parse(await readFile(join(path, "index.json"), "utf8"));
	const users: unknown[] = [];
	for (const ref of index.sessions.map(
		(session: { ref: string }) => session.ref,
	)) {
		try {
			for (const message of await nativeMessages(path, ref))
				if (message?.role === "user") users.push(message);
		} catch {
			// A refused submit never opened its native Session.
		}
	}
	return users;
}

it.each([false, true])(
	"keeps ACK separate from completion and resumes the exact session (native exit: %s)",
	async (exit) => {
		const f = await fixture();
		try {
			const result = await f.driver.execute(command);
			expect(result.result).toEqual({ outcome: "accepted", status: "running" });
			expect(
				await f.driver.getStatus(result.nativeSessionRef, command.executionId),
			).toBe("running");
			await vi.waitFor(async () =>
				expect(
					await f.driver.getStatus(
						result.nativeSessionRef,
						command.executionId,
					),
				).toBe("completed"),
			);
			const persisted = JSON.parse(
				await readFile(
					join(f.path, result.nativeSessionRef, "state.json"),
					"utf8",
				),
			) as {
				turns: { operationFacts?: { phase: string }[] }[];
			};
			expect(
				persisted.turns[0]?.operationFacts?.map((fact) => fact.phase),
			).toEqual(["intent", "started", "completed"]);
			const events = await f.driver.replayEvents(
				result.nativeSessionRef,
				command.executionId,
			);
			expect(
				events
					.filter((event) => event.type === "text")
					.map((event) => event.payload.delta)
					.join(""),
			).toBe("synthetic result");
			expect(events.filter((event) => event.type === "completed")).toHaveLength(
				1,
			);
			expect(JSON.stringify(events)).not.toContain("sensitive-vendor-canary");
			const ownerFile = join(f.path, result.nativeSessionRef, "process.json");
			const owner = JSON.parse(await readFile(ownerFile, "utf8")).owner;
			const stateFile = join(f.path, result.nativeSessionRef, "state.json");
			const nativeId = JSON.parse(await readFile(stateFile, "utf8")).nativeId;
			if (exit) {
				process.kill(owner.pid, "SIGKILL");
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			const next = await f.driver.execute({
				...command,
				nativeSessionRef: result.nativeSessionRef,
				executionId: "execution-b",
				turnId: "turn-b",
				operationId: "operation-b",
			});
			await vi.waitFor(async () =>
				expect(
					await f.driver.getStatus(next.nativeSessionRef, "execution-b"),
				).toBe("completed"),
			);
			const nextOwner = JSON.parse(await readFile(ownerFile, "utf8")).owner;
			expect(nextOwner.pid === owner.pid).toBe(!exit);
			expect(JSON.parse(await readFile(stateFile, "utf8")).nativeId).toBe(
				nativeId,
			);
			await f.restart();
			expect(await f.driver.execute(command)).toEqual(result);
			expect(
				await f.driver.replayEvents(
					result.nativeSessionRef,
					command.executionId,
				),
			).toEqual(events);
		} finally {
			await f.close();
		}
	},
);

it("keeps overlapping same-tool operation facts bound to each call id", async () => {
	const f = await fixture("overlap-tools");
	try {
		const result = await f.driver.execute(command);
		await vi.waitFor(async () =>
			expect(
				await f.driver.getStatus(result.nativeSessionRef, command.executionId),
			).toBe("completed"),
		);
		const state = JSON.parse(
			await readFile(
				join(f.path, result.nativeSessionRef, "state.json"),
				"utf8",
			),
		) as {
			turns: {
				operationFacts?: { kind: string; phase: string; toolId?: string }[];
			}[];
		};
		expect(
			state.turns[0]?.operationFacts
				?.filter((fact) => fact.kind === "tool")
				.map((fact) => fact.phase),
		).toEqual([
			"intent",
			"started",
			"intent",
			"started",
			"completed",
			"completed",
		]);
	} finally {
		await f.close();
	}
});

it("refreshes the execution Key when Pi reuses a native session", async () => {
	const f = await fixture("cancel", true);
	const stop = (
		nativeSessionRef: string,
		executionId: string,
		turnId: string,
	) =>
		f.driver.execute({
			schemaVersion: 1,
			kind: "stop",
			agentId: command.agentId,
			conversationId: command.conversationId,
			sessionGeneration: 1,
			nativeSessionRef,
			executionId,
			turnId,
			operationId: `stop-${executionId}`,
		});
	try {
		const first = await f.driver.execute(command);
		await vi.waitFor(async () =>
			expect(
				await f.driver.getStatus(first.nativeSessionRef, command.executionId),
			).toBe("running"),
		);
		expect(f.keyResolvers).toHaveLength(1);
		expect(await f.keyResolvers[0]?.()).toBe("key-a");
		await stop(first.nativeSessionRef, command.executionId, command.turnId);
		await vi.waitFor(async () =>
			expect(
				await f.driver.getStatus(first.nativeSessionRef, command.executionId),
			).toBe("cancelled"),
		);
		await expect(f.keyResolvers[0]?.()).rejects.toMatchObject({
			code: "RUNTIME_GRANT_INVALID",
		});

		const second = await f.driver.execute({
			...command,
			nativeSessionRef: first.nativeSessionRef,
			executionId: "execution-b",
			turnId: "turn-b",
			operationId: "operation-b",
		});
		await vi.waitFor(async () =>
			expect(
				await f.driver.getStatus(second.nativeSessionRef, "execution-b"),
			).toBe("running"),
		);
		expect(f.keyResolvers).toHaveLength(1);
		expect(await f.keyResolvers[0]?.()).toBe("key-b");
		await stop(second.nativeSessionRef, "execution-b", "turn-b");
		await vi.waitFor(async () =>
			expect(
				await f.driver.getStatus(second.nativeSessionRef, "execution-b"),
			).toBe("cancelled"),
		);
		await expect(f.keyResolvers[0]?.()).rejects.toMatchObject({
			code: "RUNTIME_GRANT_INVALID",
		});
	} finally {
		await f.close();
	}
});

it("reads the bounded Pi get_commands projection from a live native handle", async () => {
	const f = await fixture();
	try {
		const accepted = await f.driver.execute(command);
		const read: SessionNativeCommandReadContext = {
			nativeSessionRef: accepted.nativeSessionRef,
			signal: new AbortController().signal,
			expiresAt: Date.now() + 10_000,
			assertCurrent: () => {},
			revalidate: async () => {},
		};
		expect(await f.driver.discoverNativeCommands(read)).toMatchObject({
			nativeId: expect.any(String),
			commands: [
				{
					name: "workspace-summary",
					source: "skill",
				},
			],
		});
	} finally {
		await f.close();
	}
});

it("fails closed for missing, revoked, cancelled and expired Pi command reads", async () => {
	const f = await fixture();
	try {
		const accepted = await f.driver.execute(command);
		const base = {
			nativeSessionRef: accepted.nativeSessionRef,
			signal: new AbortController().signal,
			expiresAt: Date.now() + 10_000,
			assertCurrent: () => {},
			revalidate: async () => {},
		};
		await expect(
			f.driver.discoverNativeCommands({ ...base, nativeSessionRef: "missing" }),
		).rejects.toThrow("Runtime session could not be recovered");
		await expect(
			f.driver.discoverNativeCommands({
				...base,
				revalidate: async () => {
					throw new Error("revoked");
				},
			}),
		).rejects.toThrow("Runtime session could not be recovered");
		const cancelled = new AbortController();
		cancelled.abort();
		await expect(
			f.driver.discoverNativeCommands({ ...base, signal: cancelled.signal }),
		).rejects.toThrow("Runtime session could not be recovered");
		await expect(
			f.driver.discoverNativeCommands({
				...base,
				expiresAt: Date.now() - 1,
			}),
		).rejects.toThrow("Runtime session could not be recovered");
	} finally {
		await f.close();
	}
});

it.each(["normal", "cancel", "abort-only"])(
	"does not interpret abort ACK as a terminal result (%s)",
	async (mode) => {
		const f = await fixture(mode);
		try {
			const result = await f.driver.execute(command);
			const { input: _input, selection: _selection, ...identity } = command;
			const stop = await f.driver.execute({
				...identity,
				schemaVersion: 1,
				kind: "stop",
				nativeSessionRef: result.nativeSessionRef,
				operationId: "stop-a",
			});
			if (mode === "abort-only") {
				expect(stop.result.outcome).toBe("unknown");
				expect(
					await f.driver.getStatus(
						result.nativeSessionRef,
						command.executionId,
					),
				).toBe("running");
			} else
				expect(stop.result).toEqual({
					outcome: "accepted",
					status: mode === "cancel" ? "cancelled" : "completed",
				});
		} finally {
			await f.close();
		}
	},
);

it.each([
	"exit",
	"malformed",
	"wrong-response",
	"stale-terminal",
	"missing-history",
	"changed-history",
])("keeps uncertain execution unknown and sanitizes %s", async (mode) => {
	const f = await fixture(mode);
	try {
		const result = await f.driver.execute(command);
		await vi.waitFor(async () =>
			expect(
				await f.driver.getStatus(result.nativeSessionRef, command.executionId),
			).toBe("unknown"),
		);
		const events = await f.driver.replayEvents(
			result.nativeSessionRef,
			command.executionId,
		);
		expect(events.some((event) => event.type === "completed")).toBe(false);
		expect(JSON.stringify(events)).not.toContain("sensitive-vendor-canary");
		expect(await f.driver.execute(command)).toEqual(result);
	} finally {
		await f.close();
	}
});

it("confirms a text Turn after the pinned Pi structured system prefix", async () => {
	const f = await fixture("system-prefix");
	try {
		const result = await f.driver.execute(command);
		expect(result.result).toEqual({ outcome: "accepted", status: "running" });
		await vi.waitFor(async () =>
			expect(
				await f.driver.getStatus(result.nativeSessionRef, command.executionId),
			).toBe("completed"),
		);
		await f.restart();
		expect(
			await f.driver.getStatus(result.nativeSessionRef, command.executionId),
		).toBe("completed");
		expect(
			(
				await f.driver.replayEvents(
					result.nativeSessionRef,
					command.executionId,
				)
			).filter((event) => event.type === "completed"),
		).toHaveLength(1);
	} finally {
		await f.close();
	}
});

it.each([false, true])(
	"recovers a persisted Pi text Turn only with its input binding (missing: %s)",
	async (missingBinding) => {
		const f = await fixture("system-prefix-exit");
		try {
			const result = await f.driver.execute(command);
			expect(result.result).toEqual({ outcome: "accepted", status: "running" });
			await vi.waitFor(async () =>
				expect(
					await f.driver.getStatus(
						result.nativeSessionRef,
						command.executionId,
					),
				).toBe("unknown"),
			);
			if (missingBinding)
				await rm(
					join(f.path, result.nativeSessionRef, "native/prompt-binding.sha256"),
				);
			await f.restart();
			expect(
				await f.driver.getStatus(result.nativeSessionRef, command.executionId),
			).toBe(missingBinding ? "unknown" : "completed");
			expect(
				(
					await f.driver.replayEvents(
						result.nativeSessionRef,
						command.executionId,
					)
				).filter((event) => event.type === "completed"),
			).toHaveLength(missingBinding ? 0 : 1);
		} finally {
			await f.close();
		}
	},
);

it.each(["plain-system", "wrong-system-cwd", "duplicate-system", "wrong-user"])(
	"keeps a mismatched Pi Turn unknown (%s)",
	async (mode) => {
		const f = await fixture(mode);
		try {
			const result = await f.driver.execute(command);
			await vi.waitFor(async () =>
				expect(
					await f.driver.getStatus(
						result.nativeSessionRef,
						command.executionId,
					),
				).toBe("unknown"),
			);
			expect(
				(
					await f.driver.replayEvents(
						result.nativeSessionRef,
						command.executionId,
					)
				).some((event) => event.type === "completed"),
			).toBe(false);
			expect(await f.driver.execute(command)).toEqual(result);
			await f.restart();
			expect(
				await f.driver.getStatus(result.nativeSessionRef, command.executionId),
			).toBe("unknown");
		} finally {
			await f.close();
		}
	},
);

it("fails closed without the workspace policy and retires the process", async () => {
	const f = await fixture("missing-policy");
	try {
		await expect(f.driver.execute(command)).rejects.toThrow(
			"Runtime session could not be recovered",
		);
		const ref = JSON.parse(await readFile(join(f.path, "index.json"), "utf8"))
			.sessions[0].ref;
		expect(
			JSON.parse(await readFile(join(f.path, ref, "process.json"), "utf8")),
		).toEqual({});
	} finally {
		await f.close();
	}
});

it.each(["invalid-json", "self-cycle", "two-node-cycle"])(
	"rejects a damaged native session (%s) without blocking a healthy conversation",
	async (corruption) => {
		const f = await fixture();
		try {
			const result = await f.driver.execute(command);
			await vi.waitFor(async () =>
				expect(
					await f.driver.getStatus(
						result.nativeSessionRef,
						command.executionId,
					),
				).toBe("completed"),
			);
			await f.restart();
			const file = join(
				f.path,
				result.nativeSessionRef,
				"native/session.jsonl",
			);
			const header = (await readFile(file, "utf8")).split("\n")[0];
			const nodes = [
				{
					type: "message",
					id: "cycle-a",
					parentId: corruption === "self-cycle" ? "cycle-a" : "cycle-b",
					message: { role: "user", content: "synthetic" },
				},
			];
			if (corruption === "two-node-cycle")
				nodes.push({
					type: "message",
					id: "cycle-b",
					parentId: "cycle-a",
					message: { role: "user", content: "synthetic" },
				});
			const corrupt =
				corruption === "invalid-json"
					? "damaged-session-evidence"
					: `${header}\n${nodes.map((node) => JSON.stringify(node)).join("\n")}\n`;
			await writeFile(file, corrupt);
			await expect(
				f.driver.execute({
					...command,
					nativeSessionRef: result.nativeSessionRef,
					executionId: "execution-b",
					turnId: "turn-b",
					operationId: "operation-b",
				}),
			).rejects.toThrow("Runtime session could not be recovered");
			expect(await readFile(file, "utf8")).toBe(corrupt);
			const healthy = await f.driver.execute({
				...command,
				conversationId: "healthy-conversation",
			});
			await vi.waitFor(async () =>
				expect(
					await f.driver.getStatus(
						healthy.nativeSessionRef,
						command.executionId,
					),
				).toBe("completed"),
			);
		} finally {
			await f.close();
		}
	},
);

it("dispatches an authorized image as native Pi prompt content", async () => {
	const f = await fixture();
	try {
		const bridge = imageBridge();
		const result = await f.driver.execute(imageCommand, {
			fileBridge: bridge.fileBridge,
		});
		expect(result.result).toEqual({ outcome: "accepted", status: "running" });
		await vi.waitFor(async () =>
			expect(
				await f.driver.getStatus(result.nativeSessionRef, command.executionId),
			).toBe("completed"),
		);
		expect(bridge.readInput).toHaveBeenCalledWith("file-1");
		// Authority is re-checked after transfer, before Turn admission and again
		// at the native boundary.
		expect(bridge.revalidate).toHaveBeenCalledTimes(3);
		expect((await f.driver.getCapabilities()).attachments).toBe(true);
		const user = (await nativeMessages(f.path, result.nativeSessionRef)).find(
			(message) => message?.role === "user",
		);
		// #3225：用户消息之后追加附件清单；图片仍作为原生 image 块，同时落到工作区。
		const relative = `.agent-infra/attachments/${piAttachmentRef("file-1")}/screen.png`;
		expect(user?.content).toEqual([
			{
				type: "text",
				text: [
					"describe this image",
					"",
					"Attachments (saved in your workspace; paths are relative to your workspace root):",
					`- name: "screen.png", media type: image/png, size: ${imageBytes.byteLength} bytes, path: "${relative}"`,
				].join("\n"),
			},
			{
				type: "image",
				data: Buffer.from(imageBytes).toString("base64"),
				mimeType: "image/png",
			},
		]);
		expect(
			await readFile(join(f.path, result.nativeSessionRef, "workspace", relative)),
		).toEqual(Buffer.from(imageBytes));
	} finally {
		await f.close();
	}
});

it("refuses native submission when the file authority lapses during Session initialization", async () => {
	const f = await fixture();
	try {
		let revalidations = 0;
		const bridge = imageBridge({
			revalidate() {
				revalidations += 1;
				// Authority lapses after the transfer but before the native Turn.
				if (revalidations > 1)
					throw new Error("RUNTIME_FILE_BRIDGE_CONTEXT_STALE");
			},
		});
		await expect(
			f.driver.execute(imageCommand, { fileBridge: bridge.fileBridge }),
		).rejects.toMatchObject({ code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE" });
		// The last check runs at the native submission boundary.
		expect(revalidations).toBe(2);
		expect(await attachedUserMessages(f.path)).toEqual([]);
	} finally {
		await f.close();
	}
});

it.each([
	["a descriptor beyond the byte bound", { sizeBytes: 50 * 1024 * 1024 + 1 }],
	["bytes that do not match the admitted digest", { sha256: "a".repeat(64) }],
])("rejects %s before any native Pi Turn", async (_name, overrides) => {
	const f = await fixture();
	try {
		const bridge = imageBridge(overrides);
		await expect(
			f.driver.execute(imageCommand, { fileBridge: bridge.fileBridge }),
		).rejects.toMatchObject({ code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE" });
		expect(bridge.revalidate).not.toHaveBeenCalled();
		expect(await attachedUserMessages(f.path)).toEqual([]);
	} finally {
		await f.close();
	}
});

it("releases the body of an attachment rejected before transfer", async () => {
	const f = await fixture();
	try {
		let cancelled = false;
		const fileBridge = {
			readInput: async (fileId: string) => ({
				fileId,
				descriptor: {
					name: "archive.zip",
					mediaType: "application/zip",
					sizeBytes: 50 * 1024 * 1024 + 1,
					sha256: createHash("sha256").update(imageBytes).digest("hex"),
				},
				body: new ReadableStream<Uint8Array>({
					cancel() {
						cancelled = true;
					},
				}),
			}),
			revalidate: () => {},
			writeResult: async () => {
				throw new Error("unused");
			},
		};
		await expect(
			f.driver.execute(imageCommand, { fileBridge }),
		).rejects.toMatchObject({ code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE" });
		expect(cancelled).toBe(true);
	} finally {
		await f.close();
	}
});

it("requires a request-scoped File Bridge for Pi attachments", async () => {
	const f = await fixture();
	try {
		await expect(f.driver.execute(imageCommand)).rejects.toMatchObject({
			code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE",
		});
	} finally {
		await f.close();
	}
});

it.each([false, true])(
	"recovers a persisted Pi image Turn only with its image binding (tampered: %s)",
	async (tampered) => {
		const f = await fixture("system-prefix-exit");
		try {
			const bridge = imageBridge();
			const result = await f.driver.execute(imageCommand, {
				fileBridge: bridge.fileBridge,
			});
			expect(result.result).toEqual({ outcome: "accepted", status: "running" });
			await vi.waitFor(async () =>
				expect(
					await f.driver.getStatus(
						result.nativeSessionRef,
						command.executionId,
					),
				).toBe("unknown"),
			);
			if (tampered) {
				const file = join(
					f.path,
					result.nativeSessionRef,
					"native/session.jsonl",
				);
				const entries = (await readFile(file, "utf8"))
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				for (const entry of entries) {
					if (entry.message?.role !== "user") continue;
					for (const part of entry.message.content)
						if (part.type === "image")
							part.data = Buffer.from("other").toString("base64");
				}
				await writeFile(
					file,
					`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
				);
			}
			await f.restart();
			expect(
				await f.driver.getStatus(result.nativeSessionRef, command.executionId),
			).toBe(tampered ? "unknown" : "completed");
			expect(
				(
					await f.driver.replayEvents(
						result.nativeSessionRef,
						command.executionId,
					)
				).filter((event) => event.type === "completed"),
			).toHaveLength(tampered ? 0 : 1);
		} finally {
			await f.close();
		}
	},
);

it("materializes PDF, CSV, TXT and PNG for an attachment-only Pi message and reuses the copies (#3225)", async () => {
	const f = await fixture();
	try {
		const fileIds = ["file-pdf", "file-csv", "file-txt", "file-png"];
		const attachmentOnly = {
			...command,
			input: { attachments: fileIds },
		};
		const result = await f.driver.execute(attachmentOnly, {
			fileBridge: piAttachmentBridge(),
		});
		expect(result.result).toEqual({ outcome: "accepted", status: "running" });
		await vi.waitFor(async () =>
			expect(
				await f.driver.getStatus(result.nativeSessionRef, command.executionId),
			).toBe("completed"),
		);
		const workspace = join(f.path, result.nativeSessionRef, "workspace");
		const lines = [
			"Attachments (saved in your workspace; paths are relative to your workspace root):",
		];
		for (const fileId of fileIds) {
			const fixture = piAttachments[fileId];
			if (!fixture) throw new Error();
			const relative = `.agent-infra/attachments/${piAttachmentRef(fileId)}/${fixture.name}`;
			lines.push(
				`- name: "${fixture.name}", media type: ${fixture.mediaType}, size: ${fixture.bytes.byteLength} bytes, path: "${relative}"`,
			);
			expect(
				createHash("sha256")
					.update(await readFile(join(workspace, relative)))
					.digest("hex"),
			).toBe(createHash("sha256").update(fixture.bytes).digest("hex"));
			expect((await lstat(join(workspace, relative))).mode & 0o777).toBe(0o400);
		}
		const user = (await nativeMessages(f.path, result.nativeSessionRef)).find(
			(message) => message?.role === "user",
		);
		// 正文为空：只发清单与原生图片。
		expect(user?.content).toEqual([
			{ type: "text", text: lines.join("\n") },
			{
				type: "image",
				data: Buffer.from(imageBytes).toString("base64"),
				mimeType: "image/png",
			},
		]);
		// Driver 状态与事件不含工作区路径与附件内容。
		const persisted = [
			await readFile(join(f.path, "index.json"), "utf8"),
			...(await readdir(join(f.path, result.nativeSessionRef)))
				.filter((name) => name.endsWith(".json"))
				.map((name) =>
					readFile(join(f.path, result.nativeSessionRef, name), "utf8"),
				),
			JSON.stringify(
				await f.driver.replayEvents(
					result.nativeSessionRef,
					command.executionId,
				),
			),
		];
		const text = (await Promise.all(persisted)).join("\n");
		for (const forbidden of [
			workspace,
			".agent-infra/attachments",
			"pi-attachment-text",
		])
			expect(text).not.toContain(forbidden);

		// 重新生成：内容一致的副本原样复用，被删除的副本恢复。
		const pdf = join(
			workspace,
			`.agent-infra/attachments/${piAttachmentRef("file-pdf")}/report.pdf`,
		);
		const csv = join(
			workspace,
			`.agent-infra/attachments/${piAttachmentRef("file-csv")}/table.csv`,
		);
		const before = await lstat(pdf);
		await rm(csv);
		const regenerated = await f.driver.execute(
			{
				...attachmentOnly,
				executionId: "execution-b",
				turnId: "turn-b",
				operationId: "operation-b",
			},
			{ fileBridge: piAttachmentBridge() },
		);
		expect(regenerated.result).toMatchObject({ outcome: "accepted" });
		expect((await lstat(pdf)).ino).toBe(before.ino);
		expect(await readFile(csv)).toEqual(piAttachments["file-csv"]?.bytes);
	} finally {
		await f.close();
	}
});

it("rejects Pi attachments with a planted link, beyond 32 or outside the Grant before any native Turn (#3225)", async () => {
	const f = await fixture();
	try {
		const reads: string[] = [];
		await expect(
			f.driver.execute(
				{
					...command,
					input: {
						text: "inspect",
						attachments: Array.from({ length: 33 }, (_, i) => `file-${i}`),
					},
				},
				{ fileBridge: piAttachmentBridge(reads) },
			),
		).rejects.toMatchObject({ code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE" });
		expect(reads).toEqual([]);
		await expect(
			f.driver.execute(
				{
					...command,
					input: { text: "inspect", attachments: ["file-foreign"] },
				},
				{ fileBridge: piAttachmentBridge() },
			),
		).rejects.toThrow("RUNTIME_FILE_INPUT_NOT_AUTHORIZED");
		const index = JSON.parse(await readFile(join(f.path, "index.json"), "utf8"));
		const ref = index.sessions[0]?.ref as string | undefined;
		if (!ref) throw new Error("missing session");
		const workspace = join(f.path, ref, "workspace");
		const outside = join(f.path, "outside");
		await mkdir(outside, { mode: 0o700 });
		await mkdir(join(workspace, ".agent-infra"), {
			recursive: true,
			mode: 0o700,
		});
		await chmod(join(workspace, ".agent-infra"), 0o700);
		await symlink(outside, join(workspace, ".agent-infra", "attachments"));
		await expect(
			f.driver.execute(
				{ ...command, input: { text: "inspect", attachments: ["file-txt"] } },
				{ fileBridge: piAttachmentBridge() },
			),
		).rejects.toMatchObject({ code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE" });
		expect(await readdir(outside)).toEqual([]);
		expect(await attachedUserMessages(f.path)).toEqual([]);
	} finally {
		await f.close();
	}
});
