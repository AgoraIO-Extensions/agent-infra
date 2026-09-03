import assert from "node:assert/strict";
import { once } from "node:events";

import { startConnectionApi } from "../apps/connection-api/dist/index.mjs";
import { startPlatformApiFromDeployment } from "../apps/platform-api/dist/index.mjs";
import { startPlatformWorker } from "../apps/platform-worker/dist/index.mjs";

async function verifyApi(start, expectedService) {
	const server = start({ log: () => undefined, port: 0 });
	await once(server, "listening");
	const address = server.address();
	assert(address && typeof address === "object");

	try {
		const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), {
			service: expectedService,
			status: "ok",
		});
	} finally {
		server.close();
		await once(server, "close");
	}
}

async function verifyPlatformApi() {
	const { assembly, server } = await startPlatformApiFromDeployment({
		log: () => undefined,
		moduleSpecifier: new URL(
			"./fixtures/platform-api-deployment.mjs",
			import.meta.url,
		).href,
		port: 0,
	});
	const address = server.address();
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
		assert.equal((await session.json()).user.userId, "smoke-user");
	} finally {
		server.close();
		await once(server, "close");
		await assembly.close();
	}
}

await verifyPlatformApi();
await verifyApi(startConnectionApi, "connection-api");

const workerMessages = [];
const worker = startPlatformWorker({
	log: (message) => workerMessages.push(message),
});
worker.stop();
assert.deepEqual(
	workerMessages.map((message) => JSON.parse(message)),
	[
		{ service: "platform-worker", status: "ready" },
		{ service: "platform-worker", status: "stopped" },
	],
);

console.info("Application smoke checks passed");
