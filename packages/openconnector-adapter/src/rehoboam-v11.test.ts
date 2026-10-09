import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { rehoboamConnectionCatalog } from "./rehoboam.ts";
import {
	managementRequest,
	rehoboamManagementActions,
} from "./rehoboam-management.ts";
import {
	RehoboamV11Adapter,
	rehoboamV11ConnectionCatalog,
	rehoboamV11LegacyProviderReleaseIds,
} from "./rehoboam-v11.ts";
import { rehoboamV11ExecutorDigest } from "./rehoboam-v11-integrity.ts";

test("v11 pins all reviewed sources and leaves immutable v10 unchanged", () => {
	const hash = createHash("sha256");
	for (const file of [
		"rehoboam.ts",
		"rehoboam-management.ts",
		"rehoboam-v11.ts",
	])
		hash
			.update(file)
			.update("\0")
			.update(readFileSync(new URL(file, import.meta.url)))
			.update("\0");
	assert.equal(rehoboamV11ExecutorDigest, `sha256:${hash.digest("hex")}`);
	assert.equal(
		rehoboamConnectionCatalog.providerReleaseId,
		"rehoboam-connection-v10",
	);
	assert.equal(
		rehoboamConnectionCatalog.executorDigest,
		"sha256:bbcc3a4812ebe77db72d91d0c26c4b7bb506329848190ee376724c4b5742ea45",
	);
	assert.equal(rehoboamManagementActions.length, 28);
	assert.equal(rehoboamV11ConnectionCatalog.actions.length, 70);
	assert.equal(
		new Set(rehoboamV11ConnectionCatalog.actions.map((action) => action.name))
			.size,
		70,
	);
	assert.ok(
		rehoboamV11LegacyProviderReleaseIds.includes("rehoboam-connection-v10"),
	);
	for (const action of rehoboamConnectionCatalog.actions) {
		const inherited = rehoboamV11ConnectionCatalog.actions.find(
			(item) => item.name === action.name,
		);
		assert.deepEqual(inherited, {
			...action,
			id: action.id.replace(/@v10$/, "@v11"),
		});
	}
	for (const action of rehoboamManagementActions) {
		assert.ok(
			!rehoboamConnectionCatalog.actions.some(
				(item) => item.name === action.name,
			),
		);
		assert.equal(action.inputSchema.additionalProperties, false);
		assert.ok(
			!(
				action.inputSchema.properties &&
				typeof action.inputSchema.properties === "object" &&
				"username" in action.inputSchema.properties
			),
		);
		if (action.effect === "WRITE")
			assert.ok(action.inputSchema.required?.includes("idempotencyKey"));
	}
});

test("all management Actions route to fixed resource paths without caller identity or idempotency keys", async () => {
	const requests: Array<{
		url: string;
		method: string;
		body: unknown;
		headers: Headers;
	}> = [];
	const adapter = new RehoboamV11Adapter(async (url, init) => {
		requests.push({
			url: String(url),
			method: init?.method || "GET",
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
			headers: new Headers(init?.headers),
		});
		return Response.json({ success: true, data: { ok: true } });
	}, "machine-key");
	const input = {
		releaseId: "release",
		templateId: "template",
		pipelineId: "pipeline",
		requestId: "request",
		customerConfigId: "customer",
		markerConfigId: "marker",
		previewId: "preview",
		confirmationToken: "opaque-token",
		changes: {
			title: "【RN RTM】2.3.1",
			version: "2.3.1",
			target_branch: "dev/2.3.1",
		},
		configuration: {
			name: "RN RTM",
			main_repo_url:
				"https://github.com/AgoraIO-Extensions/agora-react-native-rtm",
		},
		idempotencyKey: "client-key",
		username: "forged",
		token: "forged",
		url: "https://evil.example",
	};
	for (const action of rehoboamManagementActions) {
		await adapter.execute({
			action: action.name,
			credential: { accessToken: "stored-provider-token" },
			input,
		});
		const request = requests.at(-1);
		assert.ok(request);
		assert.equal(
			new URL(request.url).origin,
			"https://justinia.gz3.agoralab.co",
		);
		assert.equal(request.method, action.effect === "WRITE" ? "POST" : "GET");
		assert.equal(
			request.headers.get("authorization"),
			"Bearer stored-provider-token",
		);
		assert.equal(request.headers.get("apiKey"), "machine-key");
		assert.ok(!JSON.stringify(request.body ?? {}).includes("forged"));
		assert.ok(!JSON.stringify(request.body ?? {}).includes("client-key"));
		if (action.name.startsWith("rehoboam.preview_"))
			assert.deepEqual(
				request.body,
				action.name.endsWith("_release") ||
					action.name.endsWith("_execution_request")
					? input.changes
					: input.configuration,
			);
		else if (action.effect === "WRITE")
			assert.deepEqual(request.body, {
				preview_id: "preview",
				confirmation_token: "opaque-token",
			});
	}
});

