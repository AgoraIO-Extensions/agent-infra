import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { rehoboamV12ConnectionCatalog } from "./rehoboam-v12.ts";
import {
	channelPublishingActions,
	RehoboamV13Adapter,
	rehoboamV13ConnectionCatalog,
	rehoboamV13LegacyProviderReleaseIds,
} from "./rehoboam-v13.ts";
import { rehoboamV13ExecutorDigest } from "./rehoboam-v13-integrity.ts";

const task = "a".repeat(24);
const credential = { accessToken: "stored-pat" };
const approval = {
	releaseSystem: "channel_publishing",
	taskId: task,
	comment: "checked",
	idempotencyKey: "approval-1",
};

test("v13 preserves old contracts and isolates all new scopes and systems", () => {
	const hash = createHash("sha256");
	for (const file of [
		"rehoboam.ts",
		"rehoboam-management.ts",
		"rehoboam-v11.ts",
		"rehoboam-v12.ts",
		"rehoboam-v13.ts",
	])
		hash
			.update(file)
			.update("\0")
			.update(readFileSync(new URL(file, import.meta.url)))
			.update("\0");
	assert.equal(rehoboamV13ExecutorDigest, `sha256:${hash.digest("hex")}`);
	assert.equal(
		rehoboamV13ConnectionCatalog.actions.length,
		rehoboamV12ConnectionCatalog.actions.length + 6,
	);
	assert.ok(
		rehoboamV13LegacyProviderReleaseIds.includes("rehoboam-connection-v12"),
	);
	for (const old of rehoboamV12ConnectionCatalog.actions) {
		const next = rehoboamV13ConnectionCatalog.actions.find(
			(item) => item.name === old.name,
		);
		assert.ok(next);
		assert.deepEqual(next.inputSchema, old.inputSchema);
		assert.deepEqual(next.requiredScopes, old.requiredScopes);
		assert.equal(next.effect, old.effect);
		assert.equal(next.id, old.id.replace(/@v12$/, "@v13"));
	}
	for (const action of channelPublishingActions) {
		assert.ok(action.description.includes("不属于 Pipeline Center"));
		assert.ok(action.description.includes("先 READ list_releases"));
		assert.ok(action.description.includes("不自动回退"));
		if (action.effect === "WRITE")
			assert.ok(action.inputSchema.required.includes("idempotencyKey"));
	}
	assert.deepEqual(channelPublishingActions.at(-1)?.requiredScopes, [
		"rehoboam.publishing.approve",
	]);
});

test("credential scopes come only from the PAT identity proof", async () => {
	for (const scopes of [
		["release:write"],
		["publishing:write"],
		["publishing:approve"],
	]) {
		const adapter = new RehoboamV13Adapter(
			async () =>
				Response.json({
					data: { user_id: "owner", username: "owner", scopes },
				}),
			"gateway",
		);
		const result = await adapter.validateCredential("stored-pat");
		assert.equal(
			result.grantedScopes.includes("rehoboam.publishing.approve"),
			scopes.includes("publishing:approve"),
		);
		assert.equal(
			result.grantedScopes.includes("rehoboam.publishing.write"),
			scopes.includes("publishing:write"),
		);
		assert.equal(
			result.grantedScopes.includes("rehoboam.publishing.read"),
			scopes[0]?.startsWith("publishing:"),
		);
	}
});

test("application and approval use fixed paths, actual credential and stable idempotency key", async () => {
	const sent: { url: string; init?: RequestInit }[] = [];
	const adapter = new RehoboamV13Adapter(async (url, init) => {
		sent.push({ url: String(url), init });
		return Response.json({
			release_system: "channel_publishing",
			task_id: task,
			status: "APPROVED",
		});
	}, "gateway");
	for (const action of [
		"rehoboam.approve_channel_publish_request",
		"rehoboam.reject_channel_publish_request",
	])
		await adapter.execute({ action, credential, input: approval });
	assert.equal(
		sent[0]?.url,
		`https://justinia.gz3.agoralab.co/api/v1/channel-publishing/requests/${task}/approval`,
	);
	assert.equal(
		new Headers(sent[0]?.init?.headers).get("authorization"),
		"Bearer stored-pat",
	);
	assert.equal(
		new Headers(sent[0]?.init?.headers).get("Idempotency-Key"),
		"approval-1",
	);
	assert.deepEqual(JSON.parse(String(sent[0]?.init?.body)), {
		release_system: "channel_publishing",
		decision: "APPROVED",
		comment: "checked",
	});
	assert.equal(JSON.parse(String(sent[1]?.init?.body)).decision, "REJECTED");
	assert.equal(sent[0]?.init?.redirect, "manual");
});

