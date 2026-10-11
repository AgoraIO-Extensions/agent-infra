import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { createServer, request as httpsRequest } from "node:https";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { revokeStandardOAuthToken } from "@agent-infra/agent-runtime";
import {
	connectionConsumerProfileFingerprintV1,
	resolveApprovedConnectionConsumerProfileV1,
} from "@agent-infra/contracts/connection-consumer-profile";
import {
	canonicalRuntimeRequestSigningPayload,
	type RuntimeOAuthAuthorizedRequestV1,
	type RuntimeOAuthGrantClaimsV1,
} from "@agent-infra/contracts/runtime";
import { afterEach, expect, it, vi } from "vitest";
import { runtimeTlsFixture } from "../../../tests/runtime-tls-fixture.js";
import { createRuntimeHostApp } from "./app.js";
import {
	closeRuntimeHost,
	startRuntimeHost,
	startRuntimeOAuthServer,
} from "./index.js";
import {
	createRuntimeOAuthApp,
	prepareRuntimeOAuth,
	type RuntimeOAuthAssembly,
} from "./runtime-oauth.js";
import { createProtectedRuntimeOAuthClient } from "./runtime-oauth-client.js";
import { createRuntimeOAuthGrantVerifier } from "./runtime-oauth-grant.js";
import { standardMcpInstallationKey } from "./standard-mcp-input.js";

const protection = vi.hoisted(() => ({
	check: vi.fn(),
	afterSecretStat: undefined as ((path: string) => void) | undefined,
	secretReads: 0,
	secretWrites: 0,
	failRecordWrite: false,
}));
vi.mock("./standard-mcp-protection.js", () => ({
	assertStandardMcpProcessProtection: protection.check,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...fs,
		open: async (...args: Parameters<typeof fs.open>) => {
			const file = await fs.open(...args);
			const path = await fs.realpath(String(args[0]));
			if (
				path.endsWith("standard-mcp-oauth/tls/callback.auth") ||
				(path.includes("standard-mcp-oauth/materials/") &&
					/\.(code|access)$/.test(path))
			) {
				const stat = file.stat.bind(file);
				file.stat = (async (...args: Parameters<typeof file.stat>) => {
					const result = await stat(...args);
					protection.afterSecretStat?.(path);
					return result;
				}) as typeof file.stat;
				const read = file.read.bind(file);
				file.read = ((...args: Parameters<typeof file.read>) => {
					protection.secretReads++;
					return read(...args);
				}) as typeof file.read;
				const write = file.writeFile.bind(file);
				file.writeFile = (...args: Parameters<typeof file.writeFile>) => {
					protection.secretWrites++;
					return write(...args);
				};
			}
			if (
				path.includes("standard-mcp-oauth/records/") &&
				path.endsWith(".json")
			) {
				const write = file.writeFile.bind(file);
				file.writeFile = (...args: Parameters<typeof file.writeFile>) => {
					if (protection.failRecordWrite) {
						protection.failRecordWrite = false;
						throw new Error("injected record write failure");
					}
					return write(...args);
				};
			}
			return file;
		},
	};
});
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closes.splice(0).reverse()) await close();
	protection.check.mockReset();
	protection.afterSecretStat = undefined;
	protection.secretReads = 0;
	protection.secretWrites = 0;
	protection.failRecordWrite = false;
});
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const access = "synthetic-oauth-access-material";
const refresh = "synthetic-oauth-refresh-material";
const callbackServiceToken = "synthetic-callback-material-123";

