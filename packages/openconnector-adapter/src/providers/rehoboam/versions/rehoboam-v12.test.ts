import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { rehoboamV11ConnectionCatalog } from "./rehoboam-v11.ts";
import {
	RehoboamV12Adapter,
	rehoboamV12ConnectionCatalog,
	rehoboamV12LegacyProviderReleaseIds,
} from "./rehoboam-v12.ts";
import { rehoboamV12ExecutorDigest } from "./rehoboam-v12-integrity.ts";

test("v12 pins all executor dependencies and retains previous Actions and routing", () => {
	const hash = createHash("sha256");
	for (const file of [
		"rehoboam.ts",
		"rehoboam-management.ts",
		"rehoboam-v11.ts",
		"rehoboam-v12.ts",
	])
		hash
			.update(file)
			.update("\0")
			.update(readFileSync(new URL(file, import.meta.url)))
			.update("\0");
	assert.equal(rehoboamV12ExecutorDigest, `sha256:${hash.digest("hex")}`);
	assert.equal(rehoboamV12ConnectionCatalog.actions.length, 71);
	assert.equal(
		rehoboamV11ConnectionCatalog.providerReleaseId,
		"rehoboam-connection-v11",
	);
	assert.ok(
		rehoboamV12LegacyProviderReleaseIds.includes("rehoboam-connection-v11"),
	);
	for (const old of rehoboamV11ConnectionCatalog.actions) {
		const next = rehoboamV12ConnectionCatalog.actions.find(
			(action) => action.name === old.name,
		);
		assert.ok(next);
		assert.equal(next.id, old.id.replace(/@v11$/, "@v12"));
		assert.equal(next.effect, old.effect);
		assert.deepEqual(next.requiredScopes, old.requiredScopes);
		assert.deepEqual(next.inputSchema, old.inputSchema);
	}
	const anchor = rehoboamV12ConnectionCatalog.actions.at(-1);
	assert.equal(anchor?.effect, "READ");
	assert.deepEqual(anchor?.requiredScopes, ["rehoboam.release.read"]);
});

test("Native anchor uses the fixed origin and stored credentials and preserves backend facts", async () => {
	const facts = {
		release_id: "original",
		status: "completed",
		version: "4.7.0",
		suite: "weekly",
		reuse_completed_delivery: true,
		existing_family_id: "existing-family",
	};
	const requests: Array<{ url: string; method?: string; headers: Headers }> =
		[];
	const adapter = new RehoboamV12Adapter(async (url, init) => {
		requests.push({
			url: String(url),
			method: init?.method,
			headers: new Headers(init?.headers),
		});
		return Response.json({ data: facts });
	}, "machine-key");
	assert.deepEqual(
		await adapter.execute({
			action: "rehoboam.get_release_family_native_anchor",
			credential: { accessToken: "stored-pat" },
			input: { releaseId: "native/id" },
		}),
		facts,
	);
	assert.equal(
		requests[0]?.url,
		"https://justinia.gz3.agoralab.co/mcp/v1/release-families/native-anchors/native%2Fid",
	);
	assert.equal(requests[0]?.method, "GET");
	assert.equal(requests[0]?.headers.get("authorization"), "Bearer stored-pat");
	assert.equal(requests[0]?.headers.get("apiKey"), "machine-key");
});

test("invalid dot segments and identity selectors never send a provider request", async () => {
	let requests = 0;
	const adapter = new RehoboamV12Adapter(async () => {
		requests++;
		return Response.json({ data: {} });
	}, "machine-key");
	for (const input of [
		{ releaseId: "." },
		{ releaseId: ".." },
		{ releaseId: "native", actor: "admin" },
		{ releaseId: "native", url: "https://other.invalid" },
	])
		await assert.rejects(
			adapter.execute({
				action: "rehoboam.get_release_family_native_anchor",
				credential: { accessToken: "stored-pat" },
				input,
			}),
			/Invalid Native/,
		);
	assert.equal(requests, 0);
});

test("family status, initialization and restore remain delegated to the existing contract", async () => {
	const requests: string[] = [];
	const adapter = new RehoboamV12Adapter(async (url) => {
		requests.push(String(url));
		return Response.json({
			data: { inherited_delivery: { release_id: "original" } },
		});
	}, "machine-key");
	for (const [action, input] of [
		["rehoboam.get_release_family", { familyId: "family" }],
		[
			"rehoboam.initialize_release_family_plans",
			{ familyId: "family", expectedRevision: 1, templateSignatures: {} },
		],
		[
			"rehoboam.restore_release_family_task",
			{
				familyId: "family",
				memberId: "native",
				taskId: "build",
				expectedRevision: 2,
				templateSignature: "sig",
			},
		],
	] as const) {
		assert.deepEqual(
			await adapter.execute({
				action,
				input,
				credential: { accessToken: "stored-pat" },
			}),
			{ inherited_delivery: { release_id: "original" } },
		);
	}
	assert.ok(requests[1]?.endsWith("/family/plans"));
	assert.ok(
		requests[2]?.endsWith("/family/members/native/tasks/build/restore"),
	);
});

test("business errors retain the original family link and permission meaning", async () => {
	const adapter = new RehoboamV12Adapter(
		async () =>
			Response.json(
				{
					error: {
						code: "native_template_invalid",
						message: "请选择 Native",
						details: { existing_family_id: "existing" },
					},
				},
				{ status: 409 },
			),
		"machine-key",
	);
	await assert.rejects(
		adapter.execute({
			action: "rehoboam.get_release_family_native_anchor",
			input: { releaseId: "id" },
			credential: { accessToken: "stored-pat" },
		}),
		(error: Error & { providerCode?: string; providerDetails?: unknown }) => {
			assert.equal(error.providerCode, "native_template_invalid");
			assert.deepEqual(error.providerDetails, {
				existing_family_id: "existing",
			});
			return true;
		},
	);
});
