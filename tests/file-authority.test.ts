import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { createPlatformHealthApp } from "../apps/platform-api/src/app.ts";
import { assemblePlatformFilesV1 } from "../apps/platform-api/src/file-assembly.ts";
import { registerConversationRoutes } from "../apps/platform-api/src/http/conversation-routes.ts";
import { registerFileRoutesV1 } from "../apps/platform-api/src/http/file-routes.ts";
import {
	createWorkerFileClientV1,
	createWorkerRuntimeFileBridgeFactoryV1,
} from "../apps/platform-worker/src/file-client.ts";
import { createPlatformFileReconciliationWorkerV1 } from "../apps/platform-worker/src/file-worker.ts";
import type { RuntimeFileBridgeBindingV1 } from "../packages/agent-runtime/src/runtime-file-bridge.ts";
import {
	FileAccessResponseV1Schema,
	FileProjectionV1Schema,
} from "../packages/contracts/src/files.ts";
import { startMinioFileFixtureV1 } from "../packages/object-storage/src/minio.test-support.ts";
import { createConversationExecutionUseCaseV1 } from "../packages/platform-core/src/conversation-execution.ts";
import { PostgresConversationExecutionTransactionV1 } from "../packages/platform-store/src/conversation-execution.ts";
import { migratePlatformDatabase } from "../packages/platform-store/src/migrate.ts";
import { startPostgresTestDatabase } from "../packages/platform-store/src/postgres-test.ts";
import { seedSessionSandboxFixture } from "../packages/platform-store/src/session-sandbox.fixture.ts";

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

function requireFixtureValue<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new Error(`Missing fixture value: ${label}`);
	return value;
}