async function fixture() {
	const material = await runtimeTlsFixture();
	closes.push(material.cleanup);
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "runtime-oauth-")),
	);
	closes.push(() => rm(directory, { recursive: true, force: true }));
	const root = join(
		directory,
		"codex-driver.json.native",
		"conversations",
		"standard-mcp-oauth",
	);
	await mkdir(join(root, "tls"), { recursive: true, mode: 0o700 });
	await writeFile(join(root, "tls", "server.crt"), material.cert, {
		mode: 0o600,
	});
	await writeFile(join(root, "tls", "server.key"), material.key, {
		mode: 0o400,
	});
	await writeFile(join(root, "tls", "callback.auth"), callbackServiceToken, {
		mode: 0o400,
	});
	const calls: URLSearchParams[] = [];
	const paths: string[] = [];
	let behavior = "success";
	const issuer = createServer(
		{ cert: material.cert, key: material.key },
		async (req, res) => {
			paths.push(req.url ?? "");
			const chunks: Buffer[] = [];
			for await (const part of req) chunks.push(Buffer.from(part));
			calls.push(new URLSearchParams(Buffer.concat(chunks).toString()));
			if (behavior === "lost") {
				req.socket.destroy();
				return;
			}
			if (behavior === "revoke-after-token") revoked = true;
			if (behavior === "protection-lost")
				protection.check.mockImplementation(() => {
					throw Error("closed");
				});
			if (behavior === "redirect") {
				res.writeHead(302, { location: "/second-token" });
				res.end();
				return;
			}
			if (behavior === "replace-during-revoke") {
				const accessName = (await readdir(join(root, "materials"))).find(
					(name) => name.endsWith(".access"),
				);
				if (accessName) {
					await chmod(join(root, "materials", accessName), 0o600);
					await writeFile(
						join(root, "materials", accessName),
						"replacement-access-material",
					);
					await chmod(join(root, "materials", accessName), 0o400);
				}
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					access_token: access,
					refresh_token: refresh,
					token_type: "Bearer",
					expires_in: 3600,
					scope: "mcp",
				}),
			);
		},
	);
	await new Promise<void>((resolve) => issuer.listen(0, "127.0.0.1", resolve));
	closes.push(async () => {
		issuer.closeAllConnections();
		await new Promise<void>((resolve) => issuer.close(() => resolve()));
	});
	const origin = `https://localhost:${(issuer.address() as AddressInfo).port}`;
	const reserve = createNetServer();
	await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve));
	const port = (reserve.address() as AddressInfo).port;
	await new Promise<void>((resolve) => reserve.close(() => resolve()));
	const profile = {
		schemaVersion: 1 as const,
		publicOrigin: origin,
		mcpPath: "/mcp/{opaque}",
		consumerId: "platform",
		audience: "fixture-mcp",
		egressProfile: { ref: "fixture-egress", revision: "r1" },
	};
	const approval = {
		schemaVersion: 1 as const,
		configFingerprint: connectionConsumerProfileFingerprintV1(profile),
		source: { ref: "fixture-approved-profile", revision: "r1" },
		egressEnforced: true as const,
	};
	const approved = resolveApprovedConnectionConsumerProfileV1(
		profile,
		approval,
	);
	if (approved.status !== "available")
		throw Error("Invalid controlled profile");
	const target = { ...approved, url: origin + profile.mcpPath };
	const configuration = {
		schemaVersion: 1 as const,
		ref: "fixture-oauth",
		revision: "r1",
		clientId: "fixture-client",
		issuer: `${origin}/`,
		authorizationEndpoint: `${origin}/oauth/authorize`,
		tokenEndpoint: `${origin}/oauth/token`,
		revocationEndpoint: `${origin}/oauth/revoke`,
		callbackUrl: "https://platform.invalid/connection/callback",
		runtimeOrigin: `https://localhost:${port}/`,
		resource: target.url,
		scope: "mcp" as const,
		configFingerprint: target.configFingerprint,
		source: target.source,
	};
	const scope = {
		agentId: "agent-a",
		sandboxId: "sandbox-a",
		podUid: "pod-a",
		sessionGeneration: 1,
		configFingerprint: target.configFingerprint,
		source: target.source,
		oauthConfiguration: {
			ref: configuration.ref,
			revision: configuration.revision,
		},
	};
	const principal = { kind: "user" as const, id: "alice" };
	const verifyGrant = createRuntimeOAuthGrantVerifier({
		key: publicKey,
		keyId: "fixture-key",
		issuer: "platform",
		workerId: "worker-a",
		scope,
		principal,
	});
	const fetch = async (
		url: string | URL,
		init?: RequestInit,
	): Promise<Response> =>
		new Promise((resolve, reject) => {
			const req = httpsRequest(
				new URL(String(url)),
				{
					ca: material.ca,
					family: 4,
					method: init?.method,
					headers: Object.fromEntries(new Headers(init?.headers)),
					signal: init?.signal ?? undefined,
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (part) => chunks.push(Buffer.from(part)));
					res.on("end", () =>
						resolve(
							new Response(Buffer.concat(chunks).toString(), {
								status: res.statusCode,
								headers: { "content-type": "application/json" },
							}),
						),
					);
				},
			);
			req.on("error", reject);
			req.end(init?.body?.toString());
		});
	let revoked = false;
	const reference = {
		agentId: scope.agentId,
		conversationId: "conversation-a",
		executionId: "execution-a",
		sessionGeneration: scope.sessionGeneration,
	};
	const store = {
		async resolveOriginalExecutionBinding(value: typeof reference) {
			if (revoked) throw Error("revoked");
			return { principal, scope: value };
		},
		assertOriginalExecutionBindingCurrent() {
			if (revoked) throw Error("revoked");
		},
	};
	const client = await createProtectedRuntimeOAuthClient({
		dataDirectory: directory,
		store,
		configuration,
		target,
		principal,
		scope,
		verifyGrant,
		fetch,
	});
	closes.push(client.close);
	const assembly: Extract<RuntimeOAuthAssembly, { status: "available" }> = {
		status: "available",
		...{ callbackServiceToken },
		client,
		cert: material.cert,
		key: material.key,
		port,
		runtimeOrigin: new URL(configuration.runtimeOrigin).origin,
	};
	const server = startRuntimeOAuthServer(assembly, "fixture-service");
	await new Promise<void>((resolve) =>
		server.listening ? resolve() : server.once("listening", resolve),
	);
	closes.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	function signed(
		command: "begin" | "confirm" | "status",
		patch: Partial<RuntimeOAuthGrantClaimsV1> = {},
		authorizationId = "authorization-a",
	): RuntimeOAuthAuthorizedRequestV1 {
		const request = {
			schemaVersion: 1 as const,
			...scope,
			authorizationId,
			confirmationRevision: "confirmation-r1",
			reference,
			command,
			grant: {
				schemaVersion: 1 as const,
				format: "runtime-connection-installation-jws" as const,
				token: "e30.e30.AA",
			},
		};
		const claims = {
			...scope,
			reference,
			schemaVersion: 1 as const,
			principal,
			purpose: "connection_installation" as const,
			audience: "runtime_connection_client" as const,
			issuer: "platform",
			workerId: "worker-a",
			command,
			authorizationId: request.authorizationId,
			confirmationRevision: request.confirmationRevision,
			grantId: "grant-a",
			issuedAt: Date.now(),
			expiresAt: Date.now() + 30_000,
			requestDigest: createHash("sha256")
				.update(canonicalRuntimeRequestSigningPayload(request))
				.digest("hex"),
			...patch,
		};
		const header = Buffer.from(
			JSON.stringify({
				alg: "EdDSA",
				kid: "fixture-key",
				typ: "runtime-connection-installation+jws",
			}),
		).toString("base64url");
		const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
		const input = `${header}.${payload}`;
		request.grant.token = `${input}.${sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
		return request;
	}
	async function post(
		command: string,
		body: unknown,
		headers: Record<string, string> = {},
	) {
		const response = await fetch(
			`${assembly.runtimeOrigin}/internal/runtime/oauth/v1/${command}`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${command === "callback" ? callbackServiceToken : "fixture-service"}`,
					...headers,
				},
				body: JSON.stringify(body),
			},
		);
		return {
			status: response.status,
			body: (await response.json()) as Record<string, unknown>,
		};
	}
	async function callback() {
		const begun = await post("begin", signed("begin"));
		expect(begun.status).toBe(200);
		const url = new URL(String(begun.body.authorizationUrl));
		const received = await post("callback", {
			schemaVersion: 1,
			state: url.searchParams.get("state"),
			issuer: configuration.issuer,
			code: "synthetic-authorization-code",
		});
		expect(received.status).toBe(200);
		return url;
	}
	return {
		client,
		receiver: server,
		store,
		setRevoked: () => {
			revoked = true;
		},
		assembly,
		directory,
		root,
		principal,
		target,
		scope,
		configuration,
		verifyGrant,
		signed,
		post,
		callback,
		calls,
		paths,
		fetch,
		setBehavior: (next: string) => {
			behavior = next;
		},
	};
}