test("system guessing, credentials, identity selectors and path injection fail before fetching", async () => {
	let calls = 0;
	const adapter = new RehoboamV13Adapter(async () => {
		calls++;
		return Response.json({});
	}, "gateway");
	for (const input of [
		{ ...approval, releaseSystem: "pipeline_center" },
		{ ...approval, auditor: "other" },
		{ ...approval, url: "https://other" },
		{ ...approval, taskId: "../x" },
		{ ...approval, idempotencyKey: "" },
		{ taskId: task, idempotencyKey: "key" },
	]) {
		await assert.rejects(
			adapter.execute({
				action: "rehoboam.approve_channel_publish_request",
				credential,
				input,
			}),
		);
	}
	assert.equal(calls, 0);
});

test("WRITE transport/5xx/invalid-success failures are uncertain and never auto-retried", async () => {
	for (const response of [
		null,
		Response.json({ error: { code: "UNAVAILABLE" } }, { status: 503 }),
		new Response("not-json"),
		Response.json({ release_system: "pipeline_center" }),
	]) {
		let calls = 0;
		const adapter = new RehoboamV13Adapter(async () => {
			calls++;
			if (!response) throw new Error("timeout with sensitive data");
			return response;
		}, "gateway");
		await assert.rejects(
			adapter.execute({
				action: "rehoboam.approve_channel_publish_request",
				credential,
				input: approval,
			}),
			(error: unknown) =>
				error instanceof Error &&
				"submissionUncertain" in error &&
				error.submissionUncertain === true &&
				!error.message.includes("sensitive"),
		);
		assert.equal(calls, 1);
	}
});

test("READ result polling and business conflict remain distinct from credential failure", async () => {
	const adapter = new RehoboamV13Adapter(
		async () =>
			Response.json(
				{ error: { code: "APPROVAL_STATE_CONFLICT" } },
				{ status: 409 },
			),
		"gateway",
	);
	await assert.rejects(
		adapter.execute({
			action: "rehoboam.approve_channel_publish_request",
			credential,
			input: approval,
		}),
		(error: unknown) =>
			error instanceof Error &&
			"providerCode" in error &&
			error.providerCode === "APPROVAL_STATE_CONFLICT" &&
			!("providerCredentialInvalid" in error),
	);
	const reader = new RehoboamV13Adapter(async (url) => {
		assert.equal(
			String(url),
			`https://justinia.gz3.agoralab.co/api/v1/channel-publishing/requests/${task}`,
		);
		return Response.json({
			release_system: "channel_publishing",
			task_id: task,
			status: "RUNNING",
		});
	}, "gateway");
	assert.equal(
		(
			(await reader.execute({
				action: "rehoboam.get_channel_publish_request",
				credential,
				input: { taskId: task },
			})) as Record<string, unknown>
		).status,
		"RUNNING",
	);
});

const createInput = {
	releaseSystem: "channel_publishing",
	channel: "cdn",
	idempotencyKey: "create-1",
	schemaRevision: "f".repeat(64),
	params: { NEW_JOB_OPTION: 3 },
};
const liveSchema = {
	type: "object",
	additionalProperties: false,
	required: ["NEW_JOB_OPTION"],
	properties: { NEW_JOB_OPTION: { type: "integer", minimum: 1, maximum: 5 } },
};
const schemaRevision = "f".repeat(64);

test("new job fields and types are discovered from Rehoboam without an adapter field list", async () => {
	const sent: { url: string; init?: RequestInit }[] = [];
	const adapter = new RehoboamV13Adapter(async (url, init) => {
		sent.push({ url: String(url), init });
		return init?.method === "GET"
			? Response.json({
					release_system: "channel_publishing",
					channel: "cdn",
					params_schema: liveSchema,
					schema_revision: schemaRevision,
				})
			: Response.json({ release_system: "channel_publishing", task_id: task });
	}, "gateway");
	await adapter.execute({
		action: "rehoboam.create_channel_publish_request",
		credential,
		input: createInput,
	});
	assert.equal(
		sent[0]?.url,
		"https://justinia.gz3.agoralab.co/api/v1/channel-publishing/options/cdn",
	);
	assert.equal(
		sent[1]?.url,
		"https://justinia.gz3.agoralab.co/api/v1/channel-publishing/requests",
	);
	const body = JSON.parse(String(sent[1]?.init?.body));
	assert.deepEqual(body.params, { NEW_JOB_OPTION: 3 });
	assert.equal(body.schema_revision, schemaRevision);
	assert.equal(
		new Headers(sent[1]?.init?.headers).get("Idempotency-Key"),
		"create-1",
	);
	assert.equal(
		new Headers(sent[0]?.init?.headers).get("authorization"),
		"Bearer stored-pat",
	);
});

