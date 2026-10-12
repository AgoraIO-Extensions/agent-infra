import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { rehoboamV13ConnectionCatalog } from "./rehoboam-v13.ts";
import {
	RehoboamV14Adapter,
	rehoboamV14ConnectionCatalog,
	repairAction,
} from "./rehoboam-v14.ts";
import { rehoboamV14ExecutorDigest } from "./rehoboam-v14-integrity.ts";

const data = {
	familyId: "family-1",
	memberId: "member-1",
	taskId: "update_dependency",
	expectedRevision: 8,
	templateSignature: "sha256:plan",
	stage: "waiting_merge",
	note: "Managed compilation passed; package not built",
	prUrl: "https://github.com/example/sdk/pull/1",
	validationUrl: "https://github.com/example/sdk/actions/runs/123",
	sourceCommit: "a".repeat(40),
	idempotencyKey: "repair-1",
};
const credential = { accessToken: "stored-pat" };

test("v14 adds only explicit repair recording and keeps old action contracts", () => {
	const hash = createHash("sha256");
	for (const file of [
		"rehoboam.ts",
		"rehoboam-management.ts",
		"rehoboam-v11.ts",
		"rehoboam-v12.ts",
		"rehoboam-v13.ts",
		"rehoboam-v14.ts",
	])
		hash
			.update(file)
			.update("\0")
			.update(readFileSync(new URL(file, import.meta.url)))
			.update("\0");
	assert.equal(rehoboamV14ExecutorDigest, `sha256:${hash.digest("hex")}`);
	assert.equal(
		rehoboamV14ConnectionCatalog.actions.length,
		rehoboamV13ConnectionCatalog.actions.length + 1,
	);
	for (const old of rehoboamV13ConnectionCatalog.actions) {
		const current = rehoboamV14ConnectionCatalog.actions.find(
			(item) => item.name === old.name,
		);
		assert.ok(current);
		assert.deepEqual(current.inputSchema, old.inputSchema);
		assert.equal(current.effect, old.effect);
		assert.deepEqual(current.requiredScopes, old.requiredScopes);
	}
});

test("repair writes a fixed path with credential identity and leaves original task execution alone", async () => {
	const sent: { url: string; init?: RequestInit }[] = [];
	const adapter = new RehoboamV14Adapter(async (url, init) => {
		sent.push({ url: String(url), init });
		return Response.json({ data: { id: "family-1", revision: 9 } });
	}, "gateway");
	assert.equal(
		(
			await adapter.execute({
				action: repairAction.name,
				credential,
				input: data,
			})
		).revision,
		9,
	);
	assert.equal(sent.length, 1);
	assert.equal(
		sent[0]?.url,
		"https://justinia.gz3.agoralab.co/mcp/v1/release-families/family-1/members/member-1/tasks/update_dependency/record",
	);
	const init = sent[0]?.init;
	assert.equal(init?.redirect, "manual");
	assert.equal(
		new Headers(init?.headers).get("authorization"),
		"Bearer stored-pat",
	);
	assert.equal(new Headers(init?.headers).get("Idempotency-Key"), "repair-1");
	assert.deepEqual(JSON.parse(String(init?.body)), {
		expected_revision: 8,
		template_signature: "sha256:plan",
		disposition: "repair_progress",
		note: data.note,
		repair_progress: {
			stage: data.stage,
			pr_url: data.prUrl,
			validation_url: data.validationUrl,
			source_commit: data.sourceCommit,
		},
	});
	for (const invalid of [
		{ ...data, actor: "someone-else" },
		{ ...data, familyId: ".." },
		{ ...data, expectedRevision: -1 },
	])
		await assert.rejects(
			adapter.execute({
				action: repairAction.name,
				credential,
				input: invalid,
			}),
			{ providerSubmissionOutcome: "rejected" },
		);
	assert.equal(sent.length, 1);
});

test("repair submission distinguishes conflicts from uncertain outcomes and never retries", async () => {
	for (const [status, expected] of [
		[
			409,
			{
				providerSubmissionOutcome: "rejected",
				providerCode: "family_revision_conflict",
			},
		],
		[500, { submissionUncertain: true }],
	] as const) {
		let calls = 0;
		const adapter = new RehoboamV14Adapter(async () => {
			calls++;
			return Response.json(
				{ error: { code: "family_revision_conflict" } },
				{ status },
			);
		}, "gateway");
		await assert.rejects(
			adapter.execute({ action: repairAction.name, credential, input: data }),
			expected,
		);
		assert.equal(calls, 1);
	}
	const adapter = new RehoboamV14Adapter(async () => {
		throw new Error("transport");
	}, "gateway");
	await assert.rejects(
		adapter.execute({ action: repairAction.name, credential, input: data }),
		{ submissionUncertain: true },
	);
});