async function deployment(f: Awaited<ReturnType<typeof fixture>>) {
	const file = join(f.directory, "oauth.json");
	await writeFile(file, JSON.stringify(f.configuration));
	return {
		environment: {
			AGENT_INFRA_RUNTIME_CONNECTION_OAUTH_FILE: file,
			AGENT_INFRA_RUNTIME_SANDBOX_ID: f.scope.sandboxId,
			AGENT_INFRA_RUNTIME_POD_UID: f.scope.podUid,
			AGENT_INFRA_RUNTIME_SESSION_GENERATION: "1",
			AGENT_INFRA_RUNTIME_PRINCIPAL: JSON.stringify({
				kind: "user",
				id: "alice",
			}),
		},
		dataDirectory: f.directory,
		store: f.store,
		target: f.target,
		key: publicKey,
		keyId: "fixture-key",
		issuer: "platform",
		workerId: "worker-a",
		agentId: "agent-a",
		serviceToken: "fixture-service",
	};
}

it("keeps OAuth unavailable when callback authentication material is absent", async () => {
	const f = await fixture();
	const options = await deployment(f);
	await rm(join(f.root, "tls", "callback.auth"));
	const prepared = await prepareRuntimeOAuth(options);
	if (prepared?.status === "available") closes.push(prepared.client.close);
	expect(prepared?.status).toBe("unavailable");
	expect(f.calls).toHaveLength(0);
});

it.each(["too-short", `${callbackServiceToken}\n`, "x".repeat(4097)])(
	"rejects malformed callback material without exposing it (%#)",
	async (material) => {
		const f = await fixture();
		const options = await deployment(f);
		await rm(join(f.root, "tls", "callback.auth"));
		await writeFile(join(f.root, "tls", "callback.auth"), material, {
			mode: 0o400,
		});
		const prepared = await prepareRuntimeOAuth(options);
		if (prepared?.status === "available") closes.push(prepared.client.close);
		expect(prepared?.status).toBe("unavailable");
		expect(JSON.stringify(prepared)).not.toContain(material);
		expect(f.calls).toHaveLength(0);
	},
);

it("rejects shared credentials during actual OAuth preparation", async () => {
	const f = await fixture();
	const options = await deployment(f);
	const prepared = await prepareRuntimeOAuth({
		...options,
		serviceToken: callbackServiceToken,
	});
	if (prepared?.status === "available") closes.push(prepared.client.close);
	expect(prepared?.status).toBe("unavailable");
	expect(f.calls).toHaveLength(0);
});

