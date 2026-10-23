import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import type { RuntimeBusinessRequestV4 } from "@agent-infra/contracts/runtime";
import { FakeObjectStorageV1 } from "@agent-infra/object-storage";
import type { OperationalEvent } from "@agent-infra/observability";
import {
	type CurrentTaskUserV1,
	sessionSandboxFileExchangeTokenV1,
} from "@agent-infra/platform-core";
import {
	configureStoreQueryObservability,
	migratePlatformDatabase,
} from "@agent-infra/platform-store";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentConfigurationConformanceRecordV1 } from "../../../packages/platform-core/src/agent-configuration.conformance.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.ts";
import { markSessionSandboxReadyFixture } from "../../../packages/platform-store/src/session-sandbox.fixture.js";
import { createRuntimeFileBridgeFactoryV1 } from "../../agent-runtime-host/src/runtime-file-exchange.ts";
import { workloadDesiredFixture } from "../../platform-worker/src/kubernetes.fixture.js";
import { createWorkerRuntimeGrantSignerV4 } from "../../platform-worker/src/runtime-grant-signer-v4.ts";
import { assemblePlatformApi, type PlatformApiAssembly } from "./assembly.js";
import { createDeploymentIdentityScope } from "./deployment-identity.js";
import { createDeploymentPresentation } from "./deployment-presentation.js";
import type { PlatformFileDeploymentV1 } from "./file-assembly.js";
import type { IdentityAdapter, IdentityContext } from "./http/identity.js";
import {
	platformApiStoreQueryObservabilityV1,
	startPlatformApi,
} from "./index.js";

/**
 * #3307：Runtime 文件交换按生产装配联测。与 tests/file-authority.test.ts 不同，这里不替换
 * 会话授权、文件限制读取或 Agent 展示：它们都来自 `assemblePlatformApi` 与部署展示，浏览器
 * 身份只来自 Cookie（Runtime 请求没有浏览器会话），V4 Grant 由 Worker 的生产签名器签发，
 * Sandbox 凭据按 Platform DB 当前分配派生，执行状态复现 Worker 派发前的 write-ahead `unknown`。
 * 受控的只有目录身份、对象存储（Fake）与 Worker 的派发写入（按 Store 语义用 SQL 复现）。
 */
const connectDatabase = createRequire(
	import.meta.resolve("@agent-infra/platform-store"),
)("postgres") as typeof postgres;

const configuration = {
	...agentConfigurationConformanceRecordV1,
	schemaVersion: 1 as const,
	actions: [],
	actionSetRevision: "actions_1",
};
const agentId = configuration.agentId;
const identity: IdentityContext = {
	schemaVersion: 1,
	userId: "user_3307",
	displayName: "Runtime exchange user",
	accountStatus: "active",
	organizationIds: ["org_3307"],
	roles: ["employee"],
	authorizationRevision: "authorization_3307",
};
const currentUser: CurrentTaskUserV1 = {
	schemaVersion: 1,
	userId: identity.userId,
	accountStatus: "active",
	organizationIds: ["org_3307"],
	authorizationRevision: "directory_3307",
};
const cookie = "fixture-session=user_3307";
// 浏览器身份只来自会话 Cookie；Runtime 发来的执行期请求没有 Cookie。
const adapter: IdentityAdapter = {
	async resolve(request) {
		return request.headers.get("Cookie") === cookie ? identity : null;
	},
	async hydrateUsers() {
		return [];
	},
	async resolveUser(userId) {
		return userId === identity.userId ? currentUser : null;
	},
};
const unavailable = async (): Promise<never> => {
	throw new Error("Unexpected admission call");
};
// 哨兵值：部署登记 token 与 Worker 签名身份都只用于本测试。
const deploymentToken = "synthetic-deployment-file-service-token-3307";
const runtimeIssuer = "platform-runtime-3307";
const runtimeWorkerId = "main-local-worker";
const runtimeKeys = generateKeyPairSync("ed25519");
const fileKeys = generateKeyPairSync("ed25519");
const signer = createWorkerRuntimeGrantSignerV4({
	issuer: runtimeIssuer,
	workerId: runtimeWorkerId,
	keyId: "runtime-key-3307",
	privateKey: runtimeKeys.privateKey,
});

let database: PostgresTestDatabase;
let db: postgres.Sql;
let assembly: PlatformApiAssembly;
let server: ReturnType<typeof startPlatformApi>;
let origin: string;
const events: OperationalEvent[] = [];
const logs: string[] = [];

