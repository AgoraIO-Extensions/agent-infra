import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { createPlatformHealthApp } from "../apps/platform-api/src/app.ts";
import { assemblePlatformFilesV1 } from "../apps/platform-api/src/file-assembly.ts";
import { registerFileRoutesV1 } from "../apps/platform-api/src/http/file-routes.ts";
import { createWorkerFileClientV1 } from "../apps/platform-worker/src/file-client.ts";
import { createPlatformFileReconciliationWorkerV1 } from "../apps/platform-worker/src/file-worker.ts";
import {
	FileAccessResponseV1Schema,
	FileProjectionV1Schema,
} from "../packages/contracts/src/files.ts";
import { startMinioFileFixtureV1 } from "../packages/object-storage/src/minio.test-support.ts";
import { migratePlatformDatabase } from "../packages/platform-store/src/migrate.ts";
import { startPostgresTestDatabase } from "../packages/platform-store/src/postgres-test.ts";

const requireApi = createRequire(
	new URL("../apps/platform-api/package.json", import.meta.url),
);
const { serve } = requireApi(
	"@hono/node-server",
) as typeof import("../apps/platform-api/node_modules/@hono/node-server");
const requireStore = createRequire(
	new URL("../packages/platform-store/package.json", import.meta.url),
);
const postgres = requireStore(
	"postgres",
) as typeof import("../packages/platform-store/node_modules/postgres").default;