it("rejects unsafe callback file permissions before reading material", async () => {
	const f = await fixture();
	const options = await deployment(f);
	await chmod(join(f.root, "tls", "callback.auth"), 0o644);
	const prepared = await prepareRuntimeOAuth(options);
	if (prepared?.status === "available") closes.push(prepared.client.close);
	expect(prepared?.status).toBe("unavailable");
	expect(protection.secretReads).toBe(0);
});

it("stops callback material reads when protection is lost during its stat await", async () => {
	const f = await fixture();
	const options = await deployment(f);
	protection.afterSecretStat = (path) => {
		if (path.endsWith("callback.auth"))
			protection.check.mockImplementation(() => {
				throw Error("closed");
			});
	};
	const prepared = await prepareRuntimeOAuth(options);
	if (prepared?.status === "available") closes.push(prepared.client.close);
	expect(prepared?.status).toBe("unavailable");
	expect(protection.secretReads).toBe(0);
	expect(f.calls).toHaveLength(0);
});

it("requires callback-only authentication before accepting an original OAuth code", async () => {
	const f = await fixture();
	const begun = await f.post("begin", f.signed("begin"));
	expect(begun.status).toBe(200);
	const url = new URL(String(begun.body.authorizationUrl));
	const body = {
		schemaVersion: 1,
		state: url.searchParams.get("state"),
		issuer: f.configuration.issuer,
		code: "synthetic-authorization-code",
	};
	expect(
		(
			await f.post("callback", body, {
				authorization: "Bearer fixture-service",
			})
		).status,
	).toBe(503);
	expect(
		(
			await f.post("callback", body, {
				authorization: `Bearer ${callbackServiceToken}`,
			})
		).body.phase,
	).toBe("awaiting_confirmation");
	expect(f.calls).toHaveLength(0);
});

it.each(["begin", "confirm", "status"] as const)(
	"refuses callback-only authentication on the %s command",
	async (command) => {
		const f = await fixture();
		const denied = await f.post(command, f.signed(command), {
			authorization: `Bearer ${callbackServiceToken}`,
		});
		expect(denied.status).toBe(503);
		expect(JSON.stringify(denied.body)).not.toContain(callbackServiceToken);
		expect((await f.post("begin", f.signed("begin"))).status).toBe(200);
		expect(f.calls).toHaveLength(0);
	},
);

it.each(["turns", "stops", "status"])(
	"refuses callback-only authentication on the ordinary %s route",
	async (route) => {
		const app = createRuntimeHostApp({
			host: {} as never,
			serviceToken: "fixture-service",
			verifyGrant: () => {
				throw Error("Not used");
			},
		});
		const result = await app.request(`/internal/runtime/v1/${route}`, {
			method: "POST",
			headers: { authorization: `Bearer ${callbackServiceToken}` },
			body: "{}",
		});
		expect(result.status).toBe(401);
		expect(await result.json()).toMatchObject({
			code: "RUNTIME_SERVICE_UNAUTHORIZED",
		});
	},
);

it("keeps the business listener available when callback and Worker credentials are shared", async () => {
	const f = await fixture();
	f.receiver.closeAllConnections();
	await new Promise<void>((resolve) => f.receiver.close(() => resolve()));
	const server = startRuntimeHost({
		oauth: f.assembly,
		port: 0,
		serviceToken: callbackServiceToken,
		host: {} as never,
		verifyGrant: () => {
			throw Error("Not used");
		},
		log: () => undefined,
	});
	closes.push(() => closeRuntimeHost(server, async () => undefined));
	await new Promise<void>((resolve) =>
		server.listening ? resolve() : server.once("listening", resolve),
	);
	const response = await globalThis.fetch(
		`http://localhost:${(server.address() as AddressInfo).port}/healthz`,
	);
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ status: "ok" });
	expect(f.calls).toHaveLength(0);
});

it("uses real HTTPS/SDK/files for one exchange and keeps received credentials unverified", async () => {
	const f = await fixture();
	const url = await f.callback();
	expect(f.calls).toHaveLength(0);
	const result = await f.post("confirm", f.signed("confirm"));
	expect(result.status).toBe(200);
	expect(result.body.phase).toBe("awaiting_verification");
	expect(f.calls).toHaveLength(1);
	expect(f.calls[0]?.get("code_challenge")).toBeNull();
	expect(
		createHash("sha256")
			.update(f.calls[0]?.get("code_verifier") ?? "")
			.digest("base64url"),
	).toBe(url.searchParams.get("code_challenge"));
	expect(f.calls[0]?.get("resource")).toBe(f.target.url);
	expect(f.calls[0]?.get("client_id")).toBe("fixture-client");
	const again = await f.post("confirm", f.signed("confirm"));
	expect(again.body.phase).toBe("awaiting_verification");
	expect(f.calls).toHaveLength(1);
	const materials = await readdir(join(f.root, "materials"));
	expect(materials.some((name) => name.endsWith(".access"))).toBe(true);
	expect(materials.some((name) => name.endsWith(".refresh"))).toBe(true);
	for (const name of (await readdir(join(f.root, "records"))).filter((name) =>
		name.endsWith(".json"),
	)) {
		const record = await readFile(join(f.root, "records", name), "utf8");
		expect(record).not.toContain(access);
		expect(record).not.toContain(refresh);
		expect(record).not.toContain("synthetic-authorization-code");
	}
	expect(JSON.stringify(result)).not.toContain(access);
	expect(JSON.stringify(result)).not.toContain(refresh);
	await expect(
		readdir(
			join(
				f.directory,
				"codex-driver.json.native",
				"conversations",
				"standard-mcp-input",
			),
		),
	).rejects.toMatchObject({ code: "ENOENT" });
	await f.assembly.client.close();
	expect(
		(await readdir(join(f.root, "materials"))).filter((name) =>
			/\.(access|refresh)$/.test(name),
		),
	).toHaveLength(2);
});