async function browser(
	method: string,
	path: string,
	body?: unknown,
	headers: Record<string, string> = {},
) {
	return fetch(`${origin}${path}`, {
		method,
		headers: {
			Cookie: cookie,
			...(body === undefined ? {} : { "content-type": "application/json" }),
			...headers,
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

async function seedAgent() {
	await db.unsafe("truncate platform.agents, platform.conversations cascade");
	await db.unsafe("truncate platform.relay_key_subjects cascade");
	await db.unsafe(
		"truncate platform.outbox_items, platform.idempotency_records, platform.audit_events, platform.file_limit_declarations",
	);
	await db.unsafe(
		"insert into platform.relay_key_subjects(purpose,subject_id,last_version,current_version) values('personal',$1,1,1)",
		[identity.userId],
	);
	await db.unsafe(
		"insert into platform.relay_key_versions(purpose,subject_id,key_version,key_id,ciphertext) values('personal',$1,1,'controlled-personal-key',$2::text::jsonb)",
		[
			identity.userId,
			JSON.stringify({
				schemaVersion: 1,
				purpose: "personal",
				subjectId: identity.userId,
				keyId: "controlled-personal-key",
				keyVersion: 1,
			}),
		],
	);
	await db.unsafe(
		"insert into platform.agents(id,current_configuration_revision,authorization_revision) values($1,$2,'authorization_3307')",
		[agentId, configuration.revision],
	);
	await db.unsafe(
		"insert into platform.agent_applications(id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,management_revision,approval_revision,service_availability,desired_state,workload_revision,fence) values('application_3307',$1,'owner_3307','Agent','Runtime exchange','available','trace_seed','request_seed',now(),11,1,'ready','running',1,1)",
		[agentId],
	);
	await db.unsafe(
		"insert into platform.agent_configuration_revisions(agent_id,revision,source_reference,created_at,configuration) values($1,$2,'template_01',now(),$3::text::jsonb)",
		[agentId, configuration.revision, JSON.stringify(configuration)],
	);
	await db.unsafe(
		"insert into platform.agent_owners(agent_id,owner_id,created_at) values($1,'owner_3307',now())",
		[agentId],
	);
	await db.unsafe(
		"insert into platform.agent_availability(agent_id,target_type,target_id) values($1,'organization','org_3307')",
		[agentId],
	);
	const deploymentBase = workloadDesiredFixture(1, agentId, "internal-only");
	const deployment = {
		...deploymentBase,
		configRevision: configuration.revision,
		imageDigest: configuration.source.imageDigest,
		registryAdmission: {
			...deploymentBase.registryAdmission,
			immutableDigest: configuration.source.imageDigest,
			policyEvidence: {
				...deploymentBase.registryAdmission.policyEvidence,
				imageDigest: configuration.source.imageDigest,
			},
		},
	};
	const runtimeVersion = { configuration, deployment };
	// Worker 已验证并持久化的能力：附件与结果文件都开启。
	await db.unsafe(
		"insert into platform.workload_reconciliations(agent_id,revision,state,next_attempt_at) values($1,1,$2::text::jsonb,now())",
		[
			agentId,
			JSON.stringify({
				schemaVersion: 1,
				agentId,
				sourceConfigurationRevision: configuration.revision,
				sourceLifecycleRevision: 1,
				revision: 1,
				fence: 1,
				phase: "ready",
				candidate: runtimeVersion,
				verified: runtimeVersion,
				verifiedRevision: 1,
				identity: { uid: "runtime-exchange-3307", generation: 1 },
				rollback: false,
				failureCode: null,
				attempts: 0,
				capabilities: {
					supplementaryInstruction: false,
					attachments: true,
					resultFiles: true,
				},
			}),
		],
	);
	await insertLimit("deployment", "", "");
	await insertLimit("agent", agentId, "");
	await insertLimit("channel", agentId, "web");
}

async function insertLimit(scope: string, agent: string, channel: string) {
	await db.unsafe(
		`insert into platform.file_limit_declarations
			(scope, agent_id, channel_id, revision, expires_at, max_bytes, media_types,
			 idempotency_key, request_digest, updated_at, updated_by)
		values ($1, $2, $3, 1, now() + interval '7 days', 1048576, '["text/plain"]'::jsonb,
			$4, $5, now(), 'owner_3307')`,
		[
			scope,
			agent,
			channel,
			`limits-${scope}`,
			createHash("sha256").update(scope).digest("hex"),
		],
	);
}

const descriptor = (name: string, value: Buffer) => ({
	name,
	mediaType: "text/plain",
	sizeBytes: value.length,
	sha256: createHash("sha256").update(value).digest("hex"),
});

/** Web 上传一个可用附件（浏览器会话、生产会话授权与限制）。 */
async function uploadAttachment(conversationId: string, name: string) {
	const value = Buffer.from(`attachment ${name} for #3307`);
	const created = await browser(
		"POST",
		`/api/v1/conversations/${conversationId}/files`,
		{ schemaVersion: 1, descriptor: descriptor(`${name}.txt`, value) },
		{ "Idempotency-Key": `${name}-intent` },
	);
	expect(created.status, await created.clone().text()).toBe(201);
	const file = (await created.json()) as { fileId: string };
	const access = (await (
		await browser(
			"POST",
			`/api/v1/conversations/${conversationId}/files/${file.fileId}/access`,
			{ schemaVersion: 1, operation: "write" },
			{ "Idempotency-Key": `${name}-write` },
		)
	).json()) as {
		accessId: string;
		path: string;
		grant: { token: string };
	};
	const put = await fetch(`${origin}${access.path}`, {
		method: "PUT",
		headers: {
			Cookie: cookie,
			"Content-Type": "text/plain",
			"Content-Length": String(value.length),
			"X-Platform-File-Grant": access.grant.token,
		},
		body: value,
	});
	expect(put.status).toBe(204);
	const complete = await browser(
		"POST",
		`/api/v1/conversations/${conversationId}/files/${file.fileId}/complete`,
		{ schemaVersion: 1, accessId: access.accessId },
		{
			"Idempotency-Key": `${name}-complete`,
			"X-Platform-File-Grant": access.grant.token,
		},
	);
	expect(complete.status).toBe(200);
	return { fileId: file.fileId, value };
}

/**
 * 一条带附件的 Web 消息，加上 Worker 的派发事实：claim 让 Execution fence 前进，
 * prepareRuntimeDispatch 在调用 Runtime 之前把状态 write-ahead 为 `unknown`
 * （packages/platform-store/src/conversation-dispatch.ts）。Grant 由生产签名器签发。
 */
async function dispatchedTurn(name: string) {
	const created = await browser(
		"POST",
		`/api/v1/agents/${agentId}/conversations`,
		{ schemaVersion: 1 },
		{ "Idempotency-Key": `${name}-conversation` },
	);
	expect(created.status).toBe(201);
	const { conversationId } = (await created.json()) as {
		conversationId: string;
	};
	await markSessionSandboxReadyFixture(db, conversationId);
	// Worker 准备 Sandbox 时写入的资源策略带 namespace；fixture Workload 没有执行容量证据，
	// 这里只补上 namespace（与 tests/file-authority.test.ts 相同）。
	await db`update platform.session_sandbox_allocations
		set resource_policy = coalesce(resource_policy, '{}'::jsonb) || jsonb_build_object('namespace', 'fixture-sandboxes')
		where conversation_id = ${conversationId}`;
	const attachment = await uploadAttachment(conversationId, `${name}-input`);
	const other = await uploadAttachment(conversationId, `${name}-other`);
	const message = await browser(
		"POST",
		`/api/v1/conversations/${conversationId}/messages`,
		{
			schemaVersion: 1,
			text: "please read the attachment",
			attachments: [attachment.fileId],
		},
		{ "Idempotency-Key": `${name}-message` },
	);
	expect(message.status, await message.clone().text()).toBe(202);
	const { executionId } = (await message.json()) as { executionId: string };
	const [execution] = await db<
		{
			turn_id: string;
			session_generation: string;
			delivery_fence: string;
			sandbox_id: string | null;
			model_option_id: string;
			reasoning_level: string;
		}[]
	>`update platform.conversation_executions
		set delivery_fence = delivery_fence + 1, status = 'unknown',
			runtime_submit_protocol = 'v4', original_operation_digest = ${"d".repeat(43)},
			updated_at = clock_timestamp()
		where execution_id = ${executionId} and status = 'submitted'
		returning turn_id, session_generation, delivery_fence, sandbox_id,
			model_option_id, reasoning_level`;
	if (!execution) throw new Error("Missing dispatched execution");
	expect(execution.sandbox_id).not.toBeNull();
	const [record] = await db<{ id: string }[]>`
		select id from platform.task_authorization_records where execution_id = ${executionId}`;
	if (!record) throw new Error("Missing task authorization record");
	const fence = Number(execution.delivery_fence);
	const unsigned = {
		schemaVersion: 4,
		requestId: randomUUID(),
		traceId: `trace-${name}`,
		principal: { kind: "user", id: identity.userId },
		executionSource: "web",
		channelId: "web",
		agentId,
		conversationId,
		executionId,
		turnId: execution.turn_id,
		sessionGeneration: Number(execution.session_generation),
		hostSessionRef: null,
		operation: {
			kind: "execution",
			id: executionId,
			deliveryFence: fence,
			executionDeliveryFence: fence,
		},
		keyBinding: {
			purpose: "personal",
			subjectId: identity.userId,
			ciphertextRef: "controlled-personal-key",
			version: 1,
		},
		input: {
			text: "please read the attachment",
			attachments: [attachment.fileId],
		},
		selection: {
			schemaVersion: 1,
			modelOptionId: execution.model_option_id,
			reasoningLevel: execution.reasoning_level,
		},
		grant: {
			schemaVersion: 4,
			format: "runtime-execution-jws",
			token: "unsigned.unsigned.unsigned",
		},
	} as RuntimeBusinessRequestV4;
	const grant = signer.sign(unsigned, record.id);
	const [allocation] = await db<
		{
			sandbox_id: string;
			session_generation: string;
			resource_fence: string;
			namespace: string;
		}[]
	>`select sandbox_id, session_generation, resource_fence,
		resource_policy->>'namespace' as namespace
		from platform.session_sandbox_allocations where sandbox_id = ${execution.sandbox_id}`;
	if (!allocation) throw new Error("Missing Sandbox allocation");
	expect(allocation).toMatchObject({ namespace: expect.any(String) });
	// Worker 写入 Sandbox Secret 的派生凭据（#3276）：部署 token 本身不进入 Sandbox。
	const sandboxToken = sessionSandboxFileExchangeTokenV1(deploymentToken, {
		namespace: allocation.namespace,
		sandboxId: allocation.sandbox_id,
		generation: Number(allocation.session_generation),
		resourceFence: Number(allocation.resource_fence),
	});
	const claims = JSON.parse(
		Buffer.from(grant.token.split(".")[1] ?? "", "base64url").toString("utf8"),
	) as { grantId: string; expiresAt: number };
	return {
		conversationId,
		executionId,
		attachment,
		other,
		grant,
		claims,
		sandboxToken,
		recordId: record.id,
		sandboxId: allocation.sandbox_id,
		sessionGeneration: Number(execution.session_generation),
	};
}

type Turn = Awaited<ReturnType<typeof dispatchedTurn>>;

function hostBridge(turn: Turn, diagnostics: unknown[] = []) {
	const target = new URL(origin);
	return createRuntimeFileBridgeFactoryV1({
		// Runtime Host 的明文 origin 必须是 DNS 名称；测试 fetch 把它解析回本地监听地址。
		origin: `http://platform-api.runtime-exchange.test:${target.port}`,
		serviceToken: turn.sandboxToken,
		fetch: (input, init) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			url.host = target.host;
			return fetch(
				input instanceof Request ? new Request(url, input) : url,
				init,
			);
		},
		logDiagnostic: (entry) => diagnostics.push(entry),
	})(
		{
			actorId: identity.userId,
			channelId: "web",
			agentId,
			conversationId: turn.conversationId,
			executionId: turn.executionId,
			sessionGeneration: turn.sessionGeneration,
			grantId: turn.claims.grantId,
			expiresAt: turn.claims.expiresAt,
			inputFileIds: [turn.attachment.fileId],
		},
		{ executionGrant: turn.grant },
	);
}

async function bytesOf(stream: ReadableStream<Uint8Array>) {
	return Buffer.from(await new Response(stream).arrayBuffer());
}

describe("Runtime file exchange over the production API assembly, HTTP and PostgreSQL (#3307)", () => {
	beforeAll(async () => {
		database = await startPostgresTestDatabase("3307-runtime-exchange");
		await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
		db = connectDatabase(database.databaseUrl, { max: 2, onnotice: () => {} });
		const observability = {
			record: (event: OperationalEvent) => events.push(event),
			status: () => ({}),
		};
		// 与 startPlatformApiFromDeployment 相同的 Store 查询观测。
		configureStoreQueryObservability({
			observability: platformApiStoreQueryObservabilityV1(observability),
		});
		const identityScope = createDeploymentIdentityScope(adapter);
		const files: PlatformFileDeploymentV1 = {
			storage: new FakeObjectStorageV1(),
			issuer: "platform-files-3307",
			keyVersion: "file-key-3307",
			privateKey: fileKeys.privateKey,
			publicKeys: new Map([["file-key-3307", fileKeys.publicKey]]),
			runtimeIssuer,
			runtimeWorkerId,
			runtimePublicKeys: new Map([["runtime-key-3307", runtimeKeys.publicKey]]),
			intentTtlMs: 60_000,
			accessTtlMs: 30_000,
			maxConcurrentTransfers: 4,
			services: [{ token: deploymentToken, agentIds: [agentId] }],
			resolveActor: async (actorId) =>
				actorId === identity.userId ? identity : null,
		};
		assembly = assemblePlatformApi({
			taskAdmissionPolicy: {
				maximumWaitingTasksPerAgent: 2,
				waitingTimeoutMs: 60_000,
			},
			databaseUrl: database.databaseUrl,
			identity: adapter,
			requestScope: identityScope.requestScope,
			admissions: {
				authorizationAdmission: { authorize: unavailable },
				imageAdmission: { admitImage: unavailable },
				modelAdmission: { admitModels: unavailable },
				secretAdmission: { admitSecrets: unavailable },
				channelAdmission: { admitChannels: unavailable },
			},
			allocateApplicationIds: unavailable,
			prepareApplicationSecrets: unavailable,
			prepareConfigurationSecrets: unavailable,
			// 生产部署展示：浏览器身份按当前请求解析。
			presentAgent: {
				create: ({ configurationQuery }) =>
					createDeploymentPresentation({
						identityScope,
						configurationQuery,
						resourceProfile: {
							profileId: "small",
							displayName: "Small",
							estimatedResources: {
								cpuMillicores: 100,
								memoryMiB: 128,
								storageGiB: 1,
							},
						},
						imageRepository: "registry.example.test/agents",
					}),
			},
			files,
		});
		server = startPlatformApi({
			dependencies: assembly.dependencies,
			observability: observability as unknown as Parameters<
				typeof startPlatformApi
			>[0]["observability"],
			log: (line: unknown) => logs.push(String(line)),
			port: 0,
		});
		await new Promise<void>((resolve) =>
			server.listening ? resolve() : server.once("listening", resolve),
		);
		origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		await seedAgent();
	}, 120_000);
	afterAll(async () => {
		configureStoreQueryObservability(undefined);
		if (server)
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		await assembly?.close();
		await db?.end();
		await database?.stop();
	});

	it("AC-1: reads a Web attachment while the dispatch is write-ahead unknown, then writes a result, with a Worker-signed V4 Grant and the Sandbox-derived credential", async () => {
		const turn = await dispatchedTurn("ac1");
		const diagnostics: unknown[] = [];
		const bridge = hostBridge(turn, diagnostics);
		// Codex Driver 在原生 Turn 受理之前读取附件：此时执行仍是 write-ahead unknown。
		const input = await bridge.readInput(turn.attachment.fileId);
		expect(input.descriptor.sha256).toBe(
			createHash("sha256").update(turn.attachment.value).digest("hex"),
		);
		expect(await bytesOf(input.body)).toEqual(turn.attachment.value);
		const [readAccess] = await db<{ count: number }[]>`
			select count(*)::int as count from platform.file_accesses
			where file_id = ${turn.attachment.fileId} and operation = 'read'
				and record->'execution'->>'executionId' = ${turn.executionId}`;
		expect(readAccess?.count).toBe(1);
		// Runtime 受理后 Worker 记录 processing；结果写入沿用同一 Grant。
		await db`update platform.conversation_executions set status = 'processing'
			where execution_id = ${turn.executionId}`;
		const result = Buffer.from("result file for #3307");
		const receipt = await bridge.writeResult(
			descriptor("result.txt", result),
			new Response(result).body as ReadableStream<Uint8Array>,
		);
		expect(receipt.projection).toMatchObject({
			kind: "result",
			status: "available",
			descriptor: descriptor("result.txt", result),
		});
		const [stored] = await db<{ kind: string; status: string }[]>`
			select record->>'kind' as kind, record->>'status' as status
			from platform.files where file_id = ${receipt.projection.fileId}`;
		expect(stored).toEqual({ kind: "result", status: "available" });
		expect(diagnostics).toEqual([]);
	}, 60_000);
});
