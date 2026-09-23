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
		["rehoboam.get_current_user@v2"],
	);
	assert.equal(rehoboamConnectionCatalog.actions[0]?.effect, "READ");
});

test("Rehoboam exchanges login credentials and stores only the returned token", async () => {
	const requests: Array<{
		body?: BodyInit | null;
		headers: Headers;
		url: string;
	}> = [];
	const adapter = new RehoboamAdapter(async (input, init) => {
		requests.push({
			body: init?.body,
			headers: new Headers(init?.headers),
			url: String(input),
		});
		if (String(input).endsWith("/mcp/v1/auth/login")) {
			return Response.json({ data: { token: "issued-token" }, success: true });
		}
		return Response.json({
			data: {
				role: "operator",
				user_id: "user-1",
				username: "user@example.com",
			},
			success: true,
		});
	}, "machine-key");

	const identity = await adapter.validateCredential(
		JSON.stringify({
			password: "personal-password",
			username: "user@example.com",
		}),
	);

	assert.equal(
		requests[0]?.url,
		"https://justinia.gz3.agoralab.co/mcp/v1/auth/login",
	);
	assert.equal(requests[0]?.headers.get("apikey"), "machine-key");
	assert.deepEqual(JSON.parse(String(requests[0]?.body)), {
		password: "personal-password",
		username: "user@example.com",
	});
	assert.equal(
		requests[1]?.url,
		"https://justinia.gz3.agoralab.co/api/connection/whoami",
	);
	assert.equal(
		requests[1]?.headers.get("authorization"),
		"Bearer issued-token",
	);
	assert.equal(identity.externalAccount, "user-1");
	assert.equal(identity.displayName, "user@example.com");
	assert.equal(identity.accessToken, "issued-token");
	assert.equal(JSON.stringify(identity).includes("machine-key"), false);
	assert.equal(JSON.stringify(identity).includes("personal-password"), false);
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

test("Rehoboam rejects redirects and login responses without a token", async () => {
	for (const response of [
		new Response(null, {
			headers: { location: "https://oauth.example" },
			status: 302,
		}),
		Response.json({ data: {}, success: true }),
	]) {
		const adapter = new RehoboamAdapter(async () => response, "machine-key");
		await assert.rejects(
			adapter.validateCredential(
				JSON.stringify({ password: "password", username: "user@example.com" }),
			),
			(error: Error & { providerCredentialInvalid?: boolean }) =>
				error.providerCredentialInvalid === true,
		);
	}
});
