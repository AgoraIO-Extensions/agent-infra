import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { requestDigest } from "@agent-infra/agent-runtime";
import { connectionConsumerProfileFingerprintV1 } from "@agent-infra/contracts/connection-consumer-profile";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	runtimeV2Keys,
	signV3Fixture,
	submitV3Fixture,
} from "../../../packages/agent-runtime/src/grant-v2-fixture.test-support.js";
import { runtimeTlsFixture } from "../../../tests/runtime-tls-fixture.js";
import { resolveApprovedConnectionConsumerTargetV1 } from "../../platform-worker/src/conversation-deployment.js";
import { createWorkerRuntimeHostClientV3 } from "../../platform-worker/src/runtime-host-client.js";
import { readRuntimeConnectionConsumerProfile } from "./connection-consumer-profile.js";
import {
	assembleRuntimeHost,
	closeRuntimeHost,
	createRuntimeHostApp,
	startRuntimeHost,
} from "./index.js";

vi.mock("./process-protection.js", () => ({
	assertRuntimeProcessProtection: vi.fn(),
}));

const directories: string[] = [];
const runtimes: Awaited<ReturnType<typeof assembleRuntimeHost>>[] = [];
afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close();
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

function snapshot(mcpPath = "/mcp") {
	const profile = {
		schemaVersion: 1 as const,
		publicOrigin: "https://connection.example.test",
		mcpPath,
		consumerId: "platform-consumer",
		audience: "connection-resource",
		egressProfile: { ref: "approved-egress", revision: "r1" },
	};
	return {
		profile,
		approval: {
			schemaVersion: 1 as const,
			configFingerprint: connectionConsumerProfileFingerprintV1(profile),
			egressEnforced: true as const,
			source: { ref: "deployment-config", revision: "r1" },
		},
	};
}

function target(mcpPath = "/mcp") {
	const input = snapshot(mcpPath);
	const approved = resolveApprovedConnectionConsumerTargetV1(
		input.profile,
		input.approval,
	);
	if (!approved) throw new Error("Invalid test profile");
	return approved;
}

async function configurationFile(bytes: string | Uint8Array) {
	const directory = await mkdtemp(join(tmpdir(), "host-consumer-profile-"));
	directories.push(directory);
	const path = join(directory, "profile.json");
	await writeFile(path, bytes);
	return path;
}

async function setup(configured = true, mcpPath = "/mcp") {
	const directory = await mkdtemp(join(tmpdir(), "host-consumer-http-"));
	directories.push(directory);
	const environment: NodeJS.ProcessEnv = {
		AGENT_INFRA_RUNTIME_DRIVER: "fake",
		AGENT_INFRA_RUNTIME_DATA_DIR: directory,
		AGENT_INFRA_RUNTIME_WORKER_ID: "worker-fixture",
		AGENT_INFRA_RUNTIME_GRANT_KEY_ID: "fixture",
		AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY: runtimeV2Keys.publicKey
			.export({ type: "spki", format: "pem" })
			.toString(),
		AGENT_INFRA_RUNTIME_GRANT_ISSUER: "platform-fixture",
		AGENT_INFRA_RUNTIME_SERVICE_TOKEN: "synthetic-service-token",
		// Individual ordinary env fields cannot enable or change the snapshot.
		AGENT_INFRA_CONNECTION_PROFILE: JSON.stringify({
			consumerId: "unapproved",
		}),
	};
	if (configured)
		environment.AGENT_INFRA_RUNTIME_CONNECTION_CONSUMER_FILE =
			await configurationFile(JSON.stringify(snapshot(mcpPath)));
	const runtime = await assembleRuntimeHost(environment);
	runtimes.push(runtime);
	const app = createRuntimeHostApp(runtime);
	const submit = vi.spyOn(runtime.host, "submitTurnV3");
	const client = createWorkerRuntimeHostClientV3({
		baseUrl: "https://runtime.example.test",
		serviceToken: "synthetic-service-token",
		...(configured ? { connectionConsumer: target(mcpPath) } : {}),
		fetch: async (input, init) => app.request(String(input), init),
	});
	return { runtime, app, submit, client, environment };
}