it("revokes and removes protected token material exactly once on explicit revoke", async () => {
	const f = await fixture();
	await f.callback();
	expect((await f.post("confirm", f.signed("confirm"))).body.phase).toBe(
		"awaiting_verification",
	);
	const before = f.calls.length;
	expect(
		(await readdir(join(f.root, "records"))).filter((name) =>
			/^[a-f0-9]{64}\.json$/.test(name),
		),
	).toHaveLength(1);
	await f.assembly.client.revoke();
	const revocations = f.calls.slice(before);
	expect(f.paths.slice(before)).toEqual(["/oauth/revoke", "/oauth/revoke"]);
	expect(revocations).toHaveLength(2);
	expect(new Set(revocations.map((body) => body.get("token")))).toEqual(
		new Set([access, refresh]),
	);
	expect(revocations.map((body) => body.get("token_type_hint")).sort()).toEqual(
		["access_token", "refresh_token"],
	);
	expect(
		(await readdir(join(f.root, "materials"))).filter((name) =>
			/\.(access|refresh)$/.test(name),
		),
	).toEqual([]);
	await f.assembly.client.revoke();
	expect(f.calls).toHaveLength(before + 2);
});

it("rejects a non-HTTPS revocation endpoint before sending material", async () => {
	const f = await fixture();
	let requests = 0;
	await expect(
		revokeStandardOAuthToken({
			configuration: {
				...f.configuration,
				revocationEndpoint: "http://connection.invalid/oauth/revoke",
			},
			token: access,
			tokenTypeHint: "access_token",
			signal: new AbortController().signal,
			assertCurrent: () => undefined,
			fetch: async () => {
				requests++;
				return new Response(null, { status: 200 });
			},
		}),
	).rejects.toThrow();
	expect(requests).toBe(0);
});

it("does not revoke a foreign principal in the shared material tree", async () => {
	const f = await fixture();
	await f.callback();
	expect((await f.post("confirm", f.signed("confirm"))).body.phase).toBe(
		"awaiting_verification",
	);
	const records = join(f.root, "records");
	const materials = join(f.root, "materials");
	const sourceName = (await readdir(records)).find((name) =>
		/^[a-f0-9]{64}\.json$/.test(name),
	);
	expect(sourceName).toBeDefined();
	const baseRecord = JSON.parse(
		await readFile(join(records, sourceName as string), "utf8"),
	) as Record<string, unknown>;
	const addForeign = async (
		suffix: string,
		token: string,
		principal = { kind: "user", id: "alice" },
		scopePatch: Record<string, unknown> = {},
	) => {
		const foreign = structuredClone(baseRecord);
		foreign.principal = principal;
		foreign.authorizationId = `foreign-${suffix}`;
		foreign.scope = { ...f.scope, ...scopePatch };
		const agentId =
			typeof scopePatch.agentId === "string"
				? scopePatch.agentId
				: f.scope.agentId;
		const foreignKey = createHash("sha256")
			.update(
				JSON.stringify([
					standardMcpInstallationKey(principal, agentId, f.target),
					foreign.authorizationId,
				]),
			)
			.digest("hex");
		await writeFile(
			join(records, `${foreignKey}.json`),
			JSON.stringify(foreign),
			{ mode: 0o600 },
		);
		await writeFile(join(materials, `${foreignKey}.access`), token, {
			mode: 0o400,
		});
		return { foreignKey, token };
	};
	const foreignPrincipal = await addForeign(
		"principal",
		"synthetic-foreign-principal",
		{ kind: "user", id: "bob" },
	);
	const foreignAgent = await addForeign(
		"agent",
		"synthetic-foreign-agent",
		{ kind: "user", id: "alice" },
		{ agentId: "agent-b" },
	);
	const foreignConsumer = await addForeign(
		"consumer",
		"synthetic-foreign-consumer",
		{ kind: "user", id: "alice" },
		{ configFingerprint: "a".repeat(64) },
	);
	await f.assembly.client.revoke();
	const tokens = f.calls.map((body) => body.get("token"));
	expect(tokens).toEqual(expect.arrayContaining([access, refresh]));
	for (const foreign of [foreignPrincipal, foreignAgent, foreignConsumer]) {
		expect(tokens).not.toContain(foreign.token);
		expect(
			await readFile(join(materials, `${foreign.foreignKey}.access`), "utf8"),
		).toBe(foreign.token);
	}
});

