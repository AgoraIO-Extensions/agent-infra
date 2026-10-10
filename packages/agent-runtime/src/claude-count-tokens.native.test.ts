import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeOperationFactV2 } from "@agent-infra/contracts/runtime";
import { expect, it, vi } from "vitest";
import { verifyClaudeInstallation } from "./claude-installation.js";
import {
	claudeCommand,
	claudeNativeFixture,
} from "./claude-native.test-support.js";
import * as queries from "./claude-query.js";

it("persists a separate intent before pinned Claude context usage sends count_tokens and preserves generation receipts", async () => {
	const installation = await verifyClaudeInstallation();
	const original = queries.claudeQuery;
	let context: Promise<unknown> | undefined;
	// Invoke the pinned SDK's actual control request; Native constructs/sends the count HTTP request.
	vi.spyOn(queries, "claudeQuery").mockImplementation((options, message) => {
		const native = original(options, message);
		context = native.query.getContextUsage();
		void context.catch(() => {});
		return native;
	});
	const upstreamIntents: {
		url: string | undefined;
		fact: RuntimeOperationFactV2;
		modelResponse: unknown;
	}[] = [];
	const f = await claudeNativeFixture(async (url) => {
		const [directory] = await readdir(f.path);
		if (!directory) throw Error("Durable Session missing before upstream send");
		const state = JSON.parse(
			await readFile(join(f.path, directory, "state.json"), "utf8"),
		);
		const facts: RuntimeOperationFactV2[] = state.turns[0].events.flatMap(
			(event: { type: string; payload: RuntimeOperationFactV2 }) =>
				event.type === "operation" ? [event.payload] : [],
		);
		const current = url?.includes("count_tokens")
			? facts.at(-1)
			: facts.findLast((fact) => fact.operationRef === facts[0]?.operationRef);
		if (!current || !["intent", "started"].includes(current.phase))
			throw Error("Per-request durable intent missing before upstream send");
		upstreamIntents.push({
			url,
			fact: current,
			modelResponse: state.turns[0].modelResponse,
		});
	});
	try {
		const command = claudeCommand();
		const accepted = await f.driver.execute(command);
		await f.settled(accepted.nativeSessionRef, command.executionId);
		await context;
		const counts = upstreamIntents.filter((call) =>
			call.url?.includes("count_tokens"),
		);
		expect(counts).toHaveLength(1);
		expect(counts[0]?.modelResponse).toBeUndefined();
		const events = await f.driver.replayEvents(
			accepted.nativeSessionRef,
			command.executionId,
		);
		const facts = events.flatMap((event) =>
			event.type === "operation" && event.payload.kind === "model"
				? [event.payload]
				: [],
		);
		const countFacts = facts.filter(
			(fact) => fact.operationRef === counts[0]?.fact.operationRef,
		);
		expect(countFacts.map((fact) => fact.phase)).toEqual([
			"intent",
			"started",
			"completed",
		]);
		expect(new Set(countFacts.map((fact) => fact.attemptRef)).size).toBe(1);
		expect(countFacts.every((fact) => fact.usage === undefined)).toBe(true);
		expect(countFacts.at(-1)?.durationMs).toBeGreaterThanOrEqual(0);
		const generation = facts.filter(
			(fact) => fact.operationRef !== counts[0]?.fact.operationRef,
		);
		expect(generation.map((fact) => fact.phase)).toEqual([
			"intent",
			"started",
			"completed",
		]);
		expect(generation.at(-1)?.usage).toEqual({
			inputTokens: 10,
			outputTokens: 2,
		});
		const state = JSON.parse(
			await readFile(
				join(f.path, accepted.nativeSessionRef, "state.json"),
				"utf8",
			),
		);
		expect(state.turns[0].modelResponse).toEqual({
			state: "completed",
			endTurn: true,
		});
		if (process.env.AGENT_INFRA_CLAUDE_COUNT_EVIDENCE_PATH)
			await writeFile(
				process.env.AGENT_INFRA_CLAUDE_COUNT_EVIDENCE_PATH,
				JSON.stringify(
					{
						native: installation,
						executionId: command.executionId,
						upstreamIntents,
						requests: f.calls.map((call) => call.url),
						facts,
					},
					null,
					2,
				),
			);
		await f.restart();
		expect(await f.driver.execute(command)).toEqual(accepted);
		expect(
			await f.driver.replayEvents(
				accepted.nativeSessionRef,
				command.executionId,
			),
		).toEqual(events);
		expect(f.calls).toHaveLength(2);
	} finally {
		await f.close();
		vi.restoreAllMocks();
	}
}, 30000);