test("original RN RTM editing and history-copy paths bind exact selected release", () => {
	const input = {
		releaseId: "6ac8d518fb86ac0917bcff14",
		changes: {
			title: "【RN RTM】2.3.1",
			version: "2.3.1",
			target_branch: "dev/2.3.1",
		},
	};
	const request = managementRequest("rehoboam.preview_update_release", input);
	assert.equal(
		request.path,
		"/mcp/v1/releases/6ac8d518fb86ac0917bcff14/connection-update-preview",
	);
	assert.deepEqual(JSON.parse(String(request.init.body)), input.changes);
	assert.equal(
		managementRequest("rehoboam.copy_release", { releaseId: input.releaseId })
			.path,
		"/mcp/v1/releases/6ac8d518fb86ac0917bcff14/connection-copy-confirm",
	);
});

test("dot segments and path separators reject before network; query filters are encoded", () => {
	for (const releaseId of [".", "..", "a/b", "a\\b", " whitespace"])
		assert.throws(
			() => managementRequest("rehoboam.preview_update_release", { releaseId }),
			/Invalid management resource/,
		);
	assert.equal(
		managementRequest("rehoboam.list_customer_configs", {
			name: "a&b",
			pageSize: 20,
			vid: "001",
		}).path,
		"/mcp/v1/customer-config-definitions?page_size=20&name=a%26b&vid=001",
	);
});

test("old actions delegate to v10; credential upgrade preserves identity and scopes", async () => {
	const paths: string[] = [];
	const adapter = new RehoboamV11Adapter(async (url) => {
		paths.push(String(url));
		return Response.json({
			success: true,
			data: {
				user_id: "owner",
				username: "owner@example.invalid",
				role: "admin",
				scopes: ["metadata:read", "release:write"],
			},
		});
	}, "machine-key");
	const credential = await adapter.validateCredential("stored-token");
	assert.equal(credential.providerReleaseId, "rehoboam-connection-v11");
	assert.equal(credential.externalAccount, "owner");
	assert.deepEqual(credential.grantedScopes, [
		"rehoboam.metadata.read",
		"rehoboam.release.read",
		"rehoboam.release.write",
	]);
	await adapter.execute({
		action: "rehoboam.get_release",
		credential: { accessToken: "stored-token" },
		input: { releaseId: "release" },
	});
	assert.equal(
		new URL(paths.at(-1) || "").pathname,
		"/mcp/v1/releases/release/connection-summary",
	);
});

test("partial management submissions retain uncertainty without exposing raw provider response", async () => {
	const adapter = new RehoboamV11Adapter(
		async () =>
			Response.json(
				{
					success: false,
					error: {
						code: "MANAGEMENT_RESULT_UNCERTAIN",
						message: "结果待核对",
						submission_outcome: "uncertain",
						retryable: false,
						private_body: "private-provider-payload",
					},
				},
				{ status: 400 },
			),
		"machine-key",
	);
	await assert.rejects(
		adapter.execute({
			action: "rehoboam.update_release",
			credential: { accessToken: "stored-token" },
			input: {
				releaseId: "release",
				previewId: "p",
				confirmationToken: "token",
			},
		}),
		(error: unknown) => {
			assert.equal(
				(error as { submissionUncertain: boolean }).submissionUncertain,
				true,
			);
			assert.equal(
				(error as { providerCode: string }).providerCode,
				"MANAGEMENT_RESULT_UNCERTAIN",
			);
			assert.ok(!JSON.stringify(error).includes("private-provider-payload"));
			return true;
		},
	);
});

test("oversized and invalid response payloads fail closed", async () => {
	for (const raw of [
		"x".repeat(65537),
		"not JSON",
		"null",
		"[]",
		'{"success":true}',
	]) {
		const adapter = new RehoboamV11Adapter(
			async () => new Response(raw),
			"machine-key",
		);
		await assert.rejects(
			adapter.execute({
				action: "rehoboam.get_release_operation",
				credential: { accessToken: "stored-token" },
				input: { previewId: "p" },
			}),
		);
	}
});
