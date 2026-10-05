import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
			observability: {
				enabled: false,
				state: "active",
				captureFailures: 0,
				exportFailures: 0,
				droppedLogs: 0,
				invalidRecords: 0,
			},
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

function verifyPackagedApiEntrypoint() {
	const entry = new URL("../apps/platform-api/dist/index.mjs", import.meta.url);
	const missing = spawnSync(process.execPath, [fileURLToPath(entry)], {
		encoding: "utf8",
		env: { ...process.env, PLATFORM_API_DEPLOYMENT_MODULE: "" },
		timeout: 5000,
	});
	assert.equal(missing.status, 1, missing.stderr);
	assert.equal(
		missing.stderr.trim(),
		"PLATFORM_API_DEPLOYMENT_MODULE is required",
	);
}

async function verifyPackagedApiDeployment() {
	const directory = await mkdtemp(join(tmpdir(), "agent-infra-api-module-"));
	const configuration = join(directory, "configuration.mjs");
	const tokenFile = join(directory, "proxy-token");
	const token = Buffer.alloc(32, 97).toString("base64url");
	try {
		await writeFile(tokenFile, token, { mode: 0o600 });
		await writeFile(
			configuration,
			`export const ldap = {
  url: "ldaps://ldap.example.test", issuer: "fixture", baseDn: "dc=example,dc=test",
  serviceBindDn: "cn=reader,dc=example,dc=test", serviceBindPassword: "fixture",
  loginAttribute: "uid", uidAttribute: "uid", emailAttribute: "mail",
  displayNameAttribute: "cn", verifyCurrentStatus: async () => "active",
  identityIds: {
    findByUid: async () => null, findUidByUserId: async () => null,
    getOrCreate: async () => "00000000-0000-4000-8000-000000000001",
  },
};
export const isPlatformDisabled = async () => false;
export const organizationIds = async () => ["fixture-org"];
export const publicOrigin = "https://localhost:3001";
export const directorySearch = async () => [];
export const apiInput = {};
`,
		);
		const moduleUrl = new URL(
			"../apps/platform-api/dist/deployment.mjs",
			import.meta.url,
		).href;
		const probe = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`import assert from "node:assert/strict";
const deployment = await import(${JSON.stringify(moduleUrl)});
const request = (value) => new Request("http://localhost:3001/auth/login", {
  method: "HEAD",
  headers: {
    host: "localhost:3001",
    "x-forwarded-proto": "https",
    "x-platform-proxy-token": value,
  },
});
assert.equal((await deployment.browserAuth.handleRequest(request("wrong"))).status, 400);
assert.equal((await deployment.browserAuth.handleRequest(request(${JSON.stringify(token)}))).status, 405);
assert.throws(() => deployment.createPlatformApiAssemblyInput(), /PLATFORM_DEPLOYMENT_CONFIGURATION_INVALID/);
await deployment.browserAuth.close();`,
			],
			{
				encoding: "utf8",
				env: {
					...process.env,
					PLATFORM_API_CONFIGURATION_MODULE: pathToFileURL(configuration).href,
					PLATFORM_API_PROXY_TOKEN_FILE: tokenFile,
					PLATFORM_DATABASE_URL:
						"postgresql://fixture:fixture@127.0.0.1:54329/fixture",
				},
			},
		);
		assert.equal(probe.status, 0, probe.stderr);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

await verifyPlatformApi();
verifyPackagedApiEntrypoint();
await verifyPackagedApiDeployment();
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
