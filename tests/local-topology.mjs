import assert from "node:assert/strict";

import {
	createPlatformApiShutdown,
	startPlatformApiFromDeployment,
} from "../apps/platform-api/dist/index.mjs";

const running = await startPlatformApiFromDeployment({
	log: () => undefined,
	moduleSpecifier: new URL(
		"./fixtures/platform-api-local-deployment.mjs",
		import.meta.url,
	).href,
	port: 0,
});
const shutdown = createPlatformApiShutdown(running);
const address = running.server.address();
assert(address && typeof address === "object");

try {
	const baseUrl = `http://127.0.0.1:${address.port}`;
	const health = await fetch(`${baseUrl}/healthz`);
	assert.equal(health.status, 200);
	assert.deepEqual(await health.json(), {
		service: "platform-api",
		status: "ok",
	});

	const session = await fetch(`${baseUrl}/api/v1/session`);
	assert.equal(session.status, 200);
	assert.deepEqual(await session.json(), {
		schemaVersion: 1,
		user: {
			userId: "local-topology-admin",
			displayName: "Local Topology Admin",
			roles: ["employee", "system_admin"],
		},
	});

	const audit = await fetch(`${baseUrl}/api/v1/admin/audit`);
	assert.equal(audit.status, 200);
	assert.deepEqual(await audit.json(), { items: [], nextCursor: null });
} finally {
	await shutdown();
}

console.info("Local topology smoke checks passed");