it("runs authenticated upload, history and execution results over real HTTP, PostgreSQL and versioned S3", async () => {
	const db = await startPostgresTestDatabase("442-data-plane");
	const fixture = await startMinioFileFixtureV1();
	const sql = postgres(db.databaseUrl);
	let assembled: ReturnType<typeof assemblePlatformFilesV1> | undefined;
	let server: ReturnType<typeof serve> | undefined;
	try {
		await migratePlatformDatabase(db);
		await sql`insert into platform.conversations (id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision) values ('conversation','agent','alice','web','active',1,'auth')`;
		await sql`insert into platform.conversation_executions (execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,delivery_fence,authorization_revision,created_at,updated_at) values ('execution','conversation','agent','alice','web','turn','processing',1,1,'auth',now(),now())`;
		const keys = generateKeyPairSync("ed25519");
		const limits = {
			revision: "test-limits-v1",
			expiresAt: "2099-01-01T00:00:00Z",
			maxBytes: 1024,
			mediaTypes: ["text/plain"],
		};
		const serviceToken = "synthetic-file-service-442-123456789";
		let revoked = false;
		const actor = (userId: string) => ({
			schemaVersion: 1 as const,
			userId,
			displayName: userId,
			accountStatus: "active" as const,
			organizationIds: ["org"],
			roles: ["employee" as const],
			authorizationRevision: "auth",
		});
		assembled = assemblePlatformFilesV1({
			databaseUrl: db.databaseUrl,
			identity: {
				resolve: async (request) =>
					actor(request.headers.get("test-user") ?? "anonymous"),
				hydrateUsers: async () => [],
			},
			deployment: {
				storage: fixture.storage,
				issuer: "files",
				keyVersion: "file-key",
				privateKey: keys.privateKey,
				publicKeys: new Map([["file-key", keys.publicKey]]),
				runtimeIssuer: "runtime",
				runtimePublicKeys: new Map([["runtime-key", keys.publicKey]]),
				intentTtlMs: 60000,
				accessTtlMs: 2000,
				maxConcurrentTransfers: 2,
				services: [
					{ token: serviceToken, agentIds: ["agent"], component: "worker" },
				],
				resolveActor: async (id) => actor(id),
				readLimits: async () => ({
					configurationRevision: 1,
					declarations: { agent: limits, channel: limits, deployment: limits },
				}),
			},
			readCurrentLimits: async () => ({
				agent: limits,
				channel: limits,
				deployment: limits,
			}),
			conversationAuthorization: {
				authorize: async (identity) =>
					revoked || identity.userId !== "alice"
						? { outcome: "denied" }
						: {
								outcome: "allowed",
								authority: {
									schemaVersion: 1,
									actorId: "alice",
									agentId: "agent",
									channelId: "web",
									authorizationRevision: "auth",
									supportsSupplementaryInstruction: false,
								},
							},
			},
		});
		const app = createPlatformHealthApp();
		registerFileRoutesV1(app, assembled.dependencies);
		server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
		if (!server.listening) await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("Missing HTTP fixture");
		const origin = `http://127.0.0.1:${address.port}`;
		const bytes = Buffer.from("bounded file acceptance");
		const descriptor = {
			name: "fixture.txt",
			mediaType: "text/plain",
			sizeBytes: bytes.length,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		};
		const headers = {
			"test-user": "alice",
			"Content-Type": "application/json",
			"Idempotency-Key": "intent",
		};
		const post = (path: string, body: unknown, extra = {}) =>
			fetch(origin + path, {
				method: "POST",
				headers: { ...headers, ...extra },
				body: JSON.stringify(body),
			});
		const root = "/api/v1/conversations/conversation/files";
		const file = FileProjectionV1Schema.parse(
			await (await post(root, { schemaVersion: 1, descriptor })).json(),
		);
		const access = FileAccessResponseV1Schema.parse(
			await (
				await post(`${root}/${file.fileId}/access`, {
					schemaVersion: 1,
					operation: "write",
				})
			).json(),
		);
		expect(access.path).not.toContain("http");
		const writeHeaders = {
			"test-user": "alice",
			"Content-Type": descriptor.mediaType,
			"Content-Length": String(bytes.length),
			"X-Platform-File-Grant": access.grant.token,
		};
		expect(
			(
				await fetch(origin + access.path, {
					method: "PUT",
					headers: { ...writeHeaders, "test-user": "bob" },
					body: bytes,
				})
			).status,
		).toBe(404);
		expect(
			(
				await fetch(origin + access.path, {
					method: "PUT",
					headers: writeHeaders,
					body: bytes,
				})
			).status,
		).toBe(204);
		expect(
			(
				await post(
					`${root}/${file.fileId}/complete`,
					{ schemaVersion: 1, accessId: access.accessId },
					{ "X-Platform-File-Grant": access.grant.token },
				)
			).status,
		).toBe(200);
		const read = FileAccessResponseV1Schema.parse(
			await (
				await post(`${root}/${file.fileId}/access`, {
					schemaVersion: 1,
					operation: "read",
				})
			).json(),
		);
		const readHeaders = {
			"test-user": "alice",
			"X-Platform-File-Grant": read.grant.token,
		};
		expect(
			Buffer.from(
				await (
					await fetch(origin + read.path, { headers: readHeaders })
				).arrayBuffer(),
			),
		).toEqual(bytes);
		expect(
			(
				await fetch(origin + read.path, {
					headers: { ...readHeaders, "test-user": "bob" },
				})
			).status,
		).toBe(404);
		revoked = true;
		expect(
			(await fetch(origin + read.path, { headers: readHeaders })).status,
		).toBe(404);
		revoked = false;
		await new Promise((resolve) => setTimeout(resolve, 2100));
		expect(
			(await fetch(origin + read.path, { headers: readHeaders })).status,
		).toBe(404);
		const claims = {
			schemaVersion: 1,
			issuer: "runtime",
			audience: ["runtime_host"],
			issuedAt: new Date(Date.now() - 1000).toISOString(),
			expiresAt: new Date(Date.now() + 60000).toISOString(),
			grantId: "grant",
			actorId: "alice",
			agentId: "agent",
			channelId: "web",
			conversationId: "conversation",
			executionId: "execution",
			turnId: "turn",
			sessionGeneration: 1,
			allowedCommands: ["turn.submit"],
			attachments: [],
			actionSetVersion: "none",
			actionIds: [],
			traceId: "trace",
		};
		const signingInput = `${Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "runtime-key" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
		const grant = {
			schemaVersion: 1 as const,
			format: "compact-jws" as const,
			token: `${signingInput}.${sign(null, Buffer.from(signingInput), keys.privateKey).toString("base64url")}`,
		};
		const worker = createWorkerFileClientV1({
			origin,
			serviceToken,
			timeoutMs: 10000,
		});
		const body = () =>
			new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(bytes);
					c.close();
				},
			});
		const result = await worker.writeResult(
			grant,
			descriptor,
			body(),
			"result-intent",
		);
		expect(result.kind).toBe("result");
		expect(
			(await worker.writeResult(grant, descriptor, body(), "result-intent"))
				.fileId,
		).toBe(result.fileId);
		await expect(
			worker.readInput(grant, file.fileId, "undeclared-input"),
		).rejects.toThrow("File read unavailable");
		await sql`insert into platform.conversation_messages (message_id,conversation_id,actor_id,role,text,execution_id,status,created_at,updated_at) values ('message','conversation','alice','user','bounded fixture','execution','submitted',now(),now())`;
		await sql`update platform.files set record = record || ${sql.json({ messageId: "message", executionId: "execution", sessionGeneration: 1 })}::jsonb where file_id = ${file.fileId}`;
		const inputClaims = {
			...claims,
			grantId: "input-grant",
			attachments: [{ attachmentId: file.fileId, operations: ["read"] }],
		};
		const inputData = `${Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "runtime-key" })).toString("base64url")}.${Buffer.from(JSON.stringify(inputClaims)).toString("base64url")}`;
		const inputGrant = {
			...grant,
			token: `${inputData}.${sign(null, Buffer.from(inputData), keys.privateKey).toString("base64url")}`,
		};
		expect(
			Buffer.from(
				await new Response(
					await worker.readInput(inputGrant, file.fileId, "input-read"),
				).arrayBuffer(),
			),
		).toEqual(bytes);
		expect((await sql`select file_id from platform.files`).length).toBe(2);
		await sql`update platform.conversations set session_generation = 2 where id = 'conversation'`;
		await expect(
			worker.writeResult(grant, descriptor, body(), "late-result"),
		).rejects.toThrow("File write unavailable");
		const orphan = randomUUID();
		await fixture.storage.upload({
			objectRef: orphan,
			descriptor,
			body: body(),
			expiresAt: new Date(Date.now() + 10000).toISOString(),
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		const cleanup = createPlatformFileReconciliationWorkerV1({
			databaseUrl: db.databaseUrl,
			storage: fixture.storage,
			batchSize: 100,
			orphanGraceMs: 1,
		});
		try {
			await cleanup.runOnce();
			expect(await fixture.storage.inspect(orphan)).toBeNull();
			expect((await fixture.storage.scan(null, 100)).objects).toHaveLength(2);
		} finally {
			await cleanup.close();
		}
	} finally {
		if (server) {
			const running = server;
			running.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				running.close((error) => (error ? reject(error) : resolve())),
			);
		}
		await assembled?.close();
		await sql.end();
		await fixture.close();
		await db.stop();
	}
}, 120000);
