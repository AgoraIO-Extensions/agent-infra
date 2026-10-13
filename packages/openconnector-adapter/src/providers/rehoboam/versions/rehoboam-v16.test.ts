import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { rehoboamV15ConnectionCatalog } from "./rehoboam-v15.ts";
import {
	helpActions,
	RehoboamV16Adapter,
	rehoboamV16ConnectionCatalog,
} from "./rehoboam-v16.ts";
import { rehoboamV16ExecutorDigest } from "./rehoboam-v16-integrity.ts";

const credential = { accessToken: "synthetic-pat" };
const data = {
	title: "article",
	scope: "通用",
	content: "Check the result and applicable profile.",
	contentHash: "a".repeat(64),
	evidenceUrls: ["https://example.com/job/1"],
	relatedArticleIds: ["failure"],
	idempotencyKey: "key-1",
};
const article = {
	id: "b".repeat(64),
	title: data.title,
	scope: data.scope,
	content: data.content,
	evidence_urls: data.evidenceUrls,
	related_article_ids: data.relatedArticleIds,
};
const body = {
	title: data.title,
	scope: data.scope,
	content: data.content,
	content_hash: data.contentHash,
	evidence_urls: data.evidenceUrls,
	related_article_ids: data.relatedArticleIds,
};
const receipt = {
	id: article.id,
	owner: "owner",
	revision: 1,
	status: "published",
	published: true,
	article,
};
const submit = "rehoboam.publish_pipeline_help_article";

test("v16 adds only four help actions and preserves all old contracts and pinned source", () => {
	const hash = createHash("sha256");
	for (const file of [
		"rehoboam.ts",
		"rehoboam-management.ts",
		"rehoboam-v11.ts",
		"rehoboam-v12.ts",
		"rehoboam-v13.ts",
		"rehoboam-v14.ts",
		"rehoboam-v15.ts",
		"rehoboam-v16.ts",
	])
		hash
			.update(file)
			.update("\0")
			.update(readFileSync(new URL(file, import.meta.url)))
			.update("\0");
	assert.equal(rehoboamV16ExecutorDigest, `sha256:${hash.digest("hex")}`);
	assert.equal(
		rehoboamV16ConnectionCatalog.actions.length,
		rehoboamV15ConnectionCatalog.actions.length + 4,
	);
	for (const old of rehoboamV15ConnectionCatalog.actions)
		assert.deepEqual(
			rehoboamV16ConnectionCatalog.actions.find((row) => row.name === old.name),
			{ ...old, id: old.id.replace(/@v15$/, "@v16") },
		);
	assert.equal(helpActions.filter((row) => row.effect === "WRITE").length, 2);
});

test("fixed help paths and auth; input maps to backend keys, never actor/status/endpoint", async () => {
	const requests: { url: string; init?: RequestInit }[] = [];
	const adapter = new RehoboamV16Adapter(async (url, init) => {
		requests.push({ url: String(url), init });
		return Response.json({
			success: true,
			data:
				init?.method === "GET"
					? { content_hash: data.contentHash, items: [] }
					: receipt,
		});
	}, "synthetic-gateway");
	assert.deepEqual(
		await adapter.execute({ action: submit, credential, input: data }),
		receipt,
	);
	assert.equal(
		requests[0]?.url,
		"https://justinia.gz3.agoralab.co/mcp/v1/pipeline-help/knowledge",
	);
	assert.equal(requests[0]?.init?.redirect, "manual");
	assert.equal(
		new Headers(requests[0]?.init?.headers).get("Idempotency-Key"),
		data.idempotencyKey,
	);
	assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), body);
	await adapter.execute({
		action: "rehoboam.search_pipeline_help",
		credential,
		input: { query: "40 位", limit: 2 },
	});
	assert.ok(requests[1]?.url.includes("query=40+%E4%BD%8D"));
	assert.equal(requests[1]?.init?.method, "GET");
});

test("new actions cannot execute through old bindings or malformed schemas", async () => {
	let calls = 0;
	const adapter = new RehoboamV16Adapter(async () => {
		calls++;
		return Response.json({ success: true, data: receipt });
	}, "gateway");
	for (const invalid of [
		{ ...data, actor: "admin" },
		{ ...data, status: "published" },
		{ ...data, content: "" },
		{ ...data, idempotencyKey: "bad key" },
		{ ...data, evidenceUrls: Array(9).fill("https://example.com/job/1") },
		{ ...data, contentHash: "bad" },
	])
		await assert.rejects(
			adapter.execute({ action: submit, credential, input: invalid }),
			{ providerSubmissionOutcome: "rejected" },
		);
	await assert.rejects(
		adapter.execute({
			action: submit,
			credential,
			input: data,
			providerReleaseId: "rehoboam-connection-v15",
		}),
		{ providerSubmissionOutcome: "rejected" },
	);
	await assert.rejects(
		adapter.execute({
			action: submit,
			credential,
			input: data,
			actionVersionId: `${submit}@v15`,
		}),
		{ providerSubmissionOutcome: "rejected" },
	);
	await assert.rejects(
		adapter.execute({
			action: "rehoboam.get_pipeline_help_article",
			credential,
			input: { articleId: "../secret" },
		}),
		{ providerSubmissionOutcome: "rejected" },
	);
	assert.equal(calls, 0);
});

