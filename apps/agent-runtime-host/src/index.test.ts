import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	assembleRuntimeHost,
	createRuntimeHostApp,
	startRuntimeHost,
} from "./index.js";

const directories: string[] = [];
const { publicKey } = generateKeyPairSync("ed25519");

async function environment() {
	const directory = await mkdtemp(join(tmpdir(), "runtime-assembly-"));
	directories.push(directory);
	return {
		AGENT_INFRA_RUNTIME_DRIVER: "fake",
		AGENT_INFRA_RUNTIME_DATA_DIR: directory,
		AGENT_INFRA_RUNTIME_GRANT_KEY_ID: "synthetic-key",
		AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY: publicKey
			.export({ type: "spki", format: "pem" })
			.toString(),
		AGENT_INFRA_RUNTIME_GRANT_ISSUER: "synthetic-platform",
		AGENT_INFRA_RUNTIME_SERVICE_TOKEN: "synthetic-token",
	};
}

afterEach(async () => {
	for (const directory of directories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

describe("RuntimeHost environment assembly", () => {
	it("reports the consumed configuration revision in readiness metadata", async () => {
		const runtime = await assembleRuntimeHost(await environment());
		const ready = Promise.withResolvers<string>();
		const server = startRuntimeHost({
			...runtime,
			port: 0,
			configVersion: "active-revision-17",
			log: ready.resolve,
		});
		try {
			expect(JSON.parse(await ready.promise)).toMatchObject({
				status: "ready",
				configVersion: "active-revision-17",
			});
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
			await runtime.close();
		}
	});

	it("keeps Fake independently usable without Codex model configuration", async () => {
		const runtime = await assembleRuntimeHost(await environment());
		const response = await createRuntimeHostApp(runtime).request("/healthz");
		expect(response.status).toBe(200);
		await runtime.close();
	});

	it.each([
		{ AGENT_INFRA_RUNTIME_DRIVER: "plugin" },
		{ AGENT_INFRA_RUNTIME_DATA_DIR: "relative" },
		{ AGENT_INFRA_RUNTIME_DATA_DIR: "/" },
		{ AGENT_INFRA_RUNTIME_SERVICE_TOKEN: "" },
		{ AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY: "synthetic-invalid-key" },
		{ PORT: "synthetic-private-value" },
		{ AGENT_INFRA_RUNTIME_DRIVER: "codex" },
	])(
		"rejects invalid deployment assembly before opening a listener",
		async (patch) => {
			await expect(
				assembleRuntimeHost({ ...(await environment()), ...patch }),
			).rejects.toThrow(/^RUNTIME_CONFIGURATION_INVALID$/);
		},
	);
});