test("current required/type/range rules and unapproved fields are rejected before POST", async () => {
	for (const params of [
		{},
		{ NEW_JOB_OPTION: "3" },
		{ NEW_JOB_OPTION: 9 },
		{ NEW_JOB_OPTION: 3, extra_args: "unsafe" },
	]) {
		const methods: (string | undefined)[] = [];
		const adapter = new RehoboamV13Adapter(async (_url, init) => {
			methods.push(init?.method);
			return Response.json({
				release_system: "channel_publishing",
				channel: "cdn",
				params_schema: liveSchema,
				schema_revision: schemaRevision,
			});
		}, "gateway");
		await assert.rejects(
			adapter.execute({
				action: "rehoboam.create_channel_publish_request",
				credential,
				input: { ...createInput, params },
			}),
			(error: unknown) =>
				error instanceof Error &&
				"providerSubmissionOutcome" in error &&
				error.providerSubmissionOutcome === "rejected",
		);
		assert.deepEqual(methods, ["GET"]);
	}
});

test("schema read failures and invalid schemas never submit or become uncertain business writes", async () => {
	for (const response of [
		null,
		Response.json({ error: { code: "UNAVAILABLE" } }, { status: 503 }),
		Response.json({
			release_system: "pipeline_center",
			channel: "cdn",
			params_schema: liveSchema,
			schema_revision: schemaRevision,
		}),
		Response.json({
			release_system: "channel_publishing",
			channel: "maven",
			params_schema: liveSchema,
			schema_revision: schemaRevision,
		}),
		Response.json({
			release_system: "channel_publishing",
			channel: "cdn",
			params_schema: { type: "object", additionalProperties: true },
			schema_revision: schemaRevision,
		}),
	]) {
		let posts = 0;
		const adapter = new RehoboamV13Adapter(async (_url, init) => {
			if (init?.method === "POST") posts++;
			if (!response) throw new Error("timeout with secret");
			return response;
		}, "gateway");
		await assert.rejects(
			adapter.execute({
				action: "rehoboam.create_channel_publish_request",
				credential,
				input: createInput,
			}),
			(error: unknown) =>
				error instanceof Error &&
				"providerSubmissionOutcome" in error &&
				error.providerSubmissionOutcome === "rejected" &&
				!("submissionUncertain" in error),
		);
		assert.equal(posts, 0);
	}
});

test("each creation re-reads current schema and preserves server schema-change rejection", async () => {
	let reads = 0;
	let posts = 0;
	const adapter = new RehoboamV13Adapter(async (_url, init) => {
		if (init?.method === "GET") {
			reads++;
			return Response.json({
				release_system: "channel_publishing",
				channel: "cdn",
				params_schema: liveSchema,
				schema_revision: schemaRevision,
			});
		}
		posts++;
		return Response.json(
			{ error: { code: "PARAMETER_SCHEMA_CHANGED" } },
			{ status: 409 },
		);
	}, "gateway");
	for (let index = 0; index < 2; index++) {
		await assert.rejects(
			adapter.execute({
				action: "rehoboam.create_channel_publish_request",
				credential,
				input: { ...createInput, idempotencyKey: `create-${index}` },
			}),
			(error: unknown) =>
				error instanceof Error &&
				"providerCode" in error &&
				error.providerCode === "PARAMETER_SCHEMA_CHANGED",
		);
	}
	assert.equal(reads, 2);
	assert.equal(posts, 2);
});

test("schema changes after client discovery are rejected before POST", async () => {
	let posts = 0;
	const adapter = new RehoboamV13Adapter(async (_url, init) => {
		if (init?.method === "POST") posts++;
		return Response.json({
			release_system: "channel_publishing",
			channel: "cdn",
			params_schema: liveSchema,
			schema_revision: "a".repeat(64),
		});
	}, "gateway");
	await assert.rejects(
		adapter.execute({
			action: "rehoboam.create_channel_publish_request",
			credential,
			input: createInput,
		}),
		(error: unknown) =>
			error instanceof Error &&
			"providerCode" in error &&
			error.providerCode === "PARAMETER_SCHEMA_CHANGED",
	);
	assert.equal(posts, 0);
});
