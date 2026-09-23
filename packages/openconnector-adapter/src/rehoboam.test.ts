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

test("Rehoboam catalog exposes one bounded read action", () => {
	assert.deepEqual(
		rehoboamConnectionCatalog.actions.map((action) => action.id),
		["rehoboam.get_current_user@v3"],
	);
	assert.equal(rehoboamConnectionCatalog.actions[0]?.effect, "READ");
});

test("Rehoboam validates a scoped personal access token", async () => {
	let request: { headers: Headers; url: string } | undefined;
	const adapter = new RehoboamAdapter(async (input, init) => {
		request = { headers: new Headers(init?.headers), url: String(input) };
		return Response.json({
			data: {
				role: "operator",
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
	assert.deepEqual(identity.grantedScopes, ["rehoboam.metadata.read"]);
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
		user_id: "user-1",
		username: "user@example.com",
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
