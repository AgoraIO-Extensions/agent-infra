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

it("durably refines only the original attempt after an explicit native rejection, including an already sealed Stop", async () => {
	const { path, journal } = await fixture();
	const attempt = { protocolSession: "session", handle: "rejected" };
	await journal.bindNativeTurn("turn-original");
	expect(await journal.admit(attempt)).toBe(true);
	const stop = { stopRequestId: "stop-a", stopFence: 4 };
	const before = await journal.seal(stop);
	const rejection = await journal.rejectStart(attempt, -32603, 1000);
	expect(await journal.rejectStart(attempt, -32603, 1000)).toEqual(rejection);
	await expect(
		journal.rejectStart({ ...attempt, handle: "another" }, -32603, 1000),
	).rejects.toThrow();
	await expect(journal.rejectStart(attempt, -32000, 1000)).rejects.toThrow();
	await journal.close();
	const recovered = await CodexExecutorDrainJournalV1.open(path, scope);
	try {
		const after = await recovered.seal(stop);
		expect(after.attempts).toEqual([{ ...attempt, rejection }]);
		expect(after.digest).not.toBe(before.digest);
		expect(await recovered.confirm(stop, after.digest)).toBe(false);
		const evidence = {
			verifiedAt: 1200,
			groups: [],
			rejectedStarts: [{ id: rejection.id, rejectedAt: 1000 }],
		};
		expect(await recovered.confirm(stop, before.digest, evidence)).toBe(false);
		expect(
			await recovered.confirm(stop, after.digest, {
				...evidence,
				rejectedStarts: [],
			}),
		).toBe(false);
		expect(
			await recovered.confirm(stop, after.digest, {
				...evidence,
				rejectedStarts: [{ id: "a".repeat(64), rejectedAt: 1000 }],
			}),
		).toBe(false);
		expect(
			await recovered.confirm(
				{ ...stop, stopFence: 3 },
				after.digest,
				evidence,
			),
		).toBe(false);
		expect(await recovered.confirm(stop, after.digest, evidence)).toBe(true);
		expect(recovered.evidence()).toMatchObject({
			...scope,
			...stop,
			...evidence,
		});
	} finally {
		await recovered.close();
	}
});

it("retains occupancy for an admitted start with no authenticated native rejection", async () => {
	const { journal } = await fixture();
	try {
		await journal.bindNativeTurn("turn-original");
		await journal.admit({ protocolSession: "session", handle: "unknown" });
		const stop = { stopRequestId: "stop-a", stopFence: 4 };
		const sealed = await journal.seal(stop);
		expect(
			await journal.confirm(stop, sealed.digest, {
				verifiedAt: 1200,
				groups: [],
			}),
		).toBe(false);
		expect(journal.confirmed()).toBe(false);
	} finally {
		await journal.close();
	}
});

it("keeps an unfinished V2 journal under its original startup attempt and leaves its ACK/Stop unchanged", async () => {
	const dir = await mkdtemp(join(tmpdir(), "executor-v2-journal-"));
	paths.push(dir);
	const path = join(dir, "journal.json");
	const startup = {
		schemaVersion: 2 as const,
		attemptId: "a3a70de0-42c8-4d3b-9e93-956695751afa",
		startupRef: "executor-original",
		recordRef: "a3a70de0-42c8-4d3b-9e93-956695751afb",
		factDigest: "a".repeat(64),
	};
	const original = await CodexExecutorDrainJournalV1.open(path, {
		...scope,
		startup,
	});
	await original.bindNativeTurn("original-turn");
	await original.admit({
		protocolSession: "original-native",
		handle: "unconfirmed-tool",
	});
	const stop = { stopRequestId: "original-stop", stopFence: 7 };
	const seal = await original.seal(stop);
	await original.close();
	await expect(
		CodexExecutorDrainJournalV1.open(path, {
			...scope,
			startup: {
				...startup,
				attemptId: "a3a70de0-42c8-4d3b-9e93-956695751afc",
			},
		}),
	).rejects.toThrow("CODEX_EXECUTOR_DRAIN_JOURNAL_INVALID");
	const reopened = await CodexExecutorDrainJournalV1.open(path, {
		...scope,
		startup,
	});
	expect(await reopened.seal(stop)).toEqual(seal);
	expect(reopened.confirmed()).toBe(false);
	expect(reopened.sealedStop()).toEqual(stop);
	await reopened.close();
});