function businessRequest() {
	return signV3Fixture(submitV3Fixture(), "turn.submit", { now: Date.now() });
}

function post(body: unknown, header?: string, authorized = true) {
	return {
		method: "POST",
		headers: {
			authorization: `Bearer ${authorized ? "synthetic-service-token" : "invalid"}`,
			"content-type": "application/json",
			...(header === undefined
				? {}
				: { "x-agent-infra-connection-consumer": header }),
		},
		body: JSON.stringify(body),
	};
}

describe("RuntimeHost deployment Connection snapshot", () => {
	it("reads a complete ConfigMap projection through the sole producer", async () => {
		const file = await configurationFile(JSON.stringify(snapshot()));
		const projection = `${file}.projection`;
		await symlink(file, projection);
		expect(await readRuntimeConnectionConsumerProfile(projection)).toEqual(
			target(),
		);
		expect(
			await readRuntimeConnectionConsumerProfile(undefined),
		).toBeUndefined();
	});
	it("keeps the endpoint bytes exact rather than normalizing the path", async () => {
		const input = snapshot();
		input.profile.mcpPath = "/mcp/工具";
		input.approval.configFingerprint = connectionConsumerProfileFingerprintV1(
			input.profile,
		);
		const file = await configurationFile(JSON.stringify(input));
		expect(await readRuntimeConnectionConsumerProfile(file)).toMatchObject({
			url: "https://connection.example.test/mcp/工具",
		});
	});
	it.each([
		["invalid JSON", "{"],
		["missing approval", JSON.stringify({ profile: snapshot().profile })],
		[
			"unknown wrapper field",
			JSON.stringify({ ...snapshot(), token: "sentinel" }),
		],
		[
			"unknown profile field",
			JSON.stringify({
				...snapshot(),
				profile: { ...snapshot().profile, token: "sentinel" },
			}),
		],
		[
			"stale approval",
			JSON.stringify({
				...snapshot(),
				approval: { ...snapshot().approval, configFingerprint: "0".repeat(64) },
			}),
		],
		[
			"egress not enforced",
			JSON.stringify({
				...snapshot(),
				approval: { ...snapshot().approval, egressEnforced: false },
			}),
		],
		["oversized file", " ".repeat(8193)],
		["invalid UTF-8", new Uint8Array([255])],
	])("rejects %s without exposing input", async (_name, bytes) => {
		const file = await configurationFile(bytes);
		const unavailable = await readRuntimeConnectionConsumerProfile(file);
		expect(unavailable).toMatchObject({
			status: "unavailable",
			schemaVersion: 1,
		});
		expect(JSON.stringify(unavailable)).not.toContain("sentinel");
	});
	it("does not fall back when a selected file is missing or not a regular file", async () => {
		const file = await configurationFile("{}");
		for (const path of ["relative.json", `${file}.missing`, join(file, "..")])
			await expect(readRuntimeConnectionConsumerProfile(path)).resolves.toEqual(
				{
					status: "unavailable",
					schemaVersion: 1,
					reason: "invalid",
				},
			);
	});
});

