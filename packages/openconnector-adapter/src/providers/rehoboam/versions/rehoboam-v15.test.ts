import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { rehoboamV14ConnectionCatalog } from "./rehoboam-v14.ts";
import {
	cancelChannelPublishAction,
	RehoboamV15Adapter,
	rehoboamV15ConnectionCatalog,
	rehoboamV15LegacyProviderReleaseIds,
} from "./rehoboam-v15.ts";
import { rehoboamV15ExecutorDigest } from "./rehoboam-v15-integrity.ts";

const task = "a".repeat(24);
const credential = { accessToken: "synthetic-pat" };
const input = {
	releaseSystem: "channel_publishing",
	taskId: task,
	idempotencyKey: "cancel-1",
	comment: "test cleanup",
};
const receipt = {
	release_system: "channel_publishing",
	task_id: task,
	status: "CANCELLED",
	cancellation: { actor: "owner", at: 123, comment: input.comment },
};

test("v15 adds only cancellation and retains v14 contracts and immutable implementations", () => {
	const hash = createHash("sha256");
	for (const file of [
		"rehoboam.ts",
		"rehoboam-management.ts",
		"rehoboam-v11.ts",
		"rehoboam-v12.ts",
		"rehoboam-v13.ts",
		"rehoboam-v14.ts",
		"rehoboam-v15.ts",
	])
		hash
			.update(file)
			.update("\0")
			.update(readFileSync(new URL(file, import.meta.url)))
			.update("\0");
	assert.equal(rehoboamV15ExecutorDigest, `sha256:${hash.digest("hex")}`);
	assert.equal(
		rehoboamV15ConnectionCatalog.actions.length,
		rehoboamV14ConnectionCatalog.actions.length + 1,
	);
	assert.ok(
		rehoboamV15LegacyProviderReleaseIds.includes("rehoboam-connection-v14"),
	);
	for (const old of rehoboamV14ConnectionCatalog.actions) {
		const next = rehoboamV15ConnectionCatalog.actions.find(
			(item) => item.name === old.name,
		);
		assert.deepEqual(next, { ...old, id: old.id.replace(/@v14$/, "@v15") });
	}
	assert.equal(cancelChannelPublishAction.effect, "WRITE");
	assert.deepEqual(cancelChannelPublishAction.requiredScopes, [
		"rehoboam.publishing.write",
	]);
});

test("cancellation uses fixed path, identity and native key without submitting a status or actor", async () => {
	const sent: { url: string; init?: RequestInit }[] = [];
	const adapter = new RehoboamV15Adapter(async (url, init) => {
		sent.push({ url: String(url), init });
		return Response.json(receipt);
	}, "synthetic-gateway");
	assert.deepEqual(
		await adapter.execute({
			action: cancelChannelPublishAction.name,
			credential,
			input,
		}),
		receipt,
	);
	assert.equal(sent.length, 1);
	assert.equal(
		sent[0]?.url,
		`https://justinia.gz3.agoralab.co/api/v1/channel-publishing/requests/${task}/cancellation`,
	);
	assert.equal(sent[0]?.init?.method, "POST");
	assert.equal(sent[0]?.init?.redirect, "manual");
	assert.equal(
		new Headers(sent[0]?.init?.headers).get("Idempotency-Key"),
		"cancel-1",
	);
	assert.equal(
		new Headers(sent[0]?.init?.headers).get("authorization"),
		"Bearer synthetic-pat",
	);
	assert.deepEqual(JSON.parse(String(sent[0]?.init?.body)), {
		release_system: "channel_publishing",
		comment: "test cleanup",
	});
});

test("invalid keys, foreign systems and identity overrides never reach the Provider", async () => {
	let calls = 0;
	const adapter = new RehoboamV15Adapter(async () => {
		calls++;
		return Response.json(receipt);
	}, "gateway");
	for (const invalid of [
		{
			releaseSystem: input.releaseSystem,
			taskId: task,
			comment: input.comment,
		},
		{ ...input, idempotencyKey: "invalid key" },
		{ ...input, releaseSystem: "pipeline_center" },
		{ ...input, actor: "other" },
		{ ...input, taskId: "../other" },
		{ ...input, comment: "x".repeat(2001) },
	])
		await assert.rejects(
			adapter.execute({
				action: cancelChannelPublishAction.name,
				credential,
				input: invalid,
			}),
			{ providerSubmissionOutcome: "rejected" },
		);
	await assert.rejects(
		adapter.execute({
			action: cancelChannelPublishAction.name,
			credential,
			input,
			actionVersionId: "rehoboam.cancel_channel_publish_request@v14",
		}),
		{ providerSubmissionOutcome: "rejected" },
	);
	await assert.rejects(
		adapter.execute({
			action: cancelChannelPublishAction.name,
			credential,
			input,
			providerReleaseId: "rehoboam-connection-v14",
		}),
		{ providerSubmissionOutcome: "rejected" },
	);
	await assert.rejects(
		adapter.execute({
			action: cancelChannelPublishAction.name,
			credential: { accessToken: "" },
			input,
		}),
		{ providerCredentialInvalid: true },
	);
	assert.equal(calls, 0);
});

test("owner, state and replay conflicts are known rejections; timeouts and 5xx are uncertain", async () => {
	for (const status of [401, 403, 404, 409, 408, 413, 500]) {
		let calls = 0;
		const adapter = new RehoboamV15Adapter(async () => {
			calls++;
			return Response.json(
				{ error: { code: "CANCELLATION_STATE_CONFLICT" } },
				{ status },
			);
		}, "gateway");
		await assert.rejects(
			adapter.execute({
				action: cancelChannelPublishAction.name,
				credential,
				input,
			}),
			(error: {
				providerStatus?: number;
				providerSubmissionOutcome?: string;
				submissionUncertain?: boolean;
			}) => {
				assert.equal(error.providerStatus, status);
				assert.equal(
					error.submissionUncertain === true,
					[408, 413].includes(status) || status >= 500,
				);
				assert.equal(
					error.providerSubmissionOutcome,
					[408, 413].includes(status) || status >= 500 ? undefined : "rejected",
				);
				return true;
			},
		);
		assert.equal(calls, 1);
	}
});

test("transport loss, malformed and oversized responses never report success or retry", async () => {
	const cases = [
		async () => {
			throw new TypeError("response lost");
		},
		async () => new Response("not json"),
		async () => new Response("x".repeat(65537)),
		async () => Response.json({ ...receipt, task_id: "b".repeat(24) }),
		async () => Response.json({ ...receipt, status: "RUNNING" }),
		async () => Response.json({ ...receipt, cancellation: null }),
	];
	for (const fetcher of cases) {
		let calls = 0;
		const adapter = new RehoboamV15Adapter(async () => {
			calls++;
			return fetcher();
		}, "gateway");
		await assert.rejects(
			adapter.execute({
				action: cancelChannelPublishAction.name,
				credential,
				input,
			}),
			{ submissionUncertain: true },
		);
		assert.equal(calls, 1);
	}
});