it("retains protected material when remote revocation is unknown", async () => {
	const f = await fixture();
	await f.callback();
	expect((await f.post("confirm", f.signed("confirm"))).body.phase).toBe(
		"awaiting_verification",
	);
	f.setBehavior("redirect");
	await expect(f.assembly.client.revoke()).rejects.toThrow();
	expect(
		(await readdir(join(f.root, "materials"))).filter((name) =>
			/\.(access|refresh)$/.test(name),
		),
	).toHaveLength(2);
});

it("does not delete a replacement token after revoking the original bytes", async () => {
	const f = await fixture();
	await f.callback();
	expect((await f.post("confirm", f.signed("confirm"))).body.phase).toBe(
		"awaiting_verification",
	);
	f.setBehavior("replace-during-revoke");
	await expect(f.assembly.client.revoke()).rejects.toThrow();
	const accessName = (await readdir(join(f.root, "materials"))).find((name) =>
		name.endsWith(".access"),
	);
	expect(accessName).toBeDefined();
	expect(
		await readFile(join(f.root, "materials", accessName as string), "utf8"),
	).toBe("replacement-access-material");
});

it("does not send material from a replaced directory", async () => {
	const f = await fixture();
	await f.callback();
	expect((await f.post("confirm", f.signed("confirm"))).body.phase).toBe(
		"awaiting_verification",
	);
	const materials = join(f.root, "materials");
	const displaced = join(f.root, "materials.displaced");
	let moved = false;
	protection.afterSecretStat = (path) => {
		if (!moved && path.endsWith(".access")) {
			moved = true;
			renameSync(materials, displaced);
			mkdirSync(materials, { mode: 0o700 });
			writeFileSync(
				join(materials, "replacement.access"),
				"replacement-directory-access",
			);
			chmodSync(join(materials, "replacement.access"), 0o400);
		}
	};
	await expect(f.assembly.client.revoke()).rejects.toThrow();
	expect(
		f.calls.every(
			(body) => body.get("token") !== "replacement-directory-access",
		),
	).toBe(true);
	expect(
		(await readdir(displaced)).filter((name) =>
			/\.(access|refresh)$/.test(name),
		),
	).toHaveLength(2);
});

it("recovers begin after the verifier was published before the transaction record", async () => {
	const f = await fixture();
	protection.failRecordWrite = true;
	expect((await f.post("begin", f.signed("begin"))).status).toBe(503);
	const recovered = await f.post("begin", f.signed("begin"));
	expect(recovered.status).toBe(200);
	expect(recovered.body.phase).toBe("awaiting_callback");
	expect(recovered.body.authorizationUrl).toContain("state=");
});

it("preserves unknown after its transaction expiry", async () => {
	const f = await fixture();
	await f.callback();
	f.setBehavior("lost");
	expect((await f.post("confirm", f.signed("confirm"))).body.phase).toBe(
		"unknown",
	);
	const recordName = (await readdir(join(f.root, "records"))).find(
		(name) => name.endsWith(".json") && !name.startsWith("current-"),
	);
	expect(recordName).toBeDefined();
	const recordPath = join(f.root, "records", recordName as string);
	const record = JSON.parse(await readFile(recordPath, "utf8")) as {
		expiresAt: number;
	};
	record.expiresAt = 1;
	await writeFile(recordPath, JSON.stringify(record));
	const status = await f.post("status", f.signed("status"));
	expect(status.status).toBe(200);
	expect(status.body.phase).toBe("unknown");
});

it("round-trips a contract-valid opaque authorization id", async () => {
	const f = await fixture();
	const authorizationId = "authorization/含义/01";
	const begun = await f.post("begin", f.signed("begin", {}, authorizationId));
	expect(begun.status).toBe(200);
	const state = new URL(String(begun.body.authorizationUrl)).searchParams.get(
		"state",
	);
	expect(
		(
			await f.post("callback", {
				schemaVersion: 1,
				state,
				issuer: f.configuration.issuer,
				code: "synthetic-authorization-code",
			})
		).status,
	).toBe(200);
	const status = await f.post(
		"status",
		f.signed("status", {}, authorizationId),
	);
	expect(status.status).toBe(200);
	expect(status.body.authorizationId).toBe(authorizationId);
});

it.each([
	{ principal: { kind: "user" as const, id: "bob" } },
	{ principal: { kind: "application" as const, id: "app-a" } },
	{ workerId: "worker-b" },
	{ agentId: "agent-b" },
	{ sandboxId: "sandbox-b" },
	{ podUid: "pod-b" },
	{ sessionGeneration: 2 },
	{ issuer: "foreign" },
	{ audience: "foreign" },
	{ source: { ref: "foreign", revision: "r1" } },
	{ oauthConfiguration: { ref: "fixture-oauth", revision: "r2" } },
	{ expiresAt: 1 },
	{ purpose: "business" },
	{ requestDigest: "0".repeat(64) },
])(
	"rejects signed foreign identity/scope/purpose before token I/O: %j",
	async (patch) => {
		const f = await fixture();
		const result = await f.post(
			"begin",
			f.signed("begin", patch as Partial<RuntimeOAuthGrantClaimsV1>),
		);
		expect(result.status).toBe(403);
		expect(f.calls).toHaveLength(0);
	},
);

