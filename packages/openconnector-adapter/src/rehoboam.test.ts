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
		["rehoboam.get_current_user@v1"],
	);
	assert.equal(rehoboamConnectionCatalog.actions[0]?.effect, "READ");
});

test("Rehoboam sends machine apiKey with personal Bearer token", async () => {
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

	const identity = await adapter.validateCredential("personal-token");

	assert.equal(
		request?.url,
		"https://justinia.gz3.agoralab.co/api/connection/whoami",
	);
	assert.equal(request?.headers.get("apikey"), "machine-key");
	assert.equal(request?.headers.get("authorization"), "Bearer personal-token");
	assert.equal(identity.externalAccount, "user-1");
	assert.equal(identity.displayName, "user@example.com");
	assert.equal(JSON.stringify(identity).includes("machine-key"), false);
	assert.equal(JSON.stringify(identity).includes("personal-token"), true);
});

test("Rehoboam rejects redirects and invalid personal credentials", async () => {
	for (const response of [
		new Response(null, {
			headers: { location: "https://oauth.example" },
			status: 302,
		}),
		new Response(null, { status: 401 }),
	]) {
		const adapter = new RehoboamAdapter(async () => response, "machine-key");
		await assert.rejects(
			adapter.validateCredential("personal-token"),
			(error: Error & { providerCredentialInvalid?: boolean }) =>
				error.providerCredentialInvalid === true,
		);
	}
});
