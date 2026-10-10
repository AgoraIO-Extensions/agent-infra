import assert from "node:assert/strict";
import test from "node:test";
import { runStaticSpacesOnboarding } from "./static-spaces-onboarding.mjs";

test("StaticSpaces canary rejects a different container before any network or mutation", async () => {
	await assert.rejects(
		runStaticSpacesOnboarding({
			token: "synthetic-current-test-token",
			revokedToken: "synthetic-revoked-test-token",
			slug: "another-space",
		}),
		{ code: "ERR_ASSERTION" },
	);
});

test("StaticSpaces lifecycle canary cannot revoke or reuse the current credential", async () => {
	await assert.rejects(
		runStaticSpacesOnboarding({
			token: "synthetic-test-token",
			revokedToken: "synthetic-test-token",
			slug: "connection-test",
		}),
		{ code: "ERR_ASSERTION" },
	);
});

test("StaticSpaces container identity denial fails before mutation and retains failure evidence", async () => {
	const methods = [];
	let closed = false;
	await assert.rejects(
		runStaticSpacesOnboarding({
			token: "synthetic-current-test-token",
			revokedToken: "synthetic-revoked-test-token",
			slug: "connection-test",
			transportFactory: () => ({
				fetch: async (url, init) => {
					methods.push(init?.method ?? "GET");
					if (String(url).includes("/core/applications/"))
						return new Response(null, { status: 403 });
					return Response.json({
						user: {
							pk: 841,
							username: "synthetic@example.test",
							is_active: true,
							is_superuser: false,
							groups: [
								{ pk: "5c8d58a6-4732-4e7a-bf3e-c0174e771aa1" },
								{ pk: "9ba88b80-f9fb-43c8-8c91-684f0bbcdef0" },
							],
						},
					});
				},
				close: async () => {
					closed = true;
				},
			}),
		}),
		(error) => {
			assert.equal(error.evidence.status, "FAILED");
			assert.equal(error.evidence.containerPreflightHttp, 403);
			assert.deepEqual(error.evidence.resources, []);
			assert.equal(error.evidence.cleanup, "SUCCEEDED");
			assert.ok(
				!JSON.stringify(error.evidence).includes(
					"synthetic-current-test-token",
				),
			);
			return true;
		},
	);
	assert.ok(methods.length > 0 && methods.every((method) => method === "GET"));
	assert.equal(closed, true);
});