it("rejects callback replay and wrong issuer/state without exchanging", async () => {
	const f = await fixture();
	const begun = await f.post("begin", f.signed("begin"));
	const body = {
		schemaVersion: 1,
		state: new URL(String(begun.body.authorizationUrl)).searchParams.get(
			"state",
		),
		issuer: f.configuration.issuer,
		code: "synthetic-authorization-code",
	};
	expect(
		(await f.post("callback", { ...body, issuer: "https://foreign.invalid/" }))
			.status,
	).toBe(503);
	expect(
		(await f.post("callback", { ...body, state: "a".repeat(64) })).status,
	).toBe(503);
	expect((await f.post("callback", body)).status).toBe(200);
	expect((await f.post("callback", body)).status).toBe(503);
	expect(f.calls).toHaveLength(0);
});

it.each(["lost", "redirect"])(
	"keeps %s response unknown and does not exchange again after reopening",
	async (behavior) => {
		const f = await fixture();
		await f.callback();
		f.setBehavior(behavior);
		expect((await f.post("confirm", f.signed("confirm"))).body.phase).toBe(
			"unknown",
		);
		expect((await f.post("confirm", f.signed("confirm"))).body.phase).toBe(
			"unknown",
		);
		expect(f.calls).toHaveLength(1);
		const reopened = await createProtectedRuntimeOAuthClient({
			dataDirectory: f.directory,
			store: f.store,
			configuration: f.configuration,
			target: f.target,
			principal: f.principal,
			scope: f.scope,
			verifyGrant: f.verifyGrant,
			fetch: f.fetch,
		});
		closes.push(reopened.close);
		expect((await reopened.authorized(f.signed("confirm"))).phase).toBe(
			"unknown",
		);
		expect(f.calls).toHaveLength(1);
	},
);

it("rejects HTTPS URLs and forwarded headers on the ordinary HTTP surface", async () => {
	const f = await fixture();
	const app = createRuntimeOAuthApp(f.assembly, "fixture-service");
	expect(
		(
			await app.request(
				`${f.assembly.runtimeOrigin}/internal/runtime/oauth/v1/begin`,
				{
					method: "POST",
					headers: {
						authorization: "Bearer fixture-service",
						"x-forwarded-proto": "https",
					},
					body: JSON.stringify(f.signed("begin")),
				},
			)
		).status,
	).toBe(503);
	const ordinary = createRuntimeHostApp({
		host: {} as never,
		serviceToken: "fixture-service",
		verifyGrant: () => {
			throw Error("Not called");
		},
	});
	const response = await ordinary.request(
		"https://runtime.invalid/internal/runtime/oauth/v1/callback",
		{
			method: "POST",
			headers: {
				authorization: "Bearer fixture-service",
				"x-forwarded-proto": "https",
			},
			body: "synthetic-authorization-code",
		},
	);
	expect(response.status).toBe(503);
	expect(f.calls).toHaveLength(0);
});

it("closes admission before secret I/O when protection changes", async () => {
	const f = await fixture();
	await f.callback();
	protection.check.mockImplementation(() => {
		throw Error("closed");
	});
	expect((await f.post("confirm", f.signed("confirm"))).status).toBe(503);
	expect(f.calls).toHaveLength(0);
});

it("prepares the actual private TLS/config boundary and rejects foreign or incomplete deployment", async () => {
	const f = await fixture();
	const options = await deployment(f);
	const { environment } = options;
	const file = environment.AGENT_INFRA_RUNTIME_CONNECTION_OAUTH_FILE;
	const prepared = await prepareRuntimeOAuth(options);
	expect(prepared?.status).toBe("available");
	if (prepared?.status === "available") {
		closes.push(prepared.client.close);
		f.receiver.closeAllConnections();
		await new Promise<void>((resolve) => f.receiver.close(() => resolve()));
		const server = startRuntimeHost({
			oauth: prepared,
			port: 0,
			serviceToken: "fixture-service",
			host: {} as never,
			verifyGrant: () => {
				throw Error("Not used");
			},
			log: () => undefined,
		});
		closes.push(() => closeRuntimeHost(server, prepared.client.close));
		await new Promise<void>((resolve) =>
			server.listening ? resolve() : server.once("listening", resolve),
		);
		await f.callback();
		expect((await f.post("status", f.signed("status"))).body.phase).toBe(
			"awaiting_confirmation",
		);
		expect(f.calls).toHaveLength(0);
	}
	expect(
		await prepareRuntimeOAuth({ ...options, environment: {} }),
	).toBeUndefined();
	expect(
		await prepareRuntimeOAuth({
			...options,
			environment: { ...environment, AGENT_INFRA_RUNTIME_POD_UID: undefined },
		}),
	).toEqual({ status: "unavailable" });
	await writeFile(
		file,
		JSON.stringify({
			...f.configuration,
			tokenEndpoint: "https://foreign.invalid/token",
		}),
	);
	expect(await prepareRuntimeOAuth(options)).toEqual({ status: "unavailable" });
});

