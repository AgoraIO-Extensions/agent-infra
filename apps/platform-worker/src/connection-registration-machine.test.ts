import { planConnectionConsumerRegistrationV1 } from "@agent-infra/platform-core";
import { expect, it, vi } from "vitest";
import { createConnectionRegistrationOwnerBindingResolverV2 } from "./connection-registration-machine.js";

it("reads an independent source-bound Owner binding and rejects another Owner, expiry and extra fields", async () => {
	const policy = {
		schemaVersion: 1 as const,
		sourceNamespace: "source-a",
		revision: "policy-1",
		callbackUrl: "https://platform.example.test/callback",
		resource: "https://connection.example.test/mcp",
		scope: "mcp",
	};
	const intent = planConnectionConsumerRegistrationV1({
		policy,
		platformAgentId: "agent-a",
		platformOwnerId: "owner-a",
		consumerName: "Agent",
	});
	const body = {
		schemaVersion: 2,
		sourceNamespace: "source-a",
		platformAgentId: "agent-a",
		platformOwnerId: "owner-a",
		policyRevision: "policy-1",
		ownerPrincipalId: "principal-a",
		companyId: "company-a",
		ownerRevision: "current-1",
		expiresAt: Date.now() + 20_000,
	};
	let patch = {};
	const transport = vi.fn(async (request: Request) => {
		expect(request.method).toBe("GET");
		expect(request.url).toBe(
			"https://connection.example.test/connection/internal/v2/platform-agent-consumer-registrations/source-a/agent-a/owner-binding",
		);
		return Response.json(
			{ ...body, ...patch },
			{ headers: { "cache-control": "no-store" } },
		);
	});
	const read = createConnectionRegistrationOwnerBindingResolverV2({
		publicOrigin: "https://connection.example.test",
		authenticatedRequest: transport,
	});
	expect(await read(intent, AbortSignal.timeout(5000))).toMatchObject({
		ownerPrincipalId: "principal-a",
		platformOwnerId: "owner-a",
	});
	for (const invalid of [
		{ platformOwnerId: "owner-b" },
		{ expiresAt: 1 },
		{ sourceNamespace: "foreign" },
		{ secret: "forbidden" },
	]) {
		patch = invalid;
		expect(await read(intent, AbortSignal.timeout(5000))).toBeUndefined();
	}
});

it("dispatches a TLS POST once on 421 and rejects untrusted TLS and foreign paths", async () => {
	const { createServer } = await import("node:https");
	const { writeFile, symlink } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const { runtimeTlsFixture } = await import(
		"../../../tests/runtime-tls-fixture.js"
	);
	const { createConnectionRegistrationMachineTransportV2 } = await import(
		"./connection-registration-machine.js"
	);
	const tls = await runtimeTlsFixture();
	const credentialFile = join(tls.directory, "registration.token");
	const token = `conn_platform_reg_${"A".repeat(43)}`;
	await writeFile(credentialFile, token, { mode: 0o600 });
	let dispatches = 0;
	const server = createServer(
		{ key: tls.key, cert: tls.cert },
		(request, response) => {
			dispatches++;
			expect(request.headers.authorization).toBe(`Bearer ${token}`);
			request.resume();
			response.writeHead(421, {
				"content-type": "application/json",
				"cache-control": "no-store",
			});
			response.end("{}");
		},
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("Missing fixture listener");
		const publicOrigin = `https://localhost:${address.port}`;
		const input = { publicOrigin, sourceNamespace: "source-a", credentialFile };
		const make = () =>
			new Request(
				`${publicOrigin}/connection/internal/v2/platform-agent-consumer-registrations/source-a/agent-a`,
				{
					method: "POST",
					body: "{}",
					credentials: "omit",
					redirect: "error",
					signal: AbortSignal.timeout(5000),
				},
			);
		const response = await createConnectionRegistrationMachineTransportV2({
			...input,
			ca: tls.ca,
		})(make());
		expect(response.status).toBe(421);
		await response.arrayBuffer();
		expect(dispatches).toBe(1);
		const projected = join(tls.directory, "projected.token");
		await symlink("registration.token", projected);
		const projectedResponse =
			await createConnectionRegistrationMachineTransportV2({
				...input,
				credentialFile: projected,
				ca: tls.ca,
			})(make());
		expect(projectedResponse.status).toBe(421);
		await projectedResponse.arrayBuffer();
		expect(dispatches).toBe(2);
		await expect(
			createConnectionRegistrationMachineTransportV2(input)(make()),
		).rejects.toThrow();
		await expect(
			createConnectionRegistrationMachineTransportV2({ ...input, ca: tls.ca })(
				new Request(`${publicOrigin}/foreign`, {
					credentials: "omit",
					redirect: "error",
				}),
			),
		).rejects.toThrow();
		expect(dispatches).toBe(2);
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
		await tls.cleanup();
	}
});

it("rejects a FIFO credential without waiting for a writer", async () => {
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const { createConnectionRegistrationMachineTransportV2 } = await import(
		"./connection-registration-machine.js"
	);
	const directory = await mkdtemp(join(tmpdir(), "registration-fifo-"));
	try {
		const credentialFile = join(directory, "registration.token");
		await promisify(execFile)("mkfifo", [credentialFile]);
		const transport = createConnectionRegistrationMachineTransportV2({
			publicOrigin: "https://connection.example.test",
			sourceNamespace: "source-a",
			credentialFile,
		});
		await expect(
			transport(
				new Request(
					"https://connection.example.test/connection/internal/v2/platform-agent-consumer-registrations/source-a/agent-a",
					{
						credentials: "omit",
						redirect: "error",
						signal: AbortSignal.timeout(1000),
					},
				),
			),
		).rejects.toThrow();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("composes the existing Worker port with envelope encryption without exposing the credential", async () => {
	const { generateKeyPairSync, createHash } = await import("node:crypto");
	const { createConnectionRegistrationWorkerConfigurationV2 } = await import(
		"./connection-registration-machine.js"
	);
	const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
	const der = publicKey.export({ format: "der", type: "spki" });
	const config = createConnectionRegistrationWorkerConfigurationV2({
		publicOrigin: "https://connection.example.test",
		credentialFile: "/private/registration.token",
		policy: {
			schemaVersion: 1,
			sourceNamespace: "source-a",
			revision: "policy-1",
			callbackUrl: "https://platform.example.test/callback",
			resource: "https://connection.example.test/mcp",
			scope: "mcp",
		},
		encryptionKeys: {
			schemaVersion: 1,
			activeWrappingKeyVersion: "fixture-key",
			keys: [
				{
					schemaVersion: 1,
					keyVersion: "fixture-key",
					wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
					publicKeySpkiDerBase64: der.toString("base64"),
					publicKeyFingerprint: createHash("sha256").update(der).digest("hex"),
					rsaModulusBits: 3072,
					status: "active",
				},
			],
		},
	});
	expect(config.adapter.credentialDelivery).toBe("RESPONSE");
	const credential = `conn_consumer_${"E".repeat(43)}`;
	const encrypted = await config.encryptCredential(
		{ agentId: "agent-a", ownerId: "owner-a", associationRevision: 1 },
		credential,
	);
	expect(encrypted).toMatchObject({ ownerId: "owner-a", agentId: "agent-a" });
	expect(JSON.stringify(encrypted)).not.toContain(credential);
});