it("runs authenticated upload, history and execution results over real HTTP, PostgreSQL and versioned S3", async () => {
	const db = await startPostgresTestDatabase("442-data-plane");
	const fixture = await startMinioFileFixtureV1();
	const sql = postgres(db.databaseUrl);
	let assembled: ReturnType<typeof assemblePlatformFilesV1> | undefined;
	let server: ReturnType<typeof serve> | undefined;
	const transaction = new PostgresConversationExecutionTransactionV1({
		databaseUrl: db.databaseUrl,
	});
	try {
		await migratePlatformDatabase(db);
		await sql`insert into platform.conversations (id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision) values ('conversation','agent','alice','web','active',1,'auth')`;
		await sql`insert into platform.conversation_executions (execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,delivery_fence,authorization_revision,created_at,updated_at) values ('execution','conversation','agent','alice','web','turn','processing',1,1,'auth',now(),now())`;
		await seedSessionSandboxFixture(sql, "conversation");
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
				services: [{ token: serviceToken, agentIds: ["agent"] }],
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
		const authority = {
			schemaVersion: 1 as const,
			actorId: "alice",
			agentId: "agent",
			channelId: "web",
			authorizationRevision: "auth",
			supportsSupplementaryInstruction: false,
		};
		const authorization = {
			authorize: async () => ({ outcome: "allowed" as const, authority }),
		};
		const commands = createConversationExecutionUseCaseV1({
			authorization,
			transaction,
		});
		registerConversationRoutes(app, {
			identity: {
				resolve: async () => actor("alice"),
				hydrateUsers: async () => [],
			},
			authorization,
			commands: () => commands,
			files: assembled.dependencies,
			query: {
				list: async () => {
					throw new Error("Unexpected query");
				},
				get: async () => undefined,
				getExecution: async () => undefined,
				replay: async () => undefined,
			},
		});
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
		await sql`update platform.conversation_executions set status = 'completed' where execution_id = 'execution'`;
		const messageBody = {
			schemaVersion: 1,
			text: "bounded fixture",
			attachments: [file.fileId],
		};
		const messagePath = "/api/v1/conversations/conversation/messages";
		const first = await post(messagePath, messageBody, {
			"Idempotency-Key": "message-input",
		});
		expect(first.status).toBe(202);
		const accepted = await first.json();
		const retry = await post(messagePath, messageBody, {
			"Idempotency-Key": "message-input",
		});
		expect(retry.status).toBe(202);
		expect(await retry.json()).toEqual(accepted);
		expect(
			await sql`select message_id from platform.conversation_messages where role = 'user'`,
		).toHaveLength(1);
		const [bound] =
			await sql`select record from platform.files where file_id = ${file.fileId}`;
		expect(bound?.record.messageId).toBe(accepted.messageId);
		expect(bound?.record.executionId).toBe(accepted.executionId);
		const [inputExecution] =
			await sql`select turn_id from platform.conversation_executions where execution_id = ${accepted.executionId}`;
		const inputClaims = {
			...claims,
			executionId: accepted.executionId,
			turnId: inputExecution?.turn_id,
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
		const orphanMetadata = (await fixture.storage.scan(null, 100)).objects.find(
			(object) => object.objectRef === orphan,
		);
		if (!orphanMetadata) throw new Error("Missing orphan metadata");
		const graceWaitMs = Math.max(
			0,
			Date.parse(orphanMetadata.createdAt) + 10 - Date.now(),
		);
		expect(graceWaitMs).toBeLessThan(5000);
		await new Promise((resolve) => setTimeout(resolve, graceWaitMs));
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
		await transaction.close();
		await assembled?.close();
		await sql.end();
		await fixture.close();
		await db.stop();
	}
}, 120000);

it("keeps Runtime File Bridge data and grants isolated across two real sessions", async () => {
	const db = await startPostgresTestDatabase("2054-file-bridge");
	const fixture = await startMinioFileFixtureV1();
	const sql = postgres(db.databaseUrl);
	let assembled: ReturnType<typeof assemblePlatformFilesV1> | undefined;
	let server: ReturnType<typeof serve> | undefined;
	const transaction = new PostgresConversationExecutionTransactionV1({
		databaseUrl: db.databaseUrl,
	});
	const serviceToken = "synthetic-file-service-2054-123456789";
	const keys = generateKeyPairSync("ed25519");
	const limits = {
		revision: "test-limits-v1",
		expiresAt: "2099-01-01T00:00:00Z",
		maxBytes: 1024,
		mediaTypes: ["text/plain"],
	};
	const sessions = {
		first: {
			conversationId: "conversation-first",
			executionId: "execution-first",
			actorId: "alice",
			grantId: "grant-first",
		},
		second: {
			conversationId: "conversation-second",
			executionId: "execution-second",
			actorId: "bob",
			grantId: "grant-second",
		},
	} as const;
	const revoked = new Set<string>();
	const executionBindings = new Map<
		string,
		RuntimeFileBridgeBindingV1 & { readonly turnId: string }
	>();
	const actor = (userId: string) => ({
		schemaVersion: 1 as const,
		userId,
		displayName: userId,
		accountStatus: "active" as const,
		organizationIds: ["org"],
		roles: ["employee" as const],
		authorizationRevision: "auth",
	});
	const sessionForConversation = (conversationId: string) =>
		Object.values(sessions).find(
			(session) => session.conversationId === conversationId,
		);
	const sessionForActor = (actorId: string) =>
		Object.values(sessions).find((session) => session.actorId === actorId);
	const authorityFor = (session: (typeof sessions)[keyof typeof sessions]) => ({
		schemaVersion: 1 as const,
		actorId: session.actorId,
		agentId: "agent",
		channelId: "web",
		authorizationRevision: "auth",
		supportsSupplementaryInstruction: false,
	});
	try {
		await migratePlatformDatabase(db);
		for (const session of Object.values(sessions)) {
			await sql`insert into platform.conversations (id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision) values (${session.conversationId},'agent',${session.actorId},'web','active',1,'auth')`;
			await sql`insert into platform.conversation_executions (execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,delivery_fence,authorization_revision,created_at,updated_at) values (${session.executionId},${session.conversationId},'agent',${session.actorId},'web',${`${session.executionId}-turn`},'processing',1,1,'auth',now(),now())`;
			await seedSessionSandboxFixture(sql, session.conversationId);
		}
		const assemblyInput: Parameters<typeof assemblePlatformFilesV1>[0] = {
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
				services: [{ token: serviceToken, agentIds: ["agent"] }],
				resolveActor: async (id) => actor(id),
				readLimits: async () => ({
					configurationRevision: 1,
					declarations: {
						agent: limits,
						channel: limits,
						deployment: limits,
					},
				}),
			},
			readCurrentLimits: async () => ({
				agent: limits,
				channel: limits,
				deployment: limits,
			}),
			conversationAuthorization: {
				authorize: async (identity, input) => {
					const session = input.conversationId
						? sessionForConversation(input.conversationId)
						: sessionForActor(identity.userId);
					if (
						!session ||
						identity.userId !== session.actorId ||
						revoked.has(session.actorId)
					)
						return { outcome: "denied" as const };
					return {
						outcome: "allowed" as const,
						authority: authorityFor(session),
					};
				},
			},
		};
		assembled = assemblePlatformFilesV1(assemblyInput);
		let app = createPlatformHealthApp();
		const runtimeExchange = {
			async authenticate(
				request: Request,
				value: import("../packages/contracts/src/files.ts").RuntimeFileExchangeRequestV1,
			) {
				if (request.headers.get("Authorization") !== `Bearer ${serviceToken}`) {
					throw new Error("service identity denied");
				}
				const expected = executionBindings.get(value.executionId);
				if (!expected) {
					throw new Error("execution binding denied");
				}
				const same =
					value.actorId === expected.actorId &&
					value.agentId === expected.agentId &&
					value.channelId === expected.channelId &&
					value.conversationId === expected.conversationId &&
					value.executionId === expected.executionId &&
					value.sessionGeneration === expected.sessionGeneration &&
					value.grantId === expected.grantId &&
					value.expiresAt === new Date(expected.expiresAt).toISOString();
				if (!same || revoked.has(expected.actorId)) {
					throw new Error("execution binding denied");
				}
				const [conversation] = await sql`
					select actor_id, agent_id, channel_id, session_generation
					from platform.conversations where id = ${expected.conversationId}
				`;
				if (
					!conversation ||
					conversation.actor_id !== expected.actorId ||
					conversation.agent_id !== expected.agentId ||
					conversation.channel_id !== expected.channelId ||
					Number(conversation.session_generation) !== expected.sessionGeneration
				) {
					throw new Error("stale execution binding");
				}
				const expectedSession = sessionForConversation(expected.conversationId);
				if (!expectedSession) {
					throw new Error("execution session denied");
				}
				const authority = {
					async authorize(conversationId: string, operation: "read" | "write") {
						if (conversationId !== expected.conversationId) return null;
						return {
							...authorityFor(expectedSession),
							conversationId: expected.conversationId,
							limits,
							execution: {
								executionId: expected.executionId,
								sessionGeneration: expected.sessionGeneration,
								grantId: expected.grantId,
								attachments:
									operation === "read" &&
									value.operation === "read" &&
									value.fileId
										? [value.fileId]
										: [],
								expiresAt: new Date(expected.expiresAt).toISOString(),
							},
						};
					},
				};
				return {
					conversationId: expected.conversationId,
					authorization: authority,
				};
			},
		};
		registerFileRoutesV1(app, {
			...assembled.dependencies,
			runtimeExchange,
		});
		const authorization = {
			authorize: async (input: { conversationId?: string }) => {
				const session = input.conversationId
					? sessionForConversation(input.conversationId)
					: undefined;
				if (!session || revoked.has(session.actorId))
					return { outcome: "denied" as const };
				return {
					outcome: "allowed" as const,
					authority: authorityFor(session),
				};
			},
		};
		registerConversationRoutes(app, {
			identity: {
				resolve: async (request) =>
					actor(request.headers.get("test-user") ?? "anonymous"),
				hydrateUsers: async () => [],
			},
			authorization,
			commands: () =>
				createConversationExecutionUseCaseV1({
					authorization,
					transaction,
				}),
			files: assembled.dependencies,
			query: {
				list: async () => ({ items: [], nextCursor: null }),
				get: async () => undefined,
				getExecution: async () => undefined,
				replay: async () => undefined,
			},
		});
		server = serve({
			fetch: (request) => app.fetch(request),
			hostname: "127.0.0.1",
			port: 0,
		});
		if (!server.listening) await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("Missing HTTP fixture");
		const origin = `http://127.0.0.1:${address.port}`;
		const httpsOrigin = "https://runtime-files.test";
		const bytes = {
			first: Buffer.from("first session input"),
			second: Buffer.from("second session input"),
		};
		const descriptor = (name: string, value: Buffer) => ({
			name,
			mediaType: "text/plain",
			sizeBytes: value.length,
			sha256: createHash("sha256").update(value).digest("hex"),
		});
		const post = (
			session: (typeof sessions)[keyof typeof sessions],
			path: string,
			body: unknown,
			extra: Record<string, string> = {},
		) =>
			fetch(origin + path, {
				method: "POST",
				headers: {
					"test-user": session.actorId,
					"Content-Type": "application/json",
					...extra,
				},
				body: JSON.stringify(body),
			});
		const uploaded = new Map<
			string,
			ReturnType<typeof FileProjectionV1Schema.parse>
		>();
		const readAccess = new Map<
			string,
			ReturnType<typeof FileAccessResponseV1Schema.parse>
		>();
		for (const [name, session] of Object.entries(sessions) as [
			keyof typeof sessions,
			(typeof sessions)[keyof typeof sessions],
		][]) {
			const value = bytes[name];
			const file = FileProjectionV1Schema.parse(
				await (
					await post(
						session,
						`/api/v1/conversations/${session.conversationId}/files`,
						{ schemaVersion: 1, descriptor: descriptor(`${name}.txt`, value) },
						{ "Idempotency-Key": `${name}-intent` },
					)
				).json(),
			);
			uploaded.set(name, file);
			const access = FileAccessResponseV1Schema.parse(
				await (
					await post(
						session,
						`/api/v1/conversations/${session.conversationId}/files/${file.fileId}/access`,
						{ schemaVersion: 1, operation: "write" },
						{ "Idempotency-Key": `${name}-write-access` },
					)
				).json(),
			);
			const put = await fetch(origin + access.path, {
				method: "PUT",
				headers: {
					"test-user": session.actorId,
					"Content-Type": "text/plain",
					"Content-Length": String(value.length),
					"X-Platform-File-Grant": access.grant.token,
				},
				body: value,
			});
			expect(put.status).toBe(204);
			expect(
				(
					await post(
						session,
						`/api/v1/conversations/${session.conversationId}/files/${file.fileId}/complete`,
						{ schemaVersion: 1, accessId: access.accessId },
						{
							"Idempotency-Key": `${name}-complete`,
							"X-Platform-File-Grant": access.grant.token,
						},
					)
				).status,
			).toBe(200);
			await sql`update platform.conversation_executions set status = 'completed' where execution_id = ${session.executionId}`;
			const message = await post(
				session,
				`/api/v1/conversations/${session.conversationId}/messages`,
				{ schemaVersion: 1, text: `${name} input`, attachments: [file.fileId] },
				{ "Idempotency-Key": `${name}-message` },
			);
			expect(message.status).toBe(202);
			const accepted = (await message.json()) as { executionId: string };
			const [execution] =
				await sql`select turn_id, session_generation from platform.conversation_executions where execution_id = ${accepted.executionId}`;
			if (!execution) throw new Error(`Missing ${name} execution`);
			const binding = {
				actorId: session.actorId,
				agentId: "agent",
				channelId: "web",
				conversationId: session.conversationId,
				executionId: accepted.executionId,
				sessionGeneration: Number(execution.session_generation),
				grantId: session.grantId,
				expiresAt: Date.now() + 60000,
				inputFileIds: [file.fileId],
			} satisfies RuntimeFileBridgeBindingV1;
			executionBindings.set(accepted.executionId, {
				...binding,
				turnId: execution.turn_id,
			});
			const read = FileAccessResponseV1Schema.parse(
				await (
					await post(
						session,
						`/api/v1/conversations/${session.conversationId}/files/${file.fileId}/access`,
						{ schemaVersion: 1, operation: "read" },
						{ "Idempotency-Key": `${name}-read-access` },
					)
				).json(),
			);
			readAccess.set(name, read);
		}
		let loseCompleteReceipt = false;
		let lostResult: ReturnType<typeof FileProjectionV1Schema.parse> | undefined;
		let lostObject:
			| Awaited<ReturnType<typeof fixture.storage.inspect>>
			| undefined;
		let resultUploads = 0;
		const transfer = async (
			value: string | URL | Request,
			init?: RequestInit,
		) => {
			const url = new URL(
				typeof value === "string"
					? value
					: value instanceof URL
						? value.href
						: value.url,
			);
			if (url.origin === httpsOrigin) {
				url.protocol = "http:";
				url.hostname = "127.0.0.1";
				url.port = String(address.port);
			}
			const headers = new Headers(init?.headers);
			if (url.pathname.startsWith("/api/v1/conversations/"))
				headers.set("Authorization", `Bearer ${serviceToken}`);
			if (init?.method === "PUT") resultUploads += 1;
			const response = await fetch(url, { ...init, headers });
			if (
				loseCompleteReceipt &&
				url.pathname.endsWith("/complete") &&
				response.ok
			) {
				loseCompleteReceipt = false;
				lostResult = FileProjectionV1Schema.parse(
					await response.clone().json(),
				);
				const [persisted] =
					await sql`select record from platform.files where file_id = ${lostResult.fileId}`;
				expect(persisted?.record.status).toBe("available");
				lostObject = await fixture.storage.inspect(persisted.record.objectRef);
				expect(lostObject).not.toBeNull();
				// The real HTTP handler has committed. Drop its receipt at the client boundary.
				await response.body?.cancel();
				throw new Error("CONTROLLED_RESULT_RECEIPT_LOST");
			}
			return response;
		};
		const createBridgeFactory = () =>
			createWorkerRuntimeFileBridgeFactoryV1({
				origin: httpsOrigin,
				serviceToken,
				timeoutMs: 10000,
				fetch: transfer as typeof fetch,
			});
		let bridgeFactory = createBridgeFactory();
		const bindingFor = (name: keyof typeof sessions) => {
			const binding = [...executionBindings.values()].find(
				(value) => value.actorId === sessions[name].actorId,
			);
			if (!binding) throw new Error(`Missing ${name} binding`);
			const { turnId: _turnId, ...runtimeBinding } = binding;
			return runtimeBinding;
		};
		const consume = async (body: ReadableStream<Uint8Array>) =>
			Buffer.from(await new Response(body).arrayBuffer());
		for (const name of Object.keys(sessions) as (keyof typeof sessions)[]) {
			const bridge = bridgeFactory(bindingFor(name));
			const inputFile = requireFixtureValue(
				uploaded.get(name),
				`${name} input`,
			);
			const input = await bridge.readInput(inputFile.fileId);
			expect(await consume(input.body)).toEqual(bytes[name]);
			const resultBytes = Buffer.from(`${name} result`);
			const writeResult = () =>
				bridgeFactory(bindingFor(name)).writeResult(
					descriptor(`${name}-result.txt`, resultBytes),
					new ReadableStream({
						start(controller) {
							controller.enqueue(resultBytes);
							controller.close();
						},
					}),
				);
			if (name === "first") {
				loseCompleteReceipt = true;
				await expect(writeResult()).rejects.toThrow(
					"CONTROLLED_RESULT_RECEIPT_LOST",
				);
				expect(loseCompleteReceipt).toBe(false);
				const lostFile = requireFixtureValue(lostResult, "lost result receipt");
				expect(lostFile.status).toBe("available");
				const accesses =
					await sql`select * from platform.file_accesses where file_id = ${lostFile.fileId}`;
				await assembled.close();
				assembled = assemblePlatformFilesV1(assemblyInput);
				app = createPlatformHealthApp();
				registerFileRoutesV1(app, {
					...assembled.dependencies,
					runtimeExchange,
				});
				bridgeFactory = createBridgeFactory();
				expect(
					await sql`select * from platform.file_accesses where file_id = ${lostFile.fileId}`,
				).toEqual(accesses);
			}
			const uploadsBeforeReplay = resultUploads;
			const receipt = await writeResult();
			expect(receipt.projection.status).toBe("available");
			if (name === "first") {
				expect(receipt.projection.fileId).toBe(lostResult?.fileId);
				expect(resultUploads).toBe(uploadsBeforeReplay);
			}
			const [beforeReplay] =
				await sql`select record from platform.files where file_id = ${receipt.projection.fileId}`;
			const stored = await fixture.storage.inspect(
				beforeReplay.record.objectRef,
			);
			expect(stored).toMatchObject({
				version: beforeReplay.record.objectVersion,
				etag: beforeReplay.record.etag,
			});
			if (name === "first") expect(stored).toEqual(lostObject);
			const uploadsBeforeSecondReplay = resultUploads;
			expect((await writeResult()).projection.fileId).toBe(
				receipt.projection.fileId,
			);
			expect(resultUploads).toBe(uploadsBeforeSecondReplay);
			expect(
				await fixture.storage.inspect(beforeReplay.record.objectRef),
			).toEqual(stored);
			const resultRows =
				await sql`select record from platform.files where conversation_id = ${sessions[name].conversationId} and record->>'kind' = 'result'`;
			expect(resultRows).toHaveLength(1);
			expect(resultRows[0]?.record).toEqual(beforeReplay.record);
			const resultRead = FileAccessResponseV1Schema.parse(
				await (
					await post(
						sessions[name],
						`/api/v1/conversations/${sessions[name].conversationId}/files/${receipt.projection.fileId}/access`,
						{ schemaVersion: 1, operation: "read" },
						{ "Idempotency-Key": `${name}-result-read` },
					)
				).json(),
			);
			expect(
				Buffer.from(
					await (
						await fetch(origin + resultRead.path, {
							headers: {
								"test-user": sessions[name].actorId,
								"X-Platform-File-Grant": resultRead.grant.token,
							},
						})
					).arrayBuffer(),
				),
			).toEqual(resultBytes);
		}
		const firstFile = requireFixtureValue(uploaded.get("first"), "first file");
		const secondFile = requireFixtureValue(
			uploaded.get("second"),
			"second file",
		);
		const freshReadAccess = async (name: keyof typeof sessions) => {
			const session = sessions[name];
			const file = requireFixtureValue(uploaded.get(name), `${name} file`);
			const response = await post(
				session,
				`/api/v1/conversations/${session.conversationId}/files/${file.fileId}/access`,
				{ schemaVersion: 1, operation: "read" },
				{ "Idempotency-Key": `${name}-isolation-read-access` },
			);
			expect(response.status).toBe(200);
			const access = FileAccessResponseV1Schema.parse(await response.json());
			const control = await fetch(origin + access.path, {
				headers: {
					"test-user": session.actorId,
					"X-Platform-File-Grant": access.grant.token,
				},
			});
			expect(control.status).toBe(200);
			expect(Buffer.from(await control.arrayBuffer())).toEqual(bytes[name]);
			return access;
		};
		const firstRead = await freshReadAccess("first");
		const secondRead = await freshReadAccess("second");
		const firstReadPath = origin + firstRead.path;
		const secondReadPath = origin + secondRead.path;
		for (const deniedResponse of [
			await fetch(secondReadPath, {
				headers: {
					"test-user": sessions.second.actorId,
					"X-Platform-File-Grant": firstRead.grant.token,
				},
			}),
			await fetch(
				firstReadPath.replace(
					sessions.first.conversationId,
					sessions.second.conversationId,
				),
				{
					headers: {
						"test-user": sessions.second.actorId,
						"X-Platform-File-Grant": firstRead.grant.token,
					},
				},
			),
		]) {
			expect(deniedResponse.status).toBe(404);
			await deniedResponse.body?.cancel();
		}
		const isolationControl = await fetch(firstReadPath, {
			headers: {
				"test-user": sessions.first.actorId,
				"X-Platform-File-Grant": firstRead.grant.token,
			},
		});
		expect(isolationControl.status).toBe(200);
		expect(Buffer.from(await isolationControl.arrayBuffer())).toEqual(
			bytes.first,
		);
		const firstBinding = bindingFor("first");
		const deniedMutations: Array<
			[string, Partial<RuntimeFileBridgeBindingV1>]
		> = [
			["actor", { actorId: "bob" }],
			["agent", { agentId: "other-agent" }],
			["channel", { channelId: "other-channel" }],
			["conversation", { conversationId: sessions.second.conversationId }],
			["execution", { executionId: bindingFor("second").executionId }],
			["generation", { sessionGeneration: 2 }],
			["grant", { grantId: "grant-second" }],
		];
		for (const [label, change] of deniedMutations) {
			const mutated = { ...firstBinding, ...change };
			const bridge = bridgeFactory(mutated);
			await expect(bridge.readInput(firstFile.fileId)).rejects.toThrow();
			void label;
		}
		const crossFileBinding = {
			...firstBinding,
			inputFileIds: [secondFile.fileId],
		};
		await expect(
			bridgeFactory(crossFileBinding).readInput(secondFile.fileId),
		).rejects.toThrow();
		revoked.add(sessions.first.actorId);
		await expect(
			bridgeFactory(firstBinding).readInput(firstFile.fileId),
		).rejects.toThrow();
		revoked.delete(sessions.first.actorId);
		await sql`update platform.conversations set session_generation = 2 where id = ${sessions.first.conversationId}`;
		await expect(
			bridgeFactory(firstBinding).readInput(firstFile.fileId),
		).rejects.toThrow();
		const expired = { ...bindingFor("second"), expiresAt: Date.now() - 1 };
		await expect(
			bridgeFactory(expired).readInput(secondFile.fileId),
		).rejects.toThrow("WORKER_RUNTIME_FILE_BINDING_STALE");
	} finally {
		if (server) {
			const running = server;
			running.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				running.close((error) => (error ? reject(error) : resolve())),
			);
		}
		await transaction.close();
		await assembled?.close();
		await sql.end();
		await fixture.close();
		await db.stop();
	}
}, 120000);
