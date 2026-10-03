import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openMessagesRuntimeDriverConformanceFixture } from "./messages-runtime-driver.test-support.js";

it("runs the pinned Pi CLI against Messages and persists the confirmed result", async () => {
	const path = await mkdtemp(join(tmpdir(), "pi-native-"));
	const fixture = await openMessagesRuntimeDriverConformanceFixture(
		path,
		false,
		"pi",
	);
	try {
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
				modelOptionId: "model-option-primary",
				reasoningLevel: "high",
			},
		};
		const record = await fixture.driver.execute(command);
		expect(record.result.outcome).toBe("accepted");
		await fixture.completeStopAsCompleted();
		expect(
			await fixture.driver.getStatus(
				record.nativeSessionRef,
				command.executionId,
			),
		).toBe("completed");
		const before = await fixture.driver.replayEvents(
			record.nativeSessionRef,
			command.executionId,
		);
		await fixture.driver.close();
		// Crash after native persistence but before the Driver commits the terminal event.
		const file = join(path, record.nativeSessionRef, "state.json");
		const state = JSON.parse(await readFile(file, "utf8"));
		state.turns[0].events.pop();
		state.sequence--;
		state.turns[0].status = "unknown";
		delete state.turns[0].nativeStopReason;
		delete state.operations[0].record;
		await writeFile(file, JSON.stringify(state));
		await fixture.restart();
		expect(
			await fixture.driver.getStatus(
				record.nativeSessionRef,
				command.executionId,
			),
		).toBe("completed");
		expect(
			(
				await fixture.driver.replayEvents(
					record.nativeSessionRef,
					command.executionId,
				)
			).filter((event) => event.type === "text"),
		).toEqual(before.filter((event) => event.type === "text"));
		expect(await fixture.driver.lookupOperation(command)).toEqual({
			state: "found",
			record,
		});
		expect(await fixture.driver.execute(command)).toEqual(record);
		expect(await fixture.createdTurnCount()).toBe(1);
		// Writable project configuration cannot load an extension or override the selection.
		const workspace = join(path, record.nativeSessionRef, "workspace");
		await mkdir(join(workspace, ".pi"));
		const marker = join(path, "untrusted-extension-ran");
		await writeFile(
			join(workspace, ".pi/untrusted.mjs"),
			`import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "unexpected"); export default function() {}`,
		);
		await writeFile(
			join(workspace, ".pi/settings.json"),
			JSON.stringify({
				extensions: ["./untrusted.mjs"],
				defaultProvider: "untrusted",
				defaultModel: "wrong-model",
			}),
		);
		const next = await fixture.driver.execute({
			...command,
			nativeSessionRef: record.nativeSessionRef,
			executionId: "execution-b",
			turnId: "turn-b",
			operationId: "operation-b",
			selection: {
				...command.selection,
				modelOptionId: "model-option-alternate",
				reasoningLevel: "low",
			},
		});
		await fixture.completeStopAsCompleted();
		expect(next.result.outcome).toBe("accepted");
		expect(JSON.parse(await readFile(file, "utf8")).nativeId).toBe(
			state.nativeId,
		);
		expect(fixture.turnSelections()).toEqual([
			command.selection,
			{
				...command.selection,
				modelOptionId: "model-option-alternate",
				reasoningLevel: "low",
			},
		]);
		await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
		await fixture.driver.close();
		const nativeFile = join(
			path,
			record.nativeSessionRef,
			"native/session.jsonl",
		);
		const header = (await readFile(nativeFile, "utf8")).split("\n")[0];
		await writeFile(nativeFile, `${header}\n`);
		await fixture.restart();
		await expect(
			fixture.driver.getStatus(record.nativeSessionRef, "execution-b"),
		).rejects.toThrow("Runtime session could not be recovered");
		await expect(
			fixture.driver.execute({
				...command,
				nativeSessionRef: record.nativeSessionRef,
				executionId: "execution-c",
				turnId: "turn-c",
				operationId: "operation-c",
			}),
		).rejects.toThrow("Runtime session could not be recovered");
		expect(await readFile(nativeFile, "utf8")).toBe(`${header}\n`);
		expect(await fixture.createdTurnCount()).toBe(2);
	} finally {
		await fixture.close();
		await rm(path, { recursive: true, force: true });
	}
}, 30_000);
