import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CodexExecutorDrainJournalV1 } from "./codex-executor-drain-journal.js";

const paths: string[] = [];
const scope = {
	executionId: "execution-a",
	podUid: "pod-a",
	generation: 2,
	resourceFence: 3,
	epoch: "epoch-a",
};

async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "executor-drain-journal-"));
	paths.push(dir);
	const path = join(dir, "journal.json");
	return { path, journal: await CodexExecutorDrainJournalV1.open(path, scope) };
}

afterEach(async () => {
	for (const path of paths.splice(0))
		await rm(path, { recursive: true, force: true });
});

it("retains admitted attempts and the seal across restart before a launch acknowledgement", async () => {
	const { path, journal } = await fixture();
	const attempt = { protocolSession: "session", handle: "handle" };
	expect(await journal.admit(attempt)).toBe(false);
	await journal.bindNativeTurn("turn-original");
	await expect(journal.bindNativeTurn("turn-other")).rejects.toThrow(
		"CODEX_EXECUTOR_DRAIN_JOURNAL_INVALID",
	);
	expect(await journal.admit(attempt)).toBe(true);
	const stop = { stopRequestId: "stop-a", stopFence: 4 };
	const seal = await journal.seal(stop);
	expect(seal.attempts).toEqual([attempt]);
	expect(await journal.admit({ ...attempt, handle: "late" })).toBe(false);
	await journal.close();

	const recovered = await CodexExecutorDrainJournalV1.open(path, scope);
	expect(await recovered.seal(stop)).toEqual(seal);
	expect(await recovered.admit(attempt)).toBe(false);
	expect(await recovered.confirm(stop, "b".repeat(64))).toBe(false);
	expect(await recovered.confirm(stop, seal.digest)).toBe(true);
	expect(recovered.confirmed()).toBe(true);
	await recovered.close();
});

it("does not let a new Pod or fence adopt prior evidence", async () => {
	const { path, journal } = await fixture();
	await journal.seal({ stopRequestId: "stop-a", stopFence: 4 });
	await journal.close();
	await expect(
		CodexExecutorDrainJournalV1.open(path, { ...scope, podUid: "pod-b" }),
	).rejects.toThrow("CODEX_EXECUTOR_DRAIN_JOURNAL_INVALID");
	await expect(
		CodexExecutorDrainJournalV1.open(path, { ...scope, resourceFence: 4 }),
	).rejects.toThrow("CODEX_EXECUTOR_DRAIN_JOURNAL_INVALID");
});
