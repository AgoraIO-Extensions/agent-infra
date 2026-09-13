import {
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
} from "./claude-native.test-support.js";

const fixtures: Awaited<ReturnType<typeof claudeNativeFixture>>[] = [];
async function fixture() {
	const value = await claudeNativeFixture();
	fixtures.push(value);
	return value;
}
afterEach(async () => {
	for (const value of fixtures.splice(0)) await value.close();
});

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

it("waits for native exit after a permission error on the retiring process group before resuming", async () => {
	const f = await fixture();
	f.hold();
	const first = await f.driver.execute(claudeCommand());
	await vi.waitFor(() => expect(f.calls).toHaveLength(1));
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