it("rechecks protection after the real token response before publishing any material", async () => {
	const f = await fixture();
	await f.callback();
	f.setBehavior("protection-lost");
	expect((await f.post("confirm", f.signed("confirm"))).status).toBe(503);
	expect(f.calls).toHaveLength(1);
	const names = await readdir(join(f.root, "materials"));
	expect(
		names.some((name) => name.endsWith(".access") || name.endsWith(".refresh")),
	).toBe(false);
});

it("rejects a wrong service token, unknown input fields and body tampering before exchange", async () => {
	const f = await fixture();
	const signed = f.signed("begin");
	expect(
		(await f.post("begin", signed, { authorization: "Bearer foreign-service" }))
			.status,
	).toBe(503);
	expect(
		(await f.post("begin", { ...signed, clientId: "caller-client" })).status,
	).toBe(503);
	expect(
		(
			await f.post("begin", {
				...signed,
				authorizationId: "foreign-transaction",
			})
		).status,
	).toBe(403);
	expect(f.calls).toHaveLength(0);
});

it("rejects an unexpired signed confirm when the original current authority is revoked", async () => {
	const f = await fixture();
	await f.callback();
	const request = f.signed("confirm");
	f.setRevoked();
	expect((await f.post("confirm", request)).status).toBe(503);
	expect(f.calls).toHaveLength(0);
});

it.each(["clientId", "callbackUrl", "tokenEndpoint"] as const)(
	"refuses %s drift under the same config ref/revision before secret reads",
	async (field) => {
		const f = await fixture();
		await f.callback();
		const configuration = {
			...f.configuration,
			[field]:
				field === "clientId"
					? "changed-client"
					: "https://changed.invalid/changed",
		};
		const reopened = await createProtectedRuntimeOAuthClient({
			dataDirectory: f.directory,
			configuration,
			target: f.target,
			principal: f.principal,
			scope: f.scope,
			verifyGrant: f.verifyGrant,
			store: f.store,
			fetch: f.fetch,
		});
		closes.push(reopened.close);
		await expect(reopened.authorized(f.signed("confirm"))).rejects.toThrow();
		expect(f.calls).toHaveLength(0);
	},
);

it("rejects an OAuth port conflict while the real business listener remains available", async () => {
	const f = await fixture();
	f.receiver.closeAllConnections();
	await new Promise<void>((resolve) => f.receiver.close(() => resolve()));
	const server = startRuntimeHost({
		oauth: f.assembly,
		port: f.assembly.port,
		serviceToken: "fixture-service",
		host: {} as never,
		verifyGrant: () => {
			throw Error("Not used");
		},
		log: () => undefined,
	});
	await new Promise<void>((resolve) =>
		server.listening ? resolve() : server.once("listening", resolve),
	);
	try {
		const http = await import("node:http");
		const body = await new Promise<string>((resolve, reject) => {
			http
				.get(
					`http://localhost:${f.assembly.port}/healthz`,
					{ family: 4 },
					(res) => {
						let body = "";
						res.on("data", (chunk) => {
							body += chunk;
						});
						res.on("end", () => resolve(body));
					},
				)
				.on("error", reject);
		});
		expect(JSON.parse(body).status).toBe("ok");
	} finally {
		await closeRuntimeHost(server, async () => undefined);
	}
});

it("rechecks original revocation after a real token response before publishing credentials", async () => {
	const f = await fixture();
	await f.callback();
	f.setBehavior("revoke-after-token");
	expect((await f.post("confirm", f.signed("confirm"))).body.phase).toBe(
		"unknown",
	);
	expect(f.calls).toHaveLength(1);
	const names = await readdir(join(f.root, "materials"));
	expect(
		names.some((name) => name.endsWith(".access") || name.endsWith(".refresh")),
	).toBe(false);
});

it.each(["code", "access"] as const)(
	"stops real secret %s I/O when original revocation commits during its stat await",
	async (kind) => {
		const f = await fixture();
		await f.callback();
		const beforeReads = protection.secretReads;
		const beforeWrites = protection.secretWrites;
		protection.afterSecretStat = (path) => {
			if (path.endsWith(`.${kind}`)) f.setRevoked();
		};
		const result = await f.post("confirm", f.signed("confirm"));
		if (kind === "code") {
			expect(result.status).toBe(503);
			expect(protection.secretReads).toBe(beforeReads);
			expect(f.calls).toHaveLength(0);
		} else {
			expect(result.body.phase).toBe("unknown");
			expect(protection.secretWrites).toBe(beforeWrites);
			expect(f.calls).toHaveLength(1);
		}
	},
);
