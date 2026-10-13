import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { rehoboamV16ConnectionCatalog } from "./rehoboam-v16.ts";
import {
	RehoboamV17Adapter,
	rehoboamV17ConnectionCatalog,
} from "./rehoboam-v17.ts";
import { rehoboamV17ExecutorDigest } from "./rehoboam-v17-integrity.ts";

const action = "rehoboam.update_pipeline_help_example";
const credential = { accessToken: "synthetic-pat" };
const fields = {
	title: "Title",
	category: "Category",
	scope: "Scope",
	text: "Opening",
	guidance: "Guidance",
	followup: "Follow-up",
	confirmation: "Confirmation",
	outcome: "Outcome",
};
const input = {
	articleId: "start",
	expectedRevision: 1,
	fields,
	idempotencyKey: "stable-key",
};
const receipt = {
	article: {
		id: "start",
		revision: 2,
		source: "database_example",
		example: { ...fields, key: "start", number: 4 },
	},
	operation_revision: 2,
	replayed: false,
};

test("v17 source identity is pinned and all old Action contracts remain intact", () => {
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
		"rehoboam-v17.ts",
	]) {
		hash
			.update(file)
			.update("\0")
			.update(readFileSync(new URL(file, import.meta.url)))
			.update("\0");
	}
	assert.equal(rehoboamV17ExecutorDigest, `sha256:${hash.digest("hex")}`);
	assert.equal(
		rehoboamV17ConnectionCatalog.actions.length,
		rehoboamV16ConnectionCatalog.actions.length + 1,
	);
	for (const old of rehoboamV16ConnectionCatalog.actions) {
		assert.deepEqual(
			rehoboamV17ConnectionCatalog.actions.find((row) => row.name === old.name),
			{ ...old, id: old.id.replace(/@v16$/, "@v17") },
		);
	}
});

test("fixed endpoint, normalized fields, auth and idempotency are forwarded once", async () => {
	let calls = 0;
	const adapter = new RehoboamV17Adapter(async (url, options) => {
		calls++;
		assert.equal(
			String(url),
			"https://justinia.gz3.agoralab.co/mcp/v1/pipeline-help/examples/start",
		);
		assert.equal(options?.method, "POST");
		assert.equal(options?.redirect, "manual");
		assert.deepEqual(JSON.parse(String(options?.body)), {
			expected_revision: 1,
			fields,
		});
		assert.equal(
			new Headers(options?.headers).get("Idempotency-Key"),
			input.idempotencyKey,
		);
		return Response.json({ success: true, data: receipt });
	}, "synthetic-gateway");
	assert.deepEqual(
		await adapter.execute({
			action,
			credential,
			input: { ...input, fields: { ...fields, title: " Title " } },
		}),
		receipt,
	);
	assert.equal(calls, 1);
});

test("malformed fields, selectors, path traversal and old grants never call the provider", async () => {
	let calls = 0;
	const adapter = new RehoboamV17Adapter(async () => {
		calls++;
		return Response.json({ success: true, data: receipt });
	}, "gateway");
	for (const invalid of [
		{ ...input, actor: "admin" },
		{ ...input, articleId: "../start" },
		{ ...input, fields: { ...fields, number: 5 } },
		{ ...input, fields: { ...fields, title: " " } },
	]) {
		await assert.rejects(
			adapter.execute({ action, credential, input: invalid }),
			{ providerSubmissionOutcome: "rejected" },
		);
	}
	await assert.rejects(
		adapter.execute({
			action,
			credential,
			input,
			providerReleaseId: "rehoboam-connection-v16",
			actionVersionId: `${action}@v16`,
		}),
		{ providerSubmissionOutcome: "rejected" },
	);
	assert.equal(calls, 0);
});

test("unknown responses never become deterministic rejection or automatic retry", async () => {
	for (const fetcher of [
		async () => {
			throw new Error("lost");
		},
		async () => Response.json({}),
		async () => Response.json({ success: false }),
		async () => new Response("x".repeat(65537)),
		async () =>
			Response.json({
				success: true,
				data: { ...receipt, operation_revision: 3 },
			}),
		async () =>
			Response.json({
				success: true,
				data: {
					...receipt,
					article: {
						...receipt.article,
						example: { ...receipt.article.example, title: "wrong" },
					},
				},
			}),
	]) {
		let calls = 0;
		const adapter = new RehoboamV17Adapter(async () => {
			calls++;
			return fetcher();
		}, "gateway");
		await assert.rejects(
			adapter.execute({ action, credential, input }),
			(error: {
				submissionUncertain?: boolean;
				providerSubmissionOutcome?: string;
			}) => {
				assert.equal(error.submissionUncertain, true);
				assert.equal(error.providerSubmissionOutcome, undefined);
				return true;
			},
		);
		assert.equal(calls, 1);
	}
});

test("deterministic rejects and current-state historical replay have distinct receipts", async () => {
	const rejected = new RehoboamV17Adapter(
		async () =>
			Response.json(
				{ success: false, error: { code: "HELP_REVISION_CHANGED" } },
				{ status: 409 },
			),
		"gateway",
	);
	await assert.rejects(rejected.execute({ action, credential, input }), {
		providerSubmissionOutcome: "rejected",
		providerCode: "HELP_REVISION_CHANGED",
	});
	const current = {
		...receipt,
		replayed: true,
		article: {
			...receipt.article,
			revision: 3,
			example: { ...receipt.article.example, title: "Later edit" },
		},
	};
	const adapter = new RehoboamV17Adapter(
		async () => Response.json({ success: true, data: current }),
		"gateway",
	);
	assert.deepEqual(
		await adapter.execute({ action, credential, input }),
		current,
	);
});

test("current and old read bindings both delegate to immutable v16", async () => {
	const result = { article: { id: "start" }, content_hash: "a".repeat(64) };
	const adapter = new RehoboamV17Adapter(
		async () => Response.json({ success: true, data: result }),
		"gateway",
	);
	for (const version of ["v16", "v17"]) {
		assert.deepEqual(
			await adapter.execute({
				action: "rehoboam.get_pipeline_help_article",
				credential,
				input: { articleId: "start" },
				providerReleaseId: `rehoboam-connection-${version}`,
				actionVersionId: `rehoboam.get_pipeline_help_article@${version}`,
			}),
			result,
		);
	}
});