test("lost write responses and invalid receipts stay uncertain; known rejects preserve safe codes", async () => {
	for (const fetcher of [
		async () => {
			throw new Error("lost");
		},
		async () => new Response("x".repeat(65537)),
		async () => new Response("bad json"),
		async () =>
			Response.json({
				success: true,
				data: { ...receipt, status: "proposed" },
			}),
		async () =>
			Response.json({
				success: true,
				data: { ...receipt, article: { ...article, content: "other" } },
			}),
	]) {
		const adapter = new RehoboamV16Adapter(fetcher, "gateway");
		await assert.rejects(
			adapter.execute({ action: submit, credential, input: data }),
			{ submissionUncertain: true },
		);
	}
	const adapter = new RehoboamV16Adapter(
		async () =>
			Response.json(
				{
					success: false,
					error: {
						code: "HELP_VERSION_CHANGED",
						submission_outcome: "rejected",
					},
				},
				{ status: 409 },
			),
		"gateway",
	);
	await assert.rejects(
		adapter.execute({ action: submit, credential, input: data }),
		{
			providerStatus: 409,
			providerCode: "HELP_VERSION_CHANGED",
			providerSubmissionOutcome: "rejected",
		},
	);
});

test("re-versioned old cancellation still delegates through immutable implementation", async () => {
	const row = {
		release_system: "channel_publishing",
		task_id: "a".repeat(24),
		status: "CANCELLED",
		cancellation: { actor: "owner", at: 123 },
	};
	const adapter = new RehoboamV16Adapter(
		async () => Response.json(row),
		"gateway",
	);
	assert.deepEqual(
		await adapter.execute({
			action: "rehoboam.cancel_channel_publish_request",
			credential,
			input: {
				releaseSystem: "channel_publishing",
				taskId: row.task_id,
				idempotencyKey: "key",
			},
			actionVersionId: "rehoboam.cancel_channel_publish_request@v16",
			providerReleaseId: adapter.providerReleaseId,
		}),
		row,
	);
});

test("gateway redirects never imply personal credential failure, and reads validate identity/version", async () => {
	const redirect = new RehoboamV16Adapter(
		async () =>
			new Response(null, {
				status: 302,
				headers: { location: "https://login.example.com" },
			}),
		"gateway",
	);
	await assert.rejects(
		redirect.execute({ action: submit, credential, input: data }),
		(error: {
			providerCode?: string;
			providerCredentialInvalid?: boolean;
			submissionUncertain?: boolean;
		}) => {
			assert.equal(error.providerCode, "GATEWAY_REDIRECT");
			assert.notEqual(error.providerCredentialInvalid, true);
			assert.equal(error.submissionUncertain, true);
			return true;
		},
	);
	for (const wrong of [
		{ content_hash: data.contentHash, article: { id: "other" } },
		{ article: { id: "flow" } },
	]) {
		const adapter = new RehoboamV16Adapter(
			async () => Response.json({ success: true, data: wrong }),
			"gateway",
		);
		await assert.rejects(
			adapter.execute({
				action: "rehoboam.get_pipeline_help_article",
				credential,
				input: { articleId: "flow" },
			}),
			{ providerStatus: 502 },
		);
	}
});

test("status changes preserve current state and historical operation receipt", async () => {
	let request: RequestInit | undefined;
	let path = "";
	const result = {
		...receipt,
		revision: 3,
		operation_status: "withdrawn",
		operation_revision: 2,
		replayed: true,
	};
	const adapter = new RehoboamV16Adapter(async (url, init) => {
		request = init;
		path = String(url);
		return Response.json({ success: true, data: result });
	}, "gateway");
	assert.deepEqual(
		await adapter.execute({
			action: "rehoboam.set_pipeline_help_article_status",
			credential,
			input: {
				articleId: article.id,
				expectedRevision: 1,
				status: "withdrawn",
				idempotencyKey: "withdraw-key",
			},
		}),
		result,
	);
	assert.equal(
		path,
		"https://justinia.gz3.agoralab.co/mcp/v1/pipeline-help/knowledge/" +
			article.id +
			"/status",
	);
	assert.deepEqual(JSON.parse(String(request?.body)), {
		expected_revision: 1,
		status: "withdrawn",
	});
});
