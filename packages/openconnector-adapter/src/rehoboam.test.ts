import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { RehoboamAdapter, rehoboamConnectionCatalog } from "./rehoboam.ts";
import { rehoboamExecutorDigest } from "./rehoboam-integrity.ts";

test("Rehoboam executor digest pins its reviewed source", () => {
	const digest = createHash("sha256")
		.update(readFileSync(new URL("./rehoboam.ts", import.meta.url)))
		.digest("hex");
	assert.equal(rehoboamExecutorDigest, `sha256:${digest}`);
});

test("Rehoboam catalog exposes bounded release workflow actions", () => {
	assert.deepEqual(
		rehoboamConnectionCatalog.actions.map((action) => action.id),
		[
			"rehoboam.get_current_user@v5",
			"rehoboam.list_releases@v2",
			"rehoboam.get_release@v2",
			"rehoboam.list_release_pipelines@v2",
			"rehoboam.get_release_pipeline@v2",
			"rehoboam.prepare_release_pipeline_run@v2",
			"rehoboam.execute_release_pipeline@v2",
			"rehoboam.list_execution_requests@v2",
			"rehoboam.get_execution_request@v2",
			"rehoboam.approve_execution_request@v2",
			"rehoboam.withdraw_execution_request@v2",
			"rehoboam.reject_execution_request@v2",
			"rehoboam.list_release_pipeline_runs@v2",
			"rehoboam.get_release_pipeline_run@v2",
		],
	);
	assert.equal(rehoboamConnectionCatalog.actions[0]?.effect, "READ");
	assert.equal(
		rehoboamConnectionCatalog.actions.find(
			(action) => action.name === "rehoboam.execute_release_pipeline",
		)?.effect,
		"WRITE",
	);
});

test("Rehoboam validates a scoped personal access token", async () => {
	let request: { headers: Headers; url: string } | undefined;
	const adapter = new RehoboamAdapter(async (input, init) => {
		request = { headers: new Headers(init?.headers), url: String(input) };
		return Response.json({
			data: {
				role: "operator",
				scopes: ["metadata:read", "release:write"],
				user_id: "user-1",
				username: "user@example.com",
			},
			success: true,
		});
	}, "machine-key");

	const identity = await adapter.validateCredential("personal-pat");

	assert.equal(
		request?.url,
		"https://justinia.gz3.agoralab.co/api/connection/whoami",
	);
	assert.equal(request?.headers.get("apikey"), "machine-key");
	assert.equal(request?.headers.get("authorization"), "Bearer personal-pat");
	assert.equal(identity.externalAccount, "user-1");
	assert.equal(identity.displayName, "user@example.com");
	assert.equal(identity.accessToken, "personal-pat");
	assert.deepEqual(identity.grantedScopes, [
		"rehoboam.metadata.read",
		"rehoboam.release.read",
		"rehoboam.release.write",
	]);
	assert.equal(JSON.stringify(identity).includes("machine-key"), false);
});

test("Rehoboam execution sends the stored personal token", async () => {
	let authorization: string | null = null;
	const adapter = new RehoboamAdapter(async (_input, init) => {
		authorization = new Headers(init?.headers).get("authorization");
		return Response.json({
			data: {
				role: "operator",
				user_id: "user-1",
				username: "user@example.com",
			},
			success: true,
		});
	}, "machine-key");

	const result = await adapter.execute({
		action: "rehoboam.get_current_user",
		credential: { accessToken: "stored-token" },
		input: {},
	});

	assert.equal(authorization, "Bearer stored-token");
	assert.deepEqual(result, {
		role: "operator",
		scopes: [],
		user_id: "user-1",
		username: "user@example.com",
	});
});

test("Rehoboam maps release reads and writes to fixed endpoints", async () => {
	const requests: Array<{ body?: string; method?: string; url: string }> = [];
	const adapter = new RehoboamAdapter(async (input, init) => {
		requests.push({
			body: init?.body as string | undefined,
			method: init?.method,
			url: String(input),
		});
		return Response.json({ data: { ok: true }, success: true });
	}, "machine-key");
	const credential = { accessToken: "stored-token" };

	await adapter.execute({
		action: "rehoboam.list_release_pipelines",
		credential,
		input: { releaseId: "rel/1" },
	});
	await adapter.execute({
		action: "rehoboam.execute_release_pipeline",
		credential,
		input: { cardId: "card-1", params: { env: "prod" }, releaseId: "rel-1" },
	});
	await adapter.execute({
		action: "rehoboam.reject_execution_request",
		credential,
		input: { reason: "not ready", releaseId: "rel-1", requestId: "req-1" },
	});

	assert.equal(
		requests[0]?.url,
		"https://justinia.gz3.agoralab.co/mcp/v1/releases/rel%2F1/pipelines",
	);
	assert.equal(
		requests[1]?.url,
		"https://justinia.gz3.agoralab.co/mcp/v1/releases/rel-1/pipeline-runs",
	);
	assert.equal(requests[1]?.method, "POST");
	assert.deepEqual(JSON.parse(requests[1]?.body ?? "{}"), {
		card_id: "card-1",
		params: { env: "prod" },
	});
	assert.deepEqual(JSON.parse(requests[2]?.body ?? "{}"), {
		reject_reason: "not ready",
		release_id: "rel-1",
	});
});

test("Rehoboam rejects redirects and invalid PATs", async () => {
	for (const response of [
		new Response(null, {
			headers: { location: "https://oauth.example" },
			status: 302,
		}),
		new Response(null, { status: 401 }),
	]) {
		const adapter = new RehoboamAdapter(async () => response, "machine-key");
		await assert.rejects(
			adapter.validateCredential("personal-pat"),
			(error: Error & { providerCredentialInvalid?: boolean }) =>
				error.providerCredentialInvalid === true,
		);
	}
});

test("Rehoboam preserves the bounded MCP error contract", async () => {
	const adapter = new RehoboamAdapter(
		async () =>
			Response.json(
				{
					data: null,
					error: {
						code: "PIPELINE_REF_NOT_FOUND",
						details: { ref: "missing", workflow: "build.yml" },
						message: "GitHub ref does not exist: missing",
						retryable: false,
						submission_outcome: "rejected",
					},
					success: false,
				},
				{ status: 400 },
			),
		"machine-key",
	);

	await assert.rejects(
		adapter.execute({
			action: "rehoboam.execute_release_pipeline",
			credential: { accessToken: "stored-token" },
			input: { cardId: "card-1", releaseId: "rel-1" },
		}),
		(error: Error & Record<string, unknown>) =>
			error.providerCode === "PIPELINE_REF_NOT_FOUND" &&
			error.providerMessage === "GitHub ref does not exist: missing" &&
			error.providerStatus === 400 &&
			error.providerSubmissionOutcome === "rejected" &&
			error.providerRetryable === false &&
			error.submissionUncertain !== true &&
			JSON.stringify(error.providerDetails) ===
				JSON.stringify({ ref: "missing", workflow: "build.yml" }),
	);
});
