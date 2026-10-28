import { randomUUID } from "node:crypto";
import {
	appendFile,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	claudeCommand,
	claudeNativeFixture,
	completeClaudeResponse,
	completeClaudeToolUses,
	readClaudeFixtureMessage,
} from "./claude-native.test-support.js";
import { readClaudeSessionHistory } from "./claude-session-history.js";
import {
	createRuntimeFileResultReceiptV1,
	type RuntimeFileBridgePortV1,
} from "./runtime-file-bridge.js";

// These integration cases start pinned Native processes and read SDK history.
vi.setConfig({ testTimeout: 30_000 });

const fixtures: Awaited<ReturnType<typeof claudeNativeFixture>>[] = [];
async function fixture() {
	const value = await claudeNativeFixture();
	fixtures.push(value);
	return value;
}
afterEach(async () => {
	for (const value of fixtures.splice(0)) await value.close();
});

it("reads native continuity and completion beyond the first 10000 messages", async () => {
	const f = await fixture();
	const accepted = await f.driver.execute(claudeCommand());
	await f.settled(accepted.nativeSessionRef, "execution-one");
	await f.driver.close();
	const directory = join(f.path, accepted.nativeSessionRef);
	const state = JSON.parse(
		await readFile(join(directory, "state.json"), "utf8"),
	);
	const config = join(directory, "config");
	const transcript = (await readdir(config, { recursive: true })).find((file) =>
		file.endsWith(`${state.nativeId}.jsonl`),
	);
	if (!transcript) throw new Error("Synthetic transcript was not persisted");
	const file = join(config, transcript);
	const records = (await readFile(file, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const templates = {
		user: records.find((entry) => entry.type === "user"),
		assistant: records.find((entry) => entry.type === "assistant"),
	};
	let parentUuid = records.findLast(
		(entry) => entry.type === "user" || entry.type === "assistant",
	).uuid;
	let lastUser = "";
	const added = [];
	for (let i = 0; i < 10002; i++) {
		const type = i % 2 === 0 ? "user" : "assistant";
		const uuid = randomUUID();
		if (type === "user") lastUser = uuid;
		added.push(
			JSON.stringify({
				...templates[type],
				uuid,
				parentUuid,
				message: {
					...templates[type].message,
					id: `synthetic-${uuid}`,
					content: [{ type: "text", text: "synthetic-long-history" }],
					...(type === "assistant" ? { stop_reason: "end_turn" } : {}),
				},
			}),
		);
		parentUuid = uuid;
	}
	await appendFile(file, `${added.join("\n")}\n`);
	const history = await readClaudeSessionHistory(
		state.nativeId,
		join(directory, "workspace"),
		config,
		lastUser,
	);
	expect(history.users).toContain(state.turns[0].userMessageId);
	expect(history.users).toContain(lastUser);
	expect(history.completed).toBe(true);
	expect(history.events).toEqual([
		{ type: "text", payload: { delta: "synthetic-long-history" } },
	]);
}, 30000);

it("switches equal model names between endpoints and credentials while resuming the original native history", async () => {
	const f = await fixture();
	const command = claudeCommand();
	const first = await f.driver.execute(command);
	await f.settled(first.nativeSessionRef, command.executionId);
	const original = JSON.parse(
		await readFile(join(f.path, first.nativeSessionRef, "state.json"), "utf8"),
	);
	await f.restart();
	const next = {
		...claudeCommand("two"),
		nativeSessionRef: first.nativeSessionRef,
		selection: {
			...command.selection,
			modelOptionId: "option-two",
			reasoningLevel: "low",
		},
	};
	const second = await f.driver.execute(next);
	await f.settled(second.nativeSessionRef, next.executionId);
	expect(second.nativeSessionRef).toBe(first.nativeSessionRef);
	expect(
		f.calls.map((call) => [
			call.endpoint,
			call.headers.authorization,
			call.headers["x-api-key"],
			call.body.output_config,
		]),
	).toEqual([
		[0, "Bearer synthetic-credential-0", undefined, { effort: "high" }],
		[1, undefined, "synthetic-credential-1", { effort: "low" }],
	]);
	expect(JSON.stringify(f.calls[1]?.body.messages)).toContain(
		command.input.text,
	);
	const current = JSON.parse(
		await readFile(join(f.path, first.nativeSessionRef, "state.json"), "utf8"),
	);
	expect(current.nativeId).toBe(original.nativeId);
	expect(
		current.turns.map((turn: { selection: unknown }) => turn.selection),
	).toEqual([command.selection, next.selection]);
}, 30000);

it("canonicalizes command field order during durable lookup and preserves unknown in-flight recovery without a second Turn", async () => {
	const f = await fixture();
	f.hold();
	const command = claudeCommand();
	const accepted = await f.driver.execute(command);
	await vi.waitFor(() => expect(f.calls).toHaveLength(1));
	await f.restart();
	const { input, selection, ...rest } = command;
	const reordered = { input, selection, ...rest };
	expect(await f.driver.lookupOperation(reordered)).toMatchObject({
		state: "found",
		record: accepted,
	});
	expect(
		await f.driver.getStatus(accepted.nativeSessionRef, command.executionId),
	).toBe("unknown");
	expect(
		(
			await f.driver.execute({
				...claudeCommand("two"),
				nativeSessionRef: accepted.nativeSessionRef,
			})
		).result,
	).toEqual({ outcome: "busy" });
	expect(f.calls).toHaveLength(1);
	f.release();
	const other = {
		...claudeCommand("other"),
		conversationId: "conversation-other",
	};
	const next = await f.driver.execute(other);
	await f.settled(next.nativeSessionRef, other.executionId);
	expect(f.calls).toHaveLength(2);
});

it.each([
	"agentId",
	"conversationId",
	"sessionGeneration",
	"nativeSessionRef",
] as const)(
	"rejects a forged %s before another native request",
	async (key) => {
		const f = await fixture();
		const first = await f.driver.execute(claudeCommand());
		await f.settled(first.nativeSessionRef, "execution-one");
		const command = {
			...claudeCommand("two"),
			nativeSessionRef: first.nativeSessionRef,
			[key]: key === "sessionGeneration" ? 2 : "forged",
		};
		await expect(f.driver.execute(command)).rejects.toMatchObject({
			code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE",
		});
		expect(f.calls).toHaveLength(1);
	},
);

it.each([
	"status",
	"duplicate-operation",
	"event-cursor",
	"binding",
	"selection",
])(
	"fails closed on corrupt %s and keeps other Conversations usable",
	async (fault) => {
		const f = await fixture();
		const first = await f.driver.execute(claudeCommand());
		await f.settled(first.nativeSessionRef, "execution-one");
		await f.driver.close();
		const file = join(f.path, first.nativeSessionRef, "state.json");
		const state = JSON.parse(await readFile(file, "utf8"));
		if (fault === "status") state.turns[0].status = "invented";
		if (fault === "duplicate-operation")
			state.operations.push(state.operations[0]);
		if (fault === "event-cursor")
			state.turns[0].events[1].cursor = state.turns[0].events[0].cursor;
		if (fault === "binding")
			state.operations[0].record.conversationId = "other";
		if (fault === "selection") delete state.turns[0].selection;
		await writeFile(file, JSON.stringify(state));
		await f.restart();
		await expect(
			f.driver.getStatus(first.nativeSessionRef, "execution-one"),
		).rejects.toMatchObject({ code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE" });
		const other = {
			...claudeCommand("other"),
			conversationId: "conversation-other",
		};
		const accepted = await f.driver.execute(other);
		await f.settled(accepted.nativeSessionRef, other.executionId);
		expect(f.calls).toHaveLength(2);
	},
);

it("refuses to replace missing native history and a symlinked session directory", async () => {
	const f = await fixture();
	const first = await f.driver.execute(claudeCommand());
	await f.settled(first.nativeSessionRef, "execution-one");
	await f.driver.close();
	await rm(join(f.path, first.nativeSessionRef, "config"), { recursive: true });
	await f.restart();
	await expect(
		f.driver.execute({
			...claudeCommand("two"),
			nativeSessionRef: first.nativeSessionRef,
		}),
	).rejects.toMatchObject({ code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE" });
	expect(f.calls).toHaveLength(1);
	const other = {
		...claudeCommand("other"),
		conversationId: "conversation-other",
	};
	const second = await f.driver.execute(other);
	await f.settled(second.nativeSessionRef, other.executionId);
	await f.driver.close();
	await rm(join(f.path, first.nativeSessionRef), { recursive: true });
	await symlink(
		join(f.path, second.nativeSessionRef),
		join(f.path, first.nativeSessionRef),
	);
	await f.restart();
	await expect(
		f.driver.getStatus(first.nativeSessionRef, "execution-one"),
	).rejects.toMatchObject({ code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE" });
	expect(
		(await readdir(f.path)).filter((name) => name.endsWith(".json")),
	).toEqual(["index.json"]);
});

it("reconciles native completion after a crash before normalized text and terminal persistence", async () => {
	const f = await fixture();
	const command = claudeCommand();
	const first = await f.driver.execute(command);
	await f.settled(first.nativeSessionRef, command.executionId);
	await f.driver.close();
	const file = join(f.path, first.nativeSessionRef, "state.json");
	const state = JSON.parse(await readFile(file, "utf8"));
	state.turns[0].status = "running";
	state.turns[0].events = state.turns[0].events.filter(
		(event: { type: string }) => event.type === "status",
	);
	state.sequence = state.turns[0].events.length;
	await writeFile(file, JSON.stringify(state));
	await f.restart();
	expect(
		await f.driver.getStatus(first.nativeSessionRef, command.executionId),
	).toBe("completed");
	const events = await f.driver.replayEvents(
		first.nativeSessionRef,
		command.executionId,
	);
	expect(
		events
			.filter((event) => event.type === "text")
			.map((event) => event.payload.delta)
			.join(""),
	).toBe("OK");
	expect(events.filter((event) => event.type === "completed")).toHaveLength(1);
	await f.restart();
	expect(
		await f.driver.replayEvents(first.nativeSessionRef, command.executionId),
	).toEqual(events);
	expect(f.calls).toHaveLength(1);
});

it.each(["stop", "generation-cancel"] as const)(
	"converges a durable %s intent whose result was lost",
	async (kind) => {
		const f = await fixture();
		f.hold();
		const command = claudeCommand();
		const first = await f.driver.execute(command);
		await vi.waitFor(() => expect(f.calls).toHaveLength(1));
		const control = {
			schemaVersion: 1 as const,
			kind,
			agentId: command.agentId,
			conversationId: command.conversationId,
			sessionGeneration: 1,
			nativeSessionRef: first.nativeSessionRef,
			executionId: command.executionId,
			turnId: command.turnId,
			operationId: "stop-one",
		};
		const stopped = await f.driver.execute(control);
		await f.driver.close();
		const file = join(f.path, first.nativeSessionRef, "state.json");
		const state = JSON.parse(await readFile(file, "utf8"));
		delete state.operations.find(
			(entry: { record?: { operationId: string } }) =>
				entry.record?.operationId === control.operationId,
		).record;
		state.turns[0].status = "running";
		state.turns[0].events = state.turns[0].events.filter(
			(event: { type: string }) => event.type !== "completed",
		);
		state.sequence = state.turns[0].events.length;
		await writeFile(file, JSON.stringify(state));
		await f.restart();
		expect(await f.driver.lookupOperation(control)).toMatchObject({
			state: "found",
			record: stopped,
		});
		expect(await f.driver.execute(control)).toEqual(stopped);
		expect(
			await f.driver.getStatus(first.nativeSessionRef, command.executionId),
		).toBe("cancelled");
		expect(f.calls).toHaveLength(1);
	},
);

it("drains submissions already entering startup when close begins", async () => {
	const f = await fixture();
	const submitting = f.driver.execute(claudeCommand()).catch((error) => error);
	await f.driver.close();
	const result = await submitting;
	expect(result).toMatchObject({ code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE" });
	expect(f.calls).toHaveLength(0);
	await expect(f.driver.execute(claudeCommand("later"))).rejects.toMatchObject({
		code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE",
	});
});

it("uses the pinned native beta headers", async () => {
	const f = await fixture();
	const first = await f.driver.execute(claudeCommand());
	await f.settled(first.nativeSessionRef, "execution-one");
	expect(f.calls[0]?.headers["anthropic-beta"]).toBe(
		"claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,effort-2025-11-24,fallback-credit-2026-06-01",
	);
});

it.each([400, 503])(
	"contains HTTP %s provider errors before native persistence and recovers only definite failure",
	async (status) => {
		const f = await fixture();
		f.hold();
		const command = claudeCommand();
		const accepted = await f.driver.execute(command);
		await vi.waitFor(() => expect(f.calls).toHaveLength(1));
		const call = f.calls[0];
		if (!call) throw Error();
		call.response.writeHead(status, { "content-type": "application/json" });
		call.response.end(
			JSON.stringify({
				error: { message: "synthetic-provider-error synthetic-credential-0" },
			}),
		);
		const expected = status === 400 ? "failed" : "unknown";
		await vi.waitFor(async () =>
			expect(
				await f.driver.getStatus(
					accepted.nativeSessionRef,
					command.executionId,
				),
			).toBe(expected),
		);
		await f.driver.close();
		async function inspect(directory: string): Promise<void> {
			for (const entry of await readdir(directory, { withFileTypes: true })) {
				const path = join(directory, entry.name);
				if (entry.isDirectory()) await inspect(path);
				else if (entry.isFile()) {
					const value = await readFile(path, "utf8");
					expect(
						value.includes("synthetic-credential-0") ||
							value.includes("synthetic-provider-error"),
					).toBe(false);
				}
			}
		}
		await inspect(f.path);
		const file = join(f.path, accepted.nativeSessionRef, "state.json");
		const state = JSON.parse(await readFile(file, "utf8"));
		state.turns[0].status = "running";
		state.turns[0].events = state.turns[0].events.filter(
			(event: { type: string }) => event.type !== "completed",
		);
		state.sequence = state.turns[0].events.length;
		await writeFile(file, JSON.stringify(state));
		await f.restart();
		expect(
			await f.driver.getStatus(accepted.nativeSessionRef, command.executionId),
		).toBe(expected);
		const events = await f.driver.replayEvents(
			accepted.nativeSessionRef,
			command.executionId,
		);
		await f.restart();
		expect(
			await f.driver.replayEvents(
				accepted.nativeSessionRef,
				command.executionId,
			),
		).toEqual(events);
		if (status === 400) {
			f.release();
			const next = claudeCommand("two");
			const result = await f.driver.execute({
				...next,
				nativeSessionRef: accepted.nativeSessionRef,
			});
			await f.settled(result.nativeSessionRef, next.executionId);
			expect(f.calls).toHaveLength(2);
		} else expect(f.calls).toHaveLength(1);
	},
);

it("enforces real native tool isolation for direct paths and symlink escapes before and after restart", async () => {
	const f = await fixture();
	const root = await realpath(f.path);
	const own = await f.driver.execute(claudeCommand("seed-own"));
	await f.settled(own.nativeSessionRef, "execution-seed-own");
	const peer = await f.driver.execute({
		...claudeCommand("seed-peer"),
		conversationId: "conversation-peer",
	});
	await f.settled(peer.nativeSessionRef, "execution-seed-peer");
	const ownPaths = [
		join(root, own.nativeSessionRef, "workspace/canary.txt"),
		join(root, own.nativeSessionRef, "memory/MEMORY.md"),
	];
	const peerPaths = [
		join(root, peer.nativeSessionRef, "workspace/canary.txt"),
		join(root, peer.nativeSessionRef, "memory/MEMORY.md"),
	];
	const aliases = [
		join(root, own.nativeSessionRef, "workspace/linked-workspace.txt"),
		join(root, own.nativeSessionRef, "workspace/linked-memory.md"),
	];
	for (const path of ownPaths) await writeFile(path, "synthetic-own-canary");
	for (const path of peerPaths) await writeFile(path, "synthetic-peer-canary");
	for (const [index, path] of aliases.entries())
		await symlink(peerPaths[index] as string, path);
	for (const id of ["before-restart", "after-restart"]) {
		if (id === "after-restart") await f.restart();
		f.hold();
		const offset = f.calls.length;
		const command = {
			...claudeCommand(id),
			nativeSessionRef: own.nativeSessionRef,
		};
		const accepted = await f.driver.execute(command);
		await vi.waitFor(() => expect(f.calls).toHaveLength(offset + 1));
		const first = f.calls[offset];
		if (!first) throw Error();
		completeClaudeResponse(
			first.response,
			`msg_${id}`,
			String(first.body.model),
			"",
			[...ownPaths, ...peerPaths, ...aliases],
		);
		await vi.waitFor(() => expect(f.calls).toHaveLength(offset + 2), {
			timeout: 10000,
		});
		const messages = f.calls[offset + 1]?.body.messages as {
			content: {
				type: string;
				tool_use_id?: string;
				is_error?: boolean;
				content?: unknown;
			}[];
		}[];
		const results = messages
			.flatMap((message) =>
				Array.isArray(message.content)
					? message.content.filter((block) => block.type === "tool_result")
					: [],
			)
			.slice(-6);
		expect(results).toHaveLength(6);
		for (const [index] of [...ownPaths, ...peerPaths, ...aliases].entries()) {
			const result = results.find(
				(result) => result.tool_use_id === `read_${index}`,
			);
			expect(result).toBeDefined();
			if (index < 2) {
				expect(result?.is_error).not.toBe(true);
				expect(JSON.stringify(result?.content)).toContain(
					"synthetic-own-canary",
				);
			} else {
				expect(result?.is_error).toBe(true);
				expect(JSON.stringify(result?.content)).not.toContain(
					"synthetic-peer-canary",
				);
			}
		}
		expect(JSON.stringify(f.calls[offset + 1]?.body.messages)).not.toContain(
			"synthetic-peer-canary",
		);
		f.release();
		await f.settled(accepted.nativeSessionRef, command.executionId);
		const events = await f.driver.replayEvents(
			accepted.nativeSessionRef,
			command.executionId,
		);
		expect(
			events.filter(
				(event) => event.type === "tool" && event.payload.phase === "completed",
			),
		).toHaveLength(2);
		expect(
			events.filter(
				(event) => event.type === "tool" && event.payload.phase === "failed",
			),
		).toHaveLength(4);
	}
}, 30000);

// #3217：固定 Claude 的 Glob 与 Grep 只在本 Conversation 内生效，越界路径被拒绝。
it("lists and searches only inside the owning Conversation through native Glob and Grep", async () => {
	const f = await fixture();
	const root = await realpath(f.path);
	const own = await f.driver.execute(claudeCommand("search-own"));
	await f.settled(own.nativeSessionRef, "execution-search-own");
	const peer = await f.driver.execute({
		...claudeCommand("search-peer"),
		conversationId: "conversation-peer",
	});
	await f.settled(peer.nativeSessionRef, "execution-search-peer");
	const ownWorkspace = join(root, own.nativeSessionRef, "workspace");
	const peerWorkspace = join(root, peer.nativeSessionRef, "workspace");
	await writeFile(join(ownWorkspace, "own-note.txt"), "synthetic-own-canary");
	await writeFile(
		join(peerWorkspace, "peer-note.txt"),
		"synthetic-peer-canary",
	);
	f.hold();
	const offset = f.calls.length;
	const command = {
		...claudeCommand("search"),
		nativeSessionRef: own.nativeSessionRef,
	};
	const accepted = await f.driver.execute(command);
	await vi.waitFor(() => expect(f.calls).toHaveLength(offset + 1));
	const first = f.calls[offset];
	if (!first) throw Error();
	const uses = [
		{ id: "glob_own", name: "Glob", input: { pattern: "*.txt" } },
		{
			id: "grep_own",
			name: "Grep",
			input: {
				pattern: "synthetic-own-canary",
				path: ownWorkspace,
				output_mode: "content",
			},
		},
		{
			id: "glob_peer",
			name: "Glob",
			input: { pattern: "*.txt", path: peerWorkspace },
		},
		{
			id: "grep_peer",
			name: "Grep",
			input: { pattern: "canary", path: root, output_mode: "content" },
		},
		{
			id: "glob_escape",
			name: "Glob",
			input: { pattern: "../../*/workspace/*" },
		},
		{
			id: "bash_denied",
			name: "Bash",
			input: { command: "cat /proc/self/environ" },
		},
	];
	completeClaudeToolUses(
		first.response,
		"msg_search",
		String(first.body.model),
		"",
		uses,
	);
	await vi.waitFor(() => expect(f.calls).toHaveLength(offset + 2), {
		timeout: 10000,
	});
	const messages = f.calls[offset + 1]?.body.messages as {
		content: {
			type: string;
			tool_use_id?: string;
			is_error?: boolean;
			content?: unknown;
		}[];
	}[];
	const results = new Map(
		messages
			.flatMap((message) =>
				Array.isArray(message.content)
					? message.content.filter((block) => block.type === "tool_result")
					: [],
			)
			.map((result) => [result.tool_use_id, result]),
	);
	expect(results.get("glob_own")?.is_error).not.toBe(true);
	expect(JSON.stringify(results.get("glob_own")?.content)).toContain(
		"own-note.txt",
	);
	expect(results.get("grep_own")?.is_error).not.toBe(true);
	expect(JSON.stringify(results.get("grep_own")?.content)).toContain(
		"synthetic-own-canary",
	);
	for (const id of ["glob_peer", "grep_peer", "glob_escape", "bash_denied"])
		expect(results.get(id)?.is_error).toBe(true);
	const body = JSON.stringify(f.calls[offset + 1]?.body.messages);
	expect(body).not.toContain("synthetic-peer-canary");
	expect(body).not.toContain("peer-note.txt");
	f.release();
	await f.settled(accepted.nativeSessionRef, command.executionId);
}, 30000);

it("waits for native exit after a permission error on the retiring process group before resuming", async () => {
	const f = await fixture();
	f.hold();
	const first = await f.driver.execute(claudeCommand());
	await vi.waitFor(() => expect(f.calls).toHaveLength(1));
	const directory = join(f.path, first.nativeSessionRef);
	const state = JSON.parse(
		await readFile(join(directory, "state.json"), "utf8"),
	);
	// A request reaching the model does not prove Native has flushed its history.
	await vi.waitFor(
		async () => {
			const history = await readClaudeSessionHistory(
				state.nativeId,
				join(directory, "workspace"),
				join(directory, "config"),
			);
			expect(history.users).toContain(state.turns[0].userMessageId);
		},
		{ timeout: 10000 },
	);
	const nativeKill = process.kill.bind(process);
	let denied = false;
	let reaped = false;
	const signal = vi.spyOn(process, "kill").mockImplementation((pid, action) => {
		if (pid < 0 && action === "SIGTERM" && !denied) {
			denied = true;
			// Reproduce a terminated, not-yet-reaped group; a live EPERM must stay fatal.
			try {
				nativeKill(pid, "SIGKILL");
			} catch (error) {
				if (
					!["ESRCH", "EPERM"].includes(
						(error as NodeJS.ErrnoException).code ?? "",
					)
				)
					throw error;
			}
			throw Object.assign(new Error("Synthetic zombie process group"), {
				code: "EPERM",
			});
		}
		try {
			return nativeKill(pid, action);
		} catch (error) {
			if (
				pid < 0 &&
				action === 0 &&
				(error as NodeJS.ErrnoException).code === "ESRCH"
			)
				reaped = true;
			throw error;
		}
	});
	try {
		await f.driver.execute({
			schemaVersion: 1,
			kind: "stop",
			agentId: "agent-one",
			conversationId: "conversation-one",
			sessionGeneration: 1,
			nativeSessionRef: first.nativeSessionRef,
			executionId: "execution-one",
			turnId: "turn-one",
			operationId: "stop-one",
		});
		await f.restart();
		f.release();
		expect(denied).toBe(true);
		expect(reaped).toBe(true);
		const next = claudeCommand("two");
		const result = await f.driver.execute({
			...next,
			nativeSessionRef: first.nativeSessionRef,
		});
		await f.settled(result.nativeSessionRef, next.executionId);
		expect(result.nativeSessionRef).toBe(first.nativeSessionRef);
		expect(f.calls).toHaveLength(2);
	} finally {
		signal.mockRestore();
	}
}, 30000);

it.each(["exists", "permission-denied"])(
	"refuses another native Turn if the retired group probe is %s",
	async (probe) => {
		const f = await claudeNativeFixture();
		f.hold();
		const first = await f.driver.execute(claudeCommand());
		await vi.waitFor(() => expect(f.calls).toHaveLength(1));
		const nativeKill = process.kill.bind(process);
		const signal = vi
			.spyOn(process, "kill")
			.mockImplementation((pid, action) => {
				if (pid < 0 && action === "SIGTERM") {
					try {
						nativeKill(pid, "SIGKILL");
					} catch {}
					throw Object.assign(new Error("Synthetic permission error"), {
						code: "EPERM",
					});
				}
				if (pid < 0 && action === 0) {
					if (probe === "exists") return true;
					throw Object.assign(new Error("Synthetic probe permission error"), {
						code: "EPERM",
					});
				}
				return nativeKill(pid, action);
			});
		try {
			await expect(f.driver.close()).rejects.toThrow(
				"RUNTIME_NATIVE_SESSION_UNAVAILABLE",
			);
			await expect(
				f.driver.execute({
					...claudeCommand("two"),
					nativeSessionRef: first.nativeSessionRef,
				}),
			).rejects.toMatchObject({ code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE" });
			expect(f.calls).toHaveLength(1);
		} finally {
			signal.mockRestore();
			await f.close().catch(() => {});
		}
	},
	30000,
);

it("publishes a Claude answer reference written by the Write tool after the SDK result (#3226)", async () => {
	const f = await fixture();
	const root = await realpath(f.path);
	f.hold();
	let count = 0;
	const writeResult = vi.fn(
		async (
			descriptor: Parameters<RuntimeFileBridgePortV1["writeResult"]>[0],
			body: Parameters<RuntimeFileBridgePortV1["writeResult"]>[1],
			options?: Parameters<RuntimeFileBridgePortV1["writeResult"]>[2],
		) => {
			for await (const _chunk of body);
			count += 1;
			return createRuntimeFileResultReceiptV1(
				{
					actorId: "actor-one",
					channelId: "web",
					agentId: "agent-one",
					conversationId: "conversation-one",
					executionId: "execution-reference",
					sessionGeneration: 1,
					grantId: "grant-one",
					expiresAt: Date.now() + 60_000,
					inputFileIds: [],
				},
				{
					schemaVersion: 1,
					fileId: `result-claude-${count}`,
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
	const command = claudeCommand("reference");
	const accepted = await f.driver.execute(command, {
		fileBridge: {
			readInput: async () => {
				throw new Error("unused");
			},
			writeResult,
			revalidate: () => {},
		},
	});
	await vi.waitFor(() => expect(f.calls).toHaveLength(1), { timeout: 10000 });
	const workspace = join(root, accepted.nativeSessionRef, "workspace");
	const first = f.calls[0];
	if (!first) throw Error();
	completeClaudeToolUses(
		first.response,
		"msg_write",
		String(first.body.model),
		"",
		[
			{
				id: "write_report",
				name: "Write",
				input: {
					file_path: join(workspace, "report.txt"),
					content: "report\n",
				},
			},
		],
	);
	await vi.waitFor(() => expect(f.calls).toHaveLength(2), { timeout: 10000 });
	const second = f.calls[1];
	if (!second) throw Error();
	completeClaudeToolUses(
		second.response,
		"msg_answer",
		String(second.body.model),
		"Done: [report](sandbox:report.txt) and `[code](sandbox:code.txt)`.",
		[],
	);
	f.release();
	await f.settled(accepted.nativeSessionRef, command.executionId);
	// Write 本身不发布结果文件，只有最终回答中的引用发布一次。
	const persisted = JSON.parse(
		await readFile(join(root, accepted.nativeSessionRef, "state.json"), "utf8"),
	);
	const writeFacts = persisted.turns
		.find(
			(turn: { executionId: string }) =>
				turn.executionId === command.executionId,
		)
		.operationFacts.filter(
			(fact: { toolId?: string }) => fact.toolId === "Write",
		);
	expect(writeFacts.map((fact: { phase: string }) => fact.phase)).toEqual([
		"started",
		"completed",
	]);
	expect(
		writeFacts.every(
			(fact: { startedAt?: string; durationMs?: number }) =>
				fact.startedAt === undefined && fact.durationMs === undefined,
		),
	).toBe(true);
	expect(
		persisted.turns[0].operationFacts
			.filter(
				(fact: { toolId?: string }) =>
					fact.toolId === "workspace.publish_result_file",
			)
			.map((fact: { phase: string }) => fact.phase),
	).toEqual(["intent", "started", "completed"]);
	expect(writeResult).toHaveBeenCalledOnce();
	expect(writeResult.mock.calls[0]?.[0]).toMatchObject({
		name: "report.txt",
		mediaType: "text/plain",
	});
	expect(writeResult.mock.calls[0]?.[2]).toEqual({
		workspaceReference: "report.txt",
	});
	const events = await f.driver.replayEvents(
		accepted.nativeSessionRef,
		command.executionId,
	);
	const file = events.findIndex((event) => event.type === "file");
	expect(events[file]).toMatchObject({
		schemaVersion: 2,
		payload: { fileId: "result-claude-1", workspaceReference: "report.txt" },
	});
	expect(file).toBeLessThan(
		events.findIndex((event) => event.type === "completed"),
	);
	expect(
		events.some(
			(event) =>
				event.type === "tool" &&
				event.payload.name === "Write" &&
				event.payload.phase === "completed",
		),
	).toBe(true);
	await f.restart();
	expect(
		await f.driver.replayEvents(accepted.nativeSessionRef, command.executionId),
	).toEqual(events);
}, 30000);

it.for([
	{
		shell: false,
		label:
			"finishes a real Claude SDK result without waiting for an open input stream",
	},
	{
		shell: true,
		label:
			"isolates a real Claude Bash child through the fixed Landlock shell entrypoint",
	},
])("$label", { timeout: 30_000 }, async ({ shell }, context) => {
	if (shell && process.env.AGENT_INFRA_NATIVE_SHELL_TEST !== "1")
		context.skip();
	const { mkdtemp, mkdir } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { createServer } = await import("node:http");
	const { claudeQuery } = await import("./claude-query.js");
	const { verifyClaudeInstallation } = await import("./claude-installation.js");
	const installation = await verifyClaudeInstallation();
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "claude-shell-boundary-")),
	);
	const workspace = join(root, "workspace");
	const config = join(root, "config");
	for (const directory of [
		workspace,
		config,
		join(root, "home"),
		join(root, "tmp"),
		join(root, "private"),
	])
		await mkdir(directory);
	const secret = "synthetic-claude-child-secret";
	const forbidden = join(root, "private/host-state");
	await writeFile(forbidden, secret);
	const nativeSecret = join(config, "private-state.txt");
	await writeFile(nativeSecret, secret);
	const tokenKeys = [
		"ANTHROPIC_AUTH_TOKEN",
		"SYNTHETIC_MCP_TOKEN",
		"SYNTHETIC_BROWSER_TOKEN",
	];
	const program = `const fs=require("node:fs");const denied=p=>{try{fs.readFileSync(p);return false}catch{return true}};fs.writeFileSync("claude-proof.json",JSON.stringify({env:${JSON.stringify(tokenKeys)}.every(k=>!Object.hasOwn(process.env,k)),host:denied(${JSON.stringify(forbidden)}),proc:denied("/proc/self/environ")&&denied(${JSON.stringify(`/proc/${process.pid}/environ`)})&&denied(${JSON.stringify(`/proc/${process.pid}/fd/0`)}),native:denied(${JSON.stringify(nativeSecret)})}));process.stdout.write("isolated-claude-shell");`;
	const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
	let calls = 0;
	const requests: Record<string, unknown>[] = [];
	const fixtureErrors: string[] = [];
	const requestMetadata: { route: string; method: string; status: number }[] =
		[];
	const server = createServer(async (request, response) => {
		response.once("finish", () => {
			if (requestMetadata.length < 32)
				requestMetadata.push({
					route:
						request.url?.split("?")[0] === "/v1/messages"
							? "messages"
							: "other",
					method: request.method === "POST" ? "POST" : "other",
					status: response.statusCode,
				});
		});
		try {
			const value = await readClaudeFixtureMessage(request, response);
			if (!value) return;
			requests.push(value);
			calls++;
			completeClaudeToolUses(
				response,
				`msg_${calls}`,
				value.model,
				"complete",
				shell && calls === 1
					? [
							{
								id: "isolated-bash",
								name: "Bash",
								input: {
									command: `/usr/local/bin/node -e ${quote(program)}`,
									timeout: 5000,
									description: "Verify isolated shell",
								},
							},
						]
					: [],
			);
		} catch {
			fixtureErrors.push("synthetic-response-failed");
			if (!response.headersSent) response.writeHead(500);
			response.end();
		}
	});
	await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing fixture endpoint");
	if (shell) {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		await promisify(execFile)(
			"/opt/agent-infra/native-bash.mjs",
			["-c", "-l", "true"],
			{
				cwd: workspace,
				env: {
					PATH: "/usr/local/bin:/usr/bin:/bin",
					AGENT_INFRA_NATIVE_SHELL_WORKSPACE: workspace,
				},
				timeout: 6000,
			},
		);
	}
	const native = claudeQuery(
		{
			pathToClaudeCodeExecutable: installation.executable,
			cwd: workspace,
			env: {
				PATH: "/usr/local/bin:/usr/bin:/bin",
				HOME: join(root, "home"),
				TMPDIR: shell ? workspace : join(root, "tmp"),
				...(shell
					? {
							CLAUDE_CODE_SHELL: "/opt/agent-infra/native-bash.mjs",
							AGENT_INFRA_NATIVE_SHELL_WORKSPACE: workspace,
						}
					: {}),
				CLAUDE_CONFIG_DIR: config,
				ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
				ANTHROPIC_AUTH_TOKEN: secret,
				SYNTHETIC_MCP_TOKEN: secret,
				SYNTHETIC_BROWSER_TOKEN: secret,
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
			},
			settingSources: [],
			model: "claude-opus-5",
			tools: shell ? ["Bash"] : [],
			allowedTools: shell ? ["Bash"] : [],
			canUseTool: async (toolName, input) =>
				toolName === "Bash"
					? { behavior: "allow", updatedInput: input }
					: { behavior: "deny", message: "Unexpected tool" },
			mcpServers: {},
			strictMcpConfig: true,
			persistSession: false,
			maxTurns: 3,
			sandbox: {
				// Verify that Bash spawns use the admitted platform Landlock launcher.
				// The upstream namespace backend cannot run in this security context.
				enabled: false,
				failIfUnavailable: true,
				allowUnsandboxedCommands: false,
				autoAllowBashIfSandboxed: true,
				filesystem: {
					allowWrite: [workspace],
					denyRead: [join(root, "private"), config, "/proc"],
					denyWrite: [config, join(root, "private")],
				},
				network: { allowedDomains: [], strictAllowlist: true },
				credentials: {
					envVars: tokenKeys.map((name) => ({ name, mode: "deny" })),
					files: [
						{ path: config, mode: "deny" },
						{ path: forbidden, mode: "deny" },
					],
				},
			},
		},
		{
			type: "user",
			session_id: "",
			parent_tool_use_id: null,
			message: { role: "user", content: "Run the synthetic Bash probe." },
		},
	);
	const outcomes: unknown[] = [];
	const failures: unknown[] = [];
	let stage = "native-result";
	let deadline: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			(async () => {
				// The SDK input stays open after a result. Retire the process in
				// finally before iterator cleanup, which can wait on that input.
				for (;;) {
					const next = await native.query.next();
					if (next.done)
						throw new Error("Claude query ended before its result");
					const message = next.value;
					if (message.type !== "result") continue;
					outcomes.push({
						subtype: message.subtype,
						is_error: message.is_error,
					});
					return;
				}
			})(),
			new Promise<never>((_, reject) => {
				deadline = setTimeout(
					() =>
						reject(
							new Error(
								JSON.stringify({
									stage: "await-native-result",
									calls,
									outcomes,
									requestMetadata,
									fixtureErrors,
								}),
							),
						),
					20_000,
				);
			}),
		]);
		stage = "fixture-response";
		expect(fixtureErrors).toEqual([]);
		expect(calls, JSON.stringify(requestMetadata)).toBe(shell ? 2 : 1);
		expect(outcomes).toEqual([{ subtype: "success", is_error: false }]);
		if (shell) {
			stage = "shell-tool-result";
			const messages = requests.at(-1)?.messages;
			const results = (Array.isArray(messages) ? messages : []).flatMap(
				(message) =>
					Array.isArray(message.content)
						? message.content.filter(
								(block: { type?: string; tool_use_id?: string }) =>
									block.type === "tool_result" &&
									block.tool_use_id === "isolated-bash",
							)
						: [],
			);
			// Only this synthetic tool result is considered; never dump model requests.
			const summary = results.map((result) => {
				const output =
					typeof result.content === "string"
						? result.content
						: JSON.stringify(result.content);
				return {
					isError: result.is_error === true,
					diagnostic: output
						.replaceAll(secret, "<redacted>")
						.replaceAll(root, "<fixture>")
						.split("\n")
						.filter((line: string) =>
							/bwrap|sandbox|permission denied|operation not permitted|not found|unshare|EPERM|not available|not installed/i.test(
								line,
							),
						)
						.slice(0, 4)
						.map((line: string) => line.slice(0, 300)),
				};
			});
			expect(summary, JSON.stringify(summary)).toEqual([
				{ isError: false, diagnostic: [] },
			]);
			stage = "shell-proof";
			expect(
				JSON.parse(
					await readFile(join(workspace, "claude-proof.json"), "utf8"),
				),
			).toEqual({ env: true, host: true, proc: true, native: true });
			expect(JSON.stringify(requests.at(-1)?.messages)).toContain(
				"isolated-claude-shell",
			);
		}
		stage = "credential-redaction";
		expect(JSON.stringify(requests)).not.toContain(secret);
	} catch (error) {
		failures.push(
			new Error(`Claude probe failed at ${stage}`, { cause: error }),
		);
	} finally {
		clearTimeout(deadline);
		try {
			await native.close();
		} catch (error) {
			failures.push(
				new Error("Claude probe failed at native-close", { cause: error }),
			);
		}
		server.closeAllConnections();
		await new Promise<void>((accept) => server.close(() => accept()));
		await rm(root, { recursive: true, force: true });
	}
	if (failures.length)
		throw new AggregateError(failures, "Claude probe failed");
});

it("rejects non-Messages and malformed requests without stalling the Claude fixture", async () => {
	const { createServer } = await import("node:http");
	let calls = 0;
	const server = createServer(async (request, response) => {
		const value = await readClaudeFixtureMessage(request, response);
		if (!value) return;
		calls++;
		completeClaudeResponse(response, "synthetic-fixture-response", value.model);
	});
	await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
	try {
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("Missing fixture endpoint");
		const endpoint = `http://127.0.0.1:${address.port}`;
		for (const [path, method, body, status] of [
			["/", "GET", undefined, 404],
			["/v1/messages", "GET", undefined, 404],
			["/status", "POST", "", 404],
			["/v1/messages", "POST", "", 400],
			["/v1/messages", "POST", "{}", 400],
			["/v1/messages", "POST", "[", 400],
			["/v1/messages", "POST", "x".repeat(1_048_577), 413],
		] as const) {
			const response = await fetch(`${endpoint}${path}`, {
				method,
				body,
				signal: AbortSignal.timeout(1000),
			});
			expect(response.status).toBe(status);
			await response.text();
		}
		expect(calls).toBe(0);
		const response = await fetch(`${endpoint}/v1/messages?beta=true`, {
			method: "POST",
			body: JSON.stringify({ model: "synthetic-model", messages: [] }),
			signal: AbortSignal.timeout(1000),
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("message_stop");
		expect(calls).toBe(1);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((accept) => server.close(() => accept()));
	}
});

it.skipIf(process.env.AGENT_INFRA_NATIVE_SHELL_TEST !== "1")(
	"runs production Claude Bash with child isolation, background inheritance and restart facts",
	async () => {
		const f = await fixture();
		const root = await realpath(f.path);
		const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
		const hostSecret = join(root, "host-secret.txt");
		await writeFile(hostSecret, "synthetic-host-secret");
		f.hold();
		const firstCommand = claudeCommand("shell-first");
		const accepted = await f.driver.execute(firstCommand);
		const workspace = join(root, accepted.nativeSessionRef, "workspace");
		const nativeConfig = join(
			root,
			accepted.nativeSessionRef,
			"config",
			"shell-secret.txt",
		);
		await writeFile(nativeConfig, "synthetic-native-secret");
		await symlink(root, join(workspace, "escape"));
		const forbidden = [
			hostSecret,
			nativeConfig,
			join(workspace, "escape/host-secret.txt"),
			"/proc/self/environ",
			`/proc/${process.pid}/environ`,
			`/proc/${process.pid}/mem`,
			`/proc/${process.pid}/fd/0`,
		];
		const program = `const fs=require('node:fs'); const denied=p=>{try{fs.readFileSync(p);return false}catch{return true}}; const proof={env:Object.keys(process.env).every(k=>!/TOKEN|SECRET|ANTHROPIC|AGENT_INFRA|BASH_ENV|NODE_OPTIONS/.test(k)),files:${JSON.stringify(forbidden)}.every(denied)}; fs.writeFileSync('../memory/shell-memory.txt','owned-memory'); fs.writeFileSync(process.argv[1],JSON.stringify(proof)); process.stdout.write('isolated-production-shell');`;
		const runShell = async (
			offset: number,
			file: string,
			background: boolean,
		) => {
			await vi.waitFor(() => expect(f.calls).toHaveLength(offset + 1), {
				timeout: 10000,
			});
			const call = f.calls[offset];
			if (!call) throw Error();
			expect(call.body.tools).toEqual(
				expect.arrayContaining([expect.objectContaining({ name: "Bash" })]),
			);
			const command = `/usr/local/bin/node -e ${quote(program)} ${quote(file)}`;
			completeClaudeToolUses(
				call.response,
				`msg_shell_${offset}`,
				String(call.body.model),
				"",
				[
					{
						id: `production_shell_${offset}`,
						name: "Bash",
						input: {
							command: background
								? `${command} & wait`
								: `${command} && test -s ${quote(file)}`,
							timeout: 5000,
						},
					},
				],
			);
			await vi.waitFor(() => expect(f.calls).toHaveLength(offset + 2), {
				timeout: 10000,
			});
			expect(JSON.parse(await readFile(join(workspace, file), "utf8"))).toEqual(
				{ env: true, files: true },
			);
			const answer = f.calls[offset + 1];
			if (!answer) throw Error();
			expect(JSON.stringify(answer.body.messages)).toContain(
				"isolated-production-shell",
			);
			f.release();
		};
		await runShell(0, "first-proof.json", false);
		await f.settled(accepted.nativeSessionRef, firstCommand.executionId);
		const persisted = JSON.parse(
			await readFile(
				join(root, accepted.nativeSessionRef, "state.json"),
				"utf8",
			),
		);
		const shellFacts = persisted.turns
			.find(
				(turn: { executionId: string }) =>
					turn.executionId === firstCommand.executionId,
			)
			.operationFacts.filter(
				(fact: { toolId?: string }) => fact.toolId === "Bash",
			);
		expect(shellFacts.map((fact: { phase: string }) => fact.phase)).toEqual([
			"started",
			"completed",
		]);
		expect(
			shellFacts.every(
				(fact: { startedAt?: string; durationMs?: number }) =>
					fact.startedAt === undefined && fact.durationMs === undefined,
			),
		).toBe(true);
		const events = await f.driver.replayEvents(
			accepted.nativeSessionRef,
			firstCommand.executionId,
		);
		expect(
			events
				.filter(
					(event) => event.type === "tool" && event.payload.name === "Bash",
				)
				.map((event) => (event.type === "tool" ? event.payload.phase : "")),
		).toEqual(["started", "completed"]);
		const beforeRestart = f.calls.length;
		await f.restart();
		expect(await f.driver.lookupOperation(firstCommand)).toMatchObject({
			state: "found",
		});
		expect(
			await f.driver.replayEvents(
				accepted.nativeSessionRef,
				firstCommand.executionId,
			),
		).toEqual(events);
		expect(f.calls).toHaveLength(beforeRestart);
		f.hold();
		const secondCommand = {
			...claudeCommand("shell-second"),
			nativeSessionRef: accepted.nativeSessionRef,
		};
		await f.driver.execute(secondCommand);
		await runShell(beforeRestart, "background-proof.json", true);
		await f.settled(accepted.nativeSessionRef, secondCommand.executionId);
		// Revoke admission after this Query has already advertised Bash.
		const shellModule = await import("./claude-shell.js");
		const unavailable = vi.spyOn(shellModule, "claudeShellAvailable");
		try {
			await f.restart();
			f.hold();
			const offset = f.calls.length;
			const deniedCommand = {
				...claudeCommand("shell-unavailable"),
				nativeSessionRef: accepted.nativeSessionRef,
			};
			await f.driver.execute(deniedCommand);
			await vi.waitFor(() => expect(f.calls).toHaveLength(offset + 1), {
				timeout: 10000,
			});
			const call = f.calls[offset];
			if (!call) throw Error();
			expect(call.body.tools).toEqual(
				expect.arrayContaining([expect.objectContaining({ name: "Bash" })]),
			);
			unavailable.mockResolvedValue(false);
			completeClaudeToolUses(
				call.response,
				"msg_denied_shell",
				String(call.body.model),
				"",
				[
					{
						id: "denied_shell",
						name: "Bash",
						input: { command: "touch forbidden-fallback" },
					},
				],
			);
			await vi.waitFor(() => expect(f.calls).toHaveLength(offset + 2), {
				timeout: 10000,
			});
			await expect(
				readFile(join(workspace, "forbidden-fallback")),
			).rejects.toThrow();
			f.release();
			await f.settled(accepted.nativeSessionRef, deniedCommand.executionId);
		} finally {
			unavailable.mockRestore();
		}
	},
	30_000,
);