describe("Worker to RuntimeHost Connection profile reception", () => {
	it.each(["/mcp", "/mcp/café"])(
		"accepts the real Worker resolver snapshot for %s",
		async (path) => {
			const { runtime, client, submit } = await setup(true, path);
			expect(runtime.connectionConsumer).toEqual(target(path));
			await expect(client.submitTurn(businessRequest())).resolves.toMatchObject(
				{
					result: { outcome: "accepted" },
				},
			);
			expect(submit).toHaveBeenCalledTimes(1);
		},
	);
	it("preserves execution without Connection configuration", async () => {
		const { runtime, client, submit } = await setup(false);
		expect(runtime.connectionConsumer).toBeUndefined();
		await expect(client.submitTurn(businessRequest())).resolves.toMatchObject({
			result: { outcome: "accepted" },
		});
		expect(submit).toHaveBeenCalledTimes(1);
	});
	it.each([
		["missing", undefined],
		["malformed", "{"],
		[
			"URL",
			JSON.stringify({ ...target(), url: "https://other.example.test/mcp" }),
		],
		[
			"fingerprint",
			JSON.stringify({ ...target(), configFingerprint: "0".repeat(64) }),
		],
		[
			"source",
			JSON.stringify({ ...target(), source: { ref: "other", revision: "r1" } }),
		],
		["unknown field", JSON.stringify({ ...target(), token: "input-sentinel" })],
		["oversized", " ".repeat(8193)],
		...(
			[
				"consumerId",
				"audience",
				"publicOrigin",
				"mcpPath",
				"egressProfile",
			] as const
		).map((field): [string, string] => [
			field,
			JSON.stringify({
				...target(),
				profile: { ...target().profile, [field]: "other" },
			}),
		]),
	])("rejects a %s mismatch before Host execution", async (_name, header) => {
		const { app, submit } = await setup();
		const response = await app.request(
			"/internal/runtime/v3/turns",
			post(businessRequest(), header),
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			code: "CONNECTION_CONSUMER_PROFILE_UNAVAILABLE",
			retryable: false,
		});
		expect(submit).not.toHaveBeenCalled();
	});
	it("cannot bootstrap local approval from the transport Header", async () => {
		const { app, submit } = await setup(false);
		const response = await app.request(
			"/internal/runtime/v3/turns",
			post(businessRequest(), JSON.stringify(target())),
		);
		expect(response.status).toBe(503);
		expect(submit).not.toHaveBeenCalled();
	});
	it.each([1, 2, 3, 4])(
		"gates both V%s business entrances before parsing or dispatch",
		async (version) => {
			const { runtime, app } = await setup();
			const methods = [
				"submitTurn",
				"submitTurnV2",
				"submitTurnV3",
				"submitTurnV4",
				"supplement",
				"supplementV3",
				"supplementV4",
			] as const;
			const dispatches = methods.map((method) =>
				vi.spyOn(runtime.host, method),
			);
			for (const route of version === 2
				? ["turns"]
				: ["turns", "instructions"]) {
				const response = await app.request(
					`/internal/runtime/v${version}/${route}`,
					post({}),
				);
				expect(response.status).toBe(503);
			}
			for (const dispatch of dispatches)
				expect(dispatch).not.toHaveBeenCalled();
		},
	);
	it("authenticates the Worker before revealing the configuration gate", async () => {
		const { app, submit } = await setup();
		const response = await app.request(
			"/internal/runtime/v3/turns",
			post(businessRequest(), "input-sentinel", false),
		);
		expect(response.status).toBe(401);
		expect(await response.text()).not.toContain("input-sentinel");
		expect(submit).not.toHaveBeenCalled();
	});
	it.each(["principal", "agentId"] as const)(
		"matching profile does not authorize a forged %s",
		async (field) => {
			const { app } = await setup();
			const signed = businessRequest();
			const request = {
				...signed,
				[field]:
					field === "principal"
						? { kind: "user", id: "another-user" }
						: "another-agent",
			};
			const response = await app.request(
				"/internal/runtime/v3/turns",
				post(request, JSON.stringify(target())),
			);
			expect(response.status).toBe(403);
		},
	);
	it("retains its captured snapshot when the caller mutates assembly metadata", async () => {
		const { runtime } = await setup();
		const profile = runtime.connectionConsumer;
		if (profile?.status !== "available")
			throw new Error("Missing test profile");
		const mutable = structuredClone(profile);
		const app = createRuntimeHostApp({
			...runtime,
			connectionConsumer: mutable,
		});
		Object.assign(mutable.profile, { consumerId: "another-consumer" });
		Object.assign(mutable.source, { revision: "r2" });
		const response = await app.request(
			"/internal/runtime/v3/turns",
			post(businessRequest(), JSON.stringify(target())),
		);
		expect(response.status).toBe(200);
	});
	it.each([false, true])(
		"retains original status and stop after profile drift (unavailable restart: %s)",
		async (restart) => {
			const initial = await setup();
			const { client, submit, environment } = initial;
			let { runtime, app } = initial;
			const original = businessRequest();
			const accepted = await client.submitTurn(original);
			if (restart) {
				await runtime.close();
				runtimes.splice(runtimes.indexOf(runtime), 1);
				environment.AGENT_INFRA_RUNTIME_CONNECTION_CONSUMER_FILE = join(
					environment.AGENT_INFRA_RUNTIME_DATA_DIR ?? "",
					"missing-profile.json",
				);
				runtime = await assembleRuntimeHost(environment);
				runtimes.push(runtime);
				app = createRuntimeHostApp(runtime);
				expect(runtime.connectionConsumer).toMatchObject({
					status: "unavailable",
				});
			}
			const newSubmit = vi.spyOn(runtime.host, "submitTurnV3");
			const rejected = await app.request(
				"/internal/runtime/v3/turns",
				post(
					businessRequest(),
					JSON.stringify({
						...target(),
						url: "https://other.example.test/mcp",
					}),
				),
			);
			expect(rejected.status).toBe(503);
			if (restart) {
				const withoutHeader = await app.request(
					"/internal/runtime/v3/turns",
					post(businessRequest()),
				);
				expect(withoutHeader.status).toBe(503);
			}
			const { input: _input, grant: _grant, ...base } = original;
			const current = { ...base, hostSessionRef: accepted.hostSessionRef };
			const changedHeader = JSON.stringify({
				...target(),
				url: "https://other.example.test/mcp",
			});
			const recover = vi.spyOn(runtime.host, "recoverStatusV3");
			const stop = vi.spyOn(runtime.host, "stopV3");
			const status = await app.request(
				"/internal/runtime/v3/status",
				post(
					signV3Fixture(
						{
							...current,
							requestId: "recover-after-profile-drift",
							originalOperationDigest: requestDigest({
								kind: "submit-turn",
								agentId: original.agentId,
								conversationId: original.conversationId,
								executionId: original.executionId,
								turnId: original.turnId,
								sessionGeneration: original.sessionGeneration,
								input: original.input,
							}),
						},
						"session.status",
						{
							now: Date.now(),
							purpose: "control",
							reason: "recovery",
						},
					),
					changedHeader,
				),
			);
			expect(status.status).toBe(200);
			const stopped = await app.request(
				"/internal/runtime/v3/stops",
				post(
					signV3Fixture(
						{
							...current,
							requestId: "stop-after-profile-drift",
							operation: {
								kind: "stop" as const,
								id: "stop-after-profile-drift",
								deliveryFence: 2,
								executionDeliveryFence: 1,
							},
						},
						"turn.stop",
						{
							now: Date.now(),
							purpose: "control",
							reason: "stop",
							claims: { controlRecordId: "stop-after-profile-drift" },
						},
					),
					changedHeader,
				),
			);
			expect(stopped.status).toBe(200);
			expect(recover).toHaveBeenCalledTimes(1);
			expect(stop).toHaveBeenCalledTimes(1);
			expect(submit).toHaveBeenCalledTimes(1);
			if (restart) expect(newSubmit).not.toHaveBeenCalled();
		},
	);
	it("reports the same captured nonsecret revision at real HTTPS startup", async () => {
		const { runtime } = await setup();
		const material = await runtimeTlsFixture();
		const ready = Promise.withResolvers<string>();
		const server = startRuntimeHost({
			...runtime,
			tls: { ...material, serviceDnsNames: ["localhost"] },
			port: 0,
			log: ready.resolve,
		});
		server.once("error", ready.reject);
		try {
			expect(JSON.parse(await ready.promise)).toMatchObject({
				connectionConsumerProfile: {
					schemaVersion: 1,
					configFingerprint: target().configFingerprint,
					source: target().source,
				},
			});
		} finally {
			if (server.listening) await closeRuntimeHost(server, async () => {});
		}
	});
});
