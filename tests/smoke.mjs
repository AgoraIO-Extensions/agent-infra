import assert from "node:assert/strict";
import { once } from "node:events";

import { startConnectionApi } from "../apps/connection-api/dist/index.mjs";
import { startPlatformApi } from "../apps/platform-api/dist/index.mjs";
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

await verifyApi(startPlatformApi, "platform-api");
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
