import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FakeRuntimeDriver,
	FileRuntimeStore,
	RuntimeHost,
} from "@agent-infra/agent-runtime";
import {
	BrowserCapabilityErrorV1Schema,
	BrowserCapabilityProjectionV1Schema,
} from "@agent-infra/contracts/runtime";
import { afterEach, expect, it } from "vitest";
import { createRuntimeHostApp } from "./app.js";
import { closeRuntimeHost, startRuntimeHost } from "./index.js";

const resources: { root: string; host: RuntimeHost }[] = [];
const token = "synthetic-browser-worker-token";
async function setup() {
	const root = await mkdtemp(join(tmpdir(), "browser-discovery-http-"));
	const host = await RuntimeHost.open({
		store: await FileRuntimeStore.open(join(root, "host.json")),
		driver: await FakeRuntimeDriver.open(join(root, "driver.json")),
		grantValidation: { expectedIssuer: "agent-platform" },
	});
	resources.push({ root, host });
	const options = {
		host,
		serviceToken: token,
		verifyGrant: () => {
			throw new Error("discovery does not accept business grants");
		},
	};
	return { options, app: createRuntimeHostApp(options) };
}
afterEach(async () => {
	for (const { root, host } of resources.splice(0)) {
		await host.close();
		await rm(root, { recursive: true, force: true });
	}
});

it("returns the versioned not_configured Browser state through the authenticated Host", async () => {
	const { app } = await setup();
	const response = await app.request(
		"/internal/runtime/v1/browser-capability?schemaVersion=1",
		{
			headers: { authorization: `Bearer ${token}` },
		},
	);
	expect(response.status).toBe(200);
	const projection = BrowserCapabilityProjectionV1Schema.parse(
		await response.json(),
	);
	expect(projection).toMatchObject({
		schemaVersion: 1,
		capabilityVersion: 1,
		status: "not_configured",
		errorCode: "BROWSER_CAPABILITY_NOT_CONFIGURED",
		retryable: false,
	});
});

it("rejects a minimum capability version above the Host implementation", async () => {
	const { app } = await setup();
	const response = await app.request(
		"/internal/runtime/v1/browser-capability?schemaVersion=1&minimumCapabilityVersion=2",
		{ headers: { authorization: `Bearer ${token}` } },
	);
	expect(response.status).toBe(409);
	expect(
		BrowserCapabilityErrorV1Schema.parse(await response.json()),
	).toMatchObject({
		code: "BROWSER_CAPABILITY_VERSION_UNSUPPORTED",
		retryable: false,
	});
});

it("rejects caller identity fields rather than selecting another Browser", async () => {
	const { app } = await setup();
	const response = await app.request(
		"/internal/runtime/v1/browser-capability?schemaVersion=1&agentId=foreign-agent",
		{ headers: { authorization: `Bearer ${token}` } },
	);
	expect(response.status).toBe(400);
	expect(await response.json()).toMatchObject({
		code: "BROWSER_CAPABILITY_POLICY_DENIED",
		retryable: false,
	});
});

it.each([undefined, "Bearer wrong-worker", "Basic synthetic", "Bearer"])(
	"keeps Worker authentication ahead of discovery query validation: %s",
	async (authorization) => {
		const { app } = await setup();
		const response = await app.request(
			"/internal/runtime/v1/browser-capability?schemaVersion=1&agentId=foreign-agent",
			{ headers: authorization ? { authorization } : {} },
		);
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({
			code: "RUNTIME_SERVICE_UNAUTHORIZED",
		});
	},
);

it.each([
	"",
	"schemaVersion=2",
	"schemaVersion=invalid",
	"schemaVersion=1&minimumCapabilityVersion=0",
	"schemaVersion=1&minimumCapabilityVersion=101",
	"schemaVersion=1&minimumCapabilityVersion=1.5",
	"schemaVersion=1&minimumCapabilityVersion=NaN",
	"schemaVersion=1&schemaVersion=1",
	"schemaVersion=1&minimumCapabilityVersion=1&minimumCapabilityVersion=2",
	"schemaVersion=1&status=available",
	"schemaVersion=1&conversationId=foreign-conversation",
	"schemaVersion=1&policy=sentinel-private-value",
	"schemaVersion=1&__proto__=sentinel-private-value",
	"schemaVersion=1&constructor=sentinel-private-value",
])(
	"rejects invalid/ambiguous queries with a bounded Browser error: %s",
	async (query) => {
		const { app } = await setup();
		const response = await app.request(
			`/internal/runtime/v1/browser-capability?${query}`,
			{ headers: { authorization: `Bearer ${token}` } },
		);
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(BrowserCapabilityErrorV1Schema.parse(body)).toMatchObject({
			code: "BROWSER_CAPABILITY_POLICY_DENIED",
			retryable: false,
		});
		expect(JSON.stringify(body)).not.toContain("sentinel-private-value");
	},
);

it("serves discovery through the actual Host startup and close lifecycle", async () => {
	const { options } = await setup();
	const server = startRuntimeHost({ ...options, port: 0, log: () => {} });
	try {
		if (!server.listening) await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("Host did not bind TCP");
		const url = `http://127.0.0.1:${address.port}/internal/runtime/v1/browser-capability?schemaVersion=1&minimumCapabilityVersion=1`;
		const denied = await fetch(url);
		expect(denied.status).toBe(401);
		const accepted = await fetch(url, {
			headers: { authorization: `Bearer ${token}` },
		});
		expect(accepted.status).toBe(200);
		expect(
			BrowserCapabilityProjectionV1Schema.parse(await accepted.json()).status,
		).toBe("not_configured");
	} finally {
		await closeRuntimeHost(server, async () => {});
	}
});
