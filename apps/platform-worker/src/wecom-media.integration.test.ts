import { randomBytes } from "node:crypto";
import { FakeObjectStorageV1 } from "@agent-infra/object-storage";
import {
	createFileAuthorityV1,
	createWecomChannelV1,
	createWecomDeliveryV1,
	FileAuthorityError,
	type WecomAuthorizationPortV1,
	type WecomIdentityPortV1,
	type WecomMediaReferenceV1,
	type WecomMessageV1,
	type WecomSendPortV1,
	wecomChannelIdV1,
} from "@agent-infra/platform-core";
import {
	PostgresAgentConfigurationQueryV1,
	PostgresFileStoreV1,
	PostgresWecomChannelV1,
} from "@agent-infra/platform-store";
import { encryptWecomMediaFixtureV1 } from "@agent-infra/wecom/testing";
import { parseWecomAnswerReferencesV1 } from "@agent-infra/wecom/worker";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { migratePlatformDatabase } from "../../../packages/platform-store/src/migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import { completeWecomExecutionFixture } from "../../../packages/platform-store/src/wecom-receipt.fixture.js";
import { workloadDesiredFixture } from "./kubernetes.fixture.js";
import {
	createWecomAttachmentCapabilityReaderV1,
	createWecomInboundMediaResolverV1,
} from "./wecom-media.js";

// 真实 PostgreSQL、受理事务与 File Authority；企微下载由与 SDK 加密格式一致的替身提供（#3227）。
// 这不是固定环境的真实企微收发验收，那由 #3230 负责。
const SENTINEL_URL = "SENTINEL-DOWNLOAD-URL-3227";
const aesKey = randomBytes(32).toString("base64");
const userDirectory = {
	resolveUser: async (userId: string) => ({
		schemaVersion: 1 as const,
		userId,
		accountStatus: "active" as const,
		organizationIds: ["controlled-org"],
		authorizationRevision: "identity-1",
	}),
};
const identity: WecomIdentityPortV1 = {
	resolveSender: async (scope) => userDirectory.resolveUser(scope.senderId),
	activeUsers: async (ids) => ids,
};
const base: WecomMessageV1 = {
	providerId: "provider-1",
	agentId: "wecom_media_agent",
	bindingReference: "wecom_media_binding",
	kind: "wecom_bot",
	senderId: "sender_a",
	peerId: "sender_a",
	conversationType: "single",
	threadId: null,
	eventId: "event",
	text: "",
	replyHandle: "protected_fixture",
	replyExpiresAt: "2099-01-01T00:00:00Z",
};
const channelId = wecomChannelIdV1(base);
const authorization: WecomAuthorizationPortV1 = {
	async authorize(scope) {
		return {
			outcome: "allowed",
			authority: {
				managementRevision: 1,
				channelRevision: "channels_1",
				actor: {
					schemaVersion: 1,
					actorId: scope.senderId,
					agentId: scope.agentId,
					channelId: wecomChannelIdV1(scope),
					authorizationRevision: "authorization_1",
					supportsSupplementaryInstruction: false,
					taskBoundary: {
						schemaVersion: 1,
						principal: { kind: "user", id: scope.senderId },
						agentId: scope.agentId,
						channelId: wecomChannelIdV1(scope),
						identityRevision: "identity-1",
						agentAuthorizationRevision: "authorization_1",
						accessSources: [
							{ kind: "organization", organizationId: "controlled-org" },
						],
					},
				},
			},
		};
	},
};
const configuration = {
	schemaVersion: 1,
	agentId: base.agentId,
	revision: 1,
	source: {
		kind: "standard",
		templateId: "codex",
		imageDigest: `sha256:${"a".repeat(64)}`,
		admissionRevision: "admitted",
		allowedEnvironmentKeys: [],
		allowedSecretKeys: [],
		platformManagedKeys: [],
		connectionEnabled: false,
	},
	modelConfiguration: {
		catalogRevision: "catalog_1",
		options: [
			{
				optionId: "model_1",
				endpointId: "endpoint_1",
				modelId: "model_1",
				reasoningLevels: ["low"],
				credential: { secretId: "fixture_secret", version: 1, isSet: true },
			},
		],
		defaultOptionId: "model_1",
		defaultReasoningLevel: "low",
	},
	actions: [],
	actionSetRevision: "actions_1",
	environment: [],
	secrets: [],
	channels: [{ kind: base.kind, bindingReference: base.bindingReference }],
	channelRevision: "channels_1",
};

// 字节按真实格式构造，类型只能从内容识别。
const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);
const jpeg = Buffer.concat([
	Buffer.from("ffd8ffe000104a46494600010100000100010000", "hex"),
	Buffer.alloc(32, 0x11),
	Buffer.from("ffd9", "hex"),
]);
const pdf = Buffer.from(
	"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n",
);
const mp4 = Buffer.concat([
	Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex"),
	Buffer.from("0000000866726565", "hex"),
]);
const zip = Buffer.concat([
	Buffer.from("504b0304140000000000", "hex"),
	Buffer.alloc(40, 0),
]);

const served = new Map<string, () => Response | Promise<Response>>();
const fetchCalls: string[] = [];
const fetchFixture = (async (url: URL | string) => {
	fetchCalls.push(String(url));
	const respond = served.get(String(url));
	return respond ? respond() : new Response(null, { status: 404 });
}) as typeof fetch;
let urlSequence = 0;
function serve(
	bytes: Uint8Array,
	headers: Record<string, string> = {},
): WecomMediaReferenceV1["download"] & object {
	const url = `https://download.example.test/media/${++urlSequence}?token=${SENTINEL_URL}`;
	const encrypted = encryptWecomMediaFixtureV1(bytes, aesKey);
	served.set(url, () => new Response(new Uint8Array(encrypted), { headers }));
	return {
		url,
		aesKey,
		expiresAt: new Date(Date.now() + 240_000).toISOString(),
	};
}

let db: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let store: PostgresWecomChannelV1;
let configurationQuery: PostgresAgentConfigurationQueryV1;
let resolver: ReturnType<typeof createWecomInboundMediaResolverV1>;
let channel: ReturnType<typeof createWecomChannelV1>;
const storage = new FakeObjectStorageV1();
const maxBytes = 512 * 1024;

/**
 * #3258：写入 Agent 当前配置已验证的 Runtime 状态（与 Web 读取的同一份展示投影）。
 * `attachments` 为 null 时删除该状态，表示 Runtime 尚未验证。
 */
async function persistRuntimeState(attachments: boolean | null) {
	if (attachments === null) {
		await sql`delete from platform.workload_reconciliations where agent_id=${base.agentId}`;
		return;
	}
	const current = await store.readAuthorityState(base.agentId);
	if (!current) throw new Error("Expected the fixture Agent");
	const decoded = current.configuration as unknown as {
		readonly revision: number;
		readonly source: { readonly imageDigest: string };
	};
	const desired = workloadDesiredFixture(1, base.agentId, "internal-only");
	const deployment = {
		...desired,
		configRevision: decoded.revision,
		imageDigest: decoded.source.imageDigest,
		registryAdmission: {
			...desired.registryAdmission,
			immutableDigest: decoded.source.imageDigest,
			policyEvidence: {
				...desired.registryAdmission.policyEvidence,
				imageDigest: decoded.source.imageDigest,
			},
		},
	};
	const version = { configuration: current.configuration, deployment };
	const state = {
		schemaVersion: 1,
		agentId: base.agentId,
		sourceConfigurationRevision: decoded.revision,
		sourceLifecycleRevision: 1,
		revision: 1,
		fence: 1,
		phase: "ready",
		candidate: version,
		verified: version,
		verifiedRevision: 1,
		identity: { uid: "wecom-media", generation: 1 },
		rollback: false,
		failureCode: null,
		attempts: 0,
		capabilities: {
			conversation: true,
			attachments,
			resultFiles: false,
			supplementaryInstruction: false,
		},
	};
	await sql`insert into platform.workload_reconciliations (agent_id, revision, state, next_attempt_at)
		values (${base.agentId}, 1, ${sql.json(state as never)}, now() + interval '1 hour')
		on conflict (agent_id) do update set state = excluded.state, revision = excluded.revision`;
}

async function receive(
	message: WecomMessageV1,
	target: ReturnType<typeof createWecomChannelV1> = channel,
) {
	const keyId = `fixture-key:personal:${message.senderId}`;
	await sql`insert into platform.relay_key_subjects
		(purpose, subject_id, last_version, current_version)
		values ('personal', ${message.senderId}, 1, 1)
		on conflict (purpose, subject_id) do nothing`;
	await sql`insert into platform.relay_key_versions
		(purpose, subject_id, key_version, key_id, ciphertext)
		values ('personal', ${message.senderId}, 1, ${keyId},
			${sql.json({ purpose: "personal", subjectId: message.senderId, keyId, keyVersion: 1 })})
		on conflict do nothing`;
	return target.receive(message);
}
async function filesOf(executionId: string | null) {
	return sql<
		{
			record: {
				descriptor: { name: string; mediaType: string };
				actorId: string;
				messageId: string | null;
				executionId: string | null;
				status: string;
			};
		}[]
	>`select record from platform.files where record->>'executionId'=${executionId} order by record->'descriptor'->>'name'`;
}

beforeAll(async () => {
	db = await startPostgresTestDatabase("wecom-inbound-media");
	await migratePlatformDatabase(db);
	sql = postgres(db.databaseUrl, { max: 2 });
	store = new PostgresWecomChannelV1({ ...db, userDirectory, identity });
	configurationQuery = new PostgresAgentConfigurationQueryV1({
		databaseUrl: db.databaseUrl,
	});
	resolver = createWecomInboundMediaResolverV1({
		databaseUrl: db.databaseUrl,
		storage,
		authorization,
		fetch: fetchFixture,
		downloadTimeoutMs: 5_000,
		readAttachmentCapability: createWecomAttachmentCapabilityReaderV1({
			configuration: configurationQuery,
			identity,
			state: store,
		}),
	});
	channel = createWecomChannelV1({ authorization, store, media: resolver });
	await sql`insert into platform.agents (id,current_configuration_revision,authorization_revision) values (${base.agentId},1,'authorization_1')`;
	await sql`insert into platform.agent_applications (id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,management_revision,approval_revision,service_availability,desired_state,workload_revision,fence) values ('app_media',${base.agentId},'owner_1','Fixture','Fixture','available','trace_1','request_1',now(),1,1,'ready','running',1,1)`;
	await sql`insert into platform.agent_owners (agent_id,owner_id,created_at) values (${base.agentId},'owner_1',now())`;
	await sql`insert into platform.agent_availability (agent_id,target_type,target_id) values (${base.agentId},'organization','controlled-org')`;
	// 标准模板的 source_reference 是模板 ID（与 Store 的规范化规则一致），Runtime 展示投影才可读。
	await sql`insert into platform.agent_configuration_revisions (agent_id,revision,source_reference,configuration,created_at) values (${base.agentId},1,${configuration.source.templateId},${sql.json(configuration)},now())`;
	// 三方 FileLimits：Channel 声明不含 zip，交集即企微 Channel 可接收的类型与大小。
	// #3257：同时含 text/plain 与 text/csv，用于证明没有声明类型的入站文本仍按字节识别。
	const expiresAt = new Date(Date.now() + 86_400_000);
	const types = [
		"application/pdf",
		"image/jpeg",
		"image/png",
		"text/csv",
		"text/plain",
		"video/mp4",
	];
	for (const [scope, agentId, channel, mediaTypes] of [
		["deployment", "", "", [...types, "application/zip"]],
		["agent", base.agentId, "", [...types, "application/zip"]],
		["channel", base.agentId, channelId, types],
	] as const)
		await sql`insert into platform.file_limit_declarations (scope,agent_id,channel_id,revision,expires_at,max_bytes,media_types,idempotency_key,request_digest,updated_at,updated_by) values (${scope},${agentId},${channel},1,${expiresAt},${maxBytes},${sql.json([...mediaTypes])},${`fixture-${scope}`},${"0".repeat(64)},now(),'system_admin')`;
	// #3258：Agent 当前配置已验证附件能力，与 Web 上传的前置条件一致。
	await persistRuntimeState(true);
}, 120_000);
afterAll(async () => {
	await resolver?.close();
	await configurationQuery?.close();
	await store?.close();
	await sql?.end();
	await db?.stop();
});

// 每个用例经过真实 PostgreSQL 的多次受理事务；CI 负载下放宽默认 5 秒的超时。
describe("WeCom long-connection inbound media (#3227)", {
	timeout: 60_000,
}, () => {
	const logged: string[] = [];
	beforeAll(() => {
		for (const method of ["log", "info", "warn", "error", "debug"] as const)
			vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
				logged.push(JSON.stringify(args));
			});
	});

	it("AC-1: PNG, JPG, PDF and MP4 become byte-typed attachments of the Message and Execution", async () => {
		const cases = [
			[
				"png",
				{ kind: "image", download: serve(png) },
				"image/png",
				"image-1.png",
			],
			[
				"jpg",
				{ kind: "image", download: serve(jpeg) },
				"image/jpeg",
				"image-1.jpg",
			],
			[
				"pdf",
				{
					kind: "file",
					download: serve(pdf, {
						"content-disposition":
							"attachment; filename*=UTF-8''%E5%AD%A3%E5%BA%A6%E6%8A%A5%E5%91%8A.pdf",
					}),
				},
				"application/pdf",
				"季度报告.pdf",
			],
			[
				"mp4",
				{ kind: "video", download: serve(mp4) },
				"video/mp4",
				"video-1.mp4",
			],
		] as const;
		let conversationId: string | null = null;
		for (const [label, media, mediaType, name] of cases) {
			const result = await receive({
				...base,
				eventId: `ac1-${label}`,
				media: [{ ...media, name: null }],
			});
			if (result.outcome !== "accepted") throw new Error(`Expected ${label}`);
			expect(result.receipt.status).toBe("accepted");
			conversationId ??= result.receipt.conversationId;
			// 单聊同一发送者沿用同一会话映射。
			expect(result.receipt.conversationId).toBe(conversationId);
			const [file] = await filesOf(result.receipt.executionId);
			const [messageRow] = await sql<
				{ message_id: string }[]
			>`select message_id from platform.conversation_messages where execution_id=${result.receipt.executionId}`;
			expect(file?.record).toMatchObject({
				kind: "attachment",
				status: "available",
				actorId: base.senderId,
				channelId,
				conversationId,
				executionId: result.receipt.executionId,
				messageId: messageRow?.message_id,
				descriptor: { mediaType, name },
			});
			await completeWecomExecutionFixture(sql, result.receipt.executionId);
		}
		expect(
			await sql`select count(*)::int as count from platform.conversation_executions where conversation_id=${conversationId}`,
		).toEqual([{ count: 4 }]);
	});

	it("AC-2: mixed text items become the message body and image items its attachments", async () => {
		const result = await receive({
			...base,
			eventId: "ac2-mixed",
			text: "第一段\n第二段",
			media: [
				{ kind: "image", name: null, download: serve(png) },
				{ kind: "image", name: null, download: serve(jpeg) },
			],
		});
		if (result.outcome !== "accepted") throw new Error("Expected acceptance");
		expect(result.receipt.status).toBe("accepted");
		const [messageRow] = await sql<
			{ text: string }[]
		>`select text from platform.conversation_messages where execution_id=${result.receipt.executionId}`;
		expect(messageRow?.text).toBe("第一段\n第二段");
		expect(
			(await filesOf(result.receipt.executionId)).map(
				(row) => row.record.descriptor,
			),
		).toEqual([
			expect.objectContaining({ name: "image-1.png", mediaType: "image/png" }),
			expect.objectContaining({ name: "image-2.jpg", mediaType: "image/jpeg" }),
		]);
		await completeWecomExecutionFixture(sql, result.receipt.executionId);
	});

	it("AC-3: replays the same message ID without downloading or writing again", async () => {
		const download = serve(png);
		const message = {
			...base,
			eventId: "ac3-replay",
			media: [{ kind: "image" as const, name: null, download }],
		};
		const first = await receive(message);
		const fetched = fetchCalls.length;
		const files = await sql`select count(*)::int as count from platform.files`;
		const replay = await receive(message);
		expect(replay).toEqual({ ...first, outcome: "replayed" });
		expect(fetchCalls).toHaveLength(fetched);
		expect(
			await sql`select count(*)::int as count from platform.files`,
		).toEqual(files);
		if (first.outcome === "accepted")
			await completeWecomExecutionFixture(sql, first.receipt.executionId);
	});

	it.each([
		[
			"oversized",
			() => ({
				kind: "file" as const,
				download: serve(Buffer.alloc(maxBytes + 1, 0x20)),
			}),
			{ reason: "too_large", maxBytes },
			"文件超过 0.5 MB，未发送给 Agent",
		],
		[
			"outside the Channel FileLimits",
			() => ({ kind: "file" as const, download: serve(zip) }),
			{ reason: "unsupported_type", maxBytes: null },
			"不支持该文件类型，未发送给 Agent",
		],
		[
			"unverifiable binary",
			() => ({ kind: "file" as const, download: serve(randomBytes(64)) }),
			{ reason: "unsupported_type", maxBytes: null },
			"不支持该文件类型，未发送给 Agent",
		],
		[
			"failed download",
			() => {
				const download = serve(png);
				served.set(download.url, () => new Response("error", { status: 500 }));
				return { kind: "image" as const, download };
			},
			{ reason: "failed", maxBytes: null },
			"文件接收失败，未发送给 Agent，请重新发送",
		],
		[
			"expired address",
			() => ({
				kind: "image" as const,
				download: {
					...serve(png),
					expiresAt: new Date(Date.now() - 1_000).toISOString(),
				},
			}),
			{ reason: "expired", maxBytes: null },
			"文件下载地址已过期，未发送给 Agent，请重新发送",
		],
	] as const)(
		"AC-3: rejects %s media without calling the Agent and replies",
		async (label, media, rejection, text) => {
			const eventId = `ac3-${label.replaceAll(" ", "-")}`;
			const executions =
				await sql`select count(*)::int as count from platform.conversation_executions`;
			const result = await receive({
				...base,
				eventId,
				media: [{ ...media(), name: null }],
			});
			if (result.outcome !== "accepted") throw new Error("Expected receipt");
			expect(result.receipt).toMatchObject({
				status: "media_rejected",
				conversationId: null,
				executionId: null,
			});
			expect(
				await sql`select count(*)::int as count from platform.conversation_executions`,
			).toEqual(executions);
			expect(
				await sql`select action, outcome from platform.audit_events where request_id=${result.receipt.receiptId}`,
			).toEqual([{ action: "wecom.media_rejected", outcome: "rejected" }]);
			expect(
				await sql`select media_rejection_reason, media_rejection_max_bytes::int as max_bytes from platform.wecom_receipts where id=${result.receipt.receiptId}`,
			).toEqual([
				{
					media_rejection_reason: rejection.reason,
					max_bytes: rejection.maxBytes,
				},
			]);
			// 回执由同一回复通道发送固定说明。
			const sent: Parameters<WecomSendPortV1["send"]>[0][] = [];
			const delivery = createWecomDeliveryV1({
				store,
				authorization,
				answerReferences: parseWecomAnswerReferencesV1,
				sender: {
					async send(input) {
						sent.push(input);
						return "sent";
					},
				},
			});
			while (!sent.some((input) => input.text === text))
				if (!(await delivery.dispatch())) break;
			expect(sent.map((input) => input.text)).toContain(text);
		},
	);

	it.each([
		["has no verified Runtime state", null],
		["has verified attachments as unsupported", false],
	] as const)(
		"#3258 AC-3: rejects media when the Agent %s, without downloading or calling the Agent",
		async (label, attachments) => {
			const text = "当前渠道不支持接收图片、文件、语音或视频，未发送给 Agent";
			const eventId = `ac3-capability-${attachments === null ? "none" : "false"}`;
			await persistRuntimeState(attachments);
			try {
				const download = serve(png);
				const executions =
					await sql`select count(*)::int as count from platform.conversation_executions`;
				const files =
					await sql`select count(*)::int as count from platform.files`;
				const result = await receive({
					...base,
					eventId,
					text: label,
					media: [{ kind: "image", name: null, download }],
				});
				if (result.outcome !== "accepted") throw new Error("Expected receipt");
				expect(result.receipt).toMatchObject({
					status: "media_rejected",
					conversationId: null,
					executionId: null,
				});
				// 没有调用 Agent，也没有下载媒体或写入附件。
				expect(
					await sql`select count(*)::int as count from platform.conversation_executions`,
				).toEqual(executions);
				expect(fetchCalls).not.toContain(download.url);
				expect(
					await sql`select count(*)::int as count from platform.files`,
				).toEqual(files);
				expect(
					await sql`select action, outcome from platform.audit_events where request_id=${result.receipt.receiptId}`,
				).toEqual([{ action: "wecom.media_rejected", outcome: "rejected" }]);
				expect(
					await sql`select media_rejection_reason, media_rejection_max_bytes from platform.wecom_receipts where id=${result.receipt.receiptId}`,
				).toEqual([
					{
						media_rejection_reason: "unsupported_channel",
						media_rejection_max_bytes: null,
					},
				]);
				const sent: Parameters<WecomSendPortV1["send"]>[0][] = [];
				const delivery = createWecomDeliveryV1({
					store,
					authorization,
					answerReferences: parseWecomAnswerReferencesV1,
					sender: {
						async send(input) {
							sent.push(input);
							return "sent";
						},
					},
				});
				while (!sent.some((input) => input.text === text))
					if (!(await delivery.dispatch())) break;
				expect(sent.map((input) => input.text)).toContain(text);
			} finally {
				await persistRuntimeState(true);
			}
			// 能力恢复为已验证后，同样的媒体正常受理，证明拒绝来自能力核对。
			const accepted = await receive({
				...base,
				eventId: `${eventId}-verified`,
				media: [{ kind: "image", name: null, download: serve(png) }],
			});
			if (accepted.outcome !== "accepted") throw new Error("Expected receipt");
			expect(accepted.receipt.status).toBe("accepted");
			await completeWecomExecutionFixture(sql, accepted.receipt.executionId);
		},
	);

	it("AC-4: group senders get separate conversations and cannot read each other's attachments", async () => {
		const group = {
			...base,
			conversationType: "group" as const,
			peerId: "group_1",
		};
		const alice = await receive({
			...group,
			senderId: "sender_a",
			eventId: "ac4-alice",
			media: [{ kind: "image", name: null, download: serve(png) }],
		});
		const bob = await receive({
			...group,
			senderId: "sender_b",
			eventId: "ac4-bob",
			media: [{ kind: "image", name: null, download: serve(png) }],
		});
		if (alice.outcome !== "accepted" || bob.outcome !== "accepted")
			throw new Error("Expected acceptance");
		expect(alice.receipt.conversationId).not.toBe(bob.receipt.conversationId);
		const [aliceFile] = await sql<
			{ file_id: string; actor_id: string }[]
		>`select file_id, actor_id from platform.files where record->>'executionId'=${alice.receipt.executionId}`;
		expect(aliceFile?.actor_id).toBe("sender_a");
		const files = new PostgresFileStoreV1(db.databaseUrl);
		try {
			const authority = createFileAuthorityV1({
				store: files,
				storage,
				intentTtlMs: 60_000,
				accessTtlMs: 60_000,
				issuer: "test",
				keyVersion: "test",
			});
			// Bob 以自己的主体去读 Alice 会话里的附件：作用域不一致，拒绝。
			const bobScope = {
				async authorize(conversationId: string) {
					return {
						actorId: "sender_b",
						agentId: base.agentId,
						channelId,
						conversationId,
						execution: null,
						limits: null,
					};
				},
			};
			for (const conversationId of [
				alice.receipt.conversationId ?? "",
				bob.receipt.conversationId ?? "",
			])
				await expect(
					authority.getFile(
						{ conversationId, fileId: aliceFile?.file_id ?? "" },
						bobScope,
					),
				).rejects.toBeInstanceOf(FileAuthorityError);
			// 也不能把媒体写进其他发送者的会话。
			const bobAuthority = await authorization.authorize({
				...group,
				senderId: "sender_b",
			});
			if (bobAuthority.outcome !== "allowed")
				throw new Error("Expected authority");
			expect(
				await resolver.resolve({
					message: {
						...group,
						senderId: "sender_b",
						eventId: "ac4-cross",
						media: [{ kind: "image", name: null, download: serve(png) }],
					},
					authority: bobAuthority.authority,
					conversationId: alice.receipt.conversationId ?? "",
				}),
			).toEqual({ outcome: "rejected", reason: "failed", maxBytes: null });
		} finally {
			await files.close();
		}
	});

	it("#3257: a CSV file without a declared type keeps the byte-identified text/plain type", async () => {
		const result = await receive({
			...base,
			eventId: "text-csv",
			media: [
				{
					kind: "file",
					name: null,
					download: serve(Buffer.from("名称,数量\n苹果,3\n"), {
						"content-disposition": "attachment; filename=table.csv",
					}),
				},
			],
		});
		if (result.outcome !== "accepted") throw new Error("Expected acceptance");
		expect(result.receipt.status).toBe("accepted");
		// FileLimits 同时允许 text/csv，但企微入站没有声明类型，文件名后缀也不是声明：记为 text/plain。
		const [file] = await filesOf(result.receipt.executionId);
		expect(file?.record).toMatchObject({
			status: "available",
			descriptor: { name: "table.csv", mediaType: "text/plain" },
		});
		await completeWecomExecutionFixture(sql, result.receipt.executionId);
	});

	it("AC-5: download URLs and aeskeys never reach Platform DB, logs or audit", async () => {
		const tables = [
			"wecom_receipts",
			"audit_events",
			"files",
			"file_accesses",
			"conversations",
			"conversation_messages",
			"conversation_executions",
			"conversation_events",
			"conversation_audit_events",
			"outbox_items",
			"idempotency_records",
			"task_authorization_records",
		];
		for (const table of tables) {
			const rows = await sql.unsafe(
				`select row_to_json(t)::text as row from platform.${table} t`,
			);
			const dump = rows.map((row) => row.row).join("\n");
			expect(dump, table).not.toContain(SENTINEL_URL);
			expect(dump, table).not.toContain("download.example.test");
			expect(dump, table).not.toContain(aesKey);
		}
		const output = logged.join("\n");
		expect(output).not.toContain(SENTINEL_URL);
		expect(output).not.toContain(aesKey);
	});
});

// #3374：先图后问合并为一个 Turn；受理被拒或部分失败的附件交给文件对账清理，不留下孤儿附件
// （工程 Spec §14.2.4）。真实 PostgreSQL、File Authority 与受理事务；企微收发仍由 #3230 验收。
describe("WeCom attachment merge and orphan cleanup (#3374)", {
	timeout: 60_000,
}, () => {
	const mergeAuthorization: WecomAuthorizationPortV1 = {
		async authorize(scope, ...rest) {
			const allowed = await authorization.authorize(scope, ...rest);
			if (allowed.outcome !== "allowed") return allowed;
			return {
				...allowed,
				authority: {
					...allowed.authority,
					actor: { ...allowed.authority.actor, attachmentMergeWindow: true },
				},
			};
		},
	};
	let merging: ReturnType<typeof createWecomChannelV1>;
	beforeAll(() => {
		merging = createWecomChannelV1({
			authorization: mergeAuthorization,
			store,
			media: resolver,
		});
	});
	async function receiveMerged(message: WecomMessageV1) {
		const result = await receive(message, merging);
		if (result.outcome !== "accepted" && result.outcome !== "replayed")
			throw new Error(`Expected a receipt, got ${result.outcome}`);
		return result.receipt;
	}
	const orphans = () =>
		sql<{ file_id: string; status: string }[]>`
			select file_id, record->>'status' as status from platform.files
			where record->>'kind'='attachment' and record->>'status'='available'
				and record->>'messageId' is null`;
	const turnInput = async (executionId: string | null) => {
		// 与认领读取同一事实：同一 Execution 下的消息按受理顺序，附件绑定到所属 Message
		// （输入组合由 Store 的 readInitialTurnInput 测试覆盖）。
		const messages = await sql<{ message_id: string; text: string }[]>`
			select message_id, text from platform.conversation_messages
			where execution_id=${executionId} order by created_at, message_id`;
		const files = await sql<{ message_id: string; media_type: string }[]>`
			select record->>'messageId' as message_id,
				record->'descriptor'->>'mediaType' as media_type
			from platform.files where record->>'executionId'=${executionId}
				and record->>'kind'='attachment' and record->>'status'='available'`;
		return { messages, files };
	};

	it("AC-1: an image followed by a question becomes one Turn that reads the image", async () => {
		const sender = {
			...base,
			senderId: "merge_sender",
			peerId: "merge_sender",
		};
		const image = await receiveMerged({
			...sender,
			eventId: "merge-image",
			media: [{ kind: "image", name: null, download: serve(png) }],
		});
		const question = await receiveMerged({
			...sender,
			eventId: "merge-question",
			text: "图里是什么？",
		});
		expect(question).toMatchObject({
			status: "accepted",
			executionId: image.executionId,
		});
		const { messages, files } = await turnInput(image.executionId);
		expect(messages.map((row) => row.text)).toEqual(["", "图里是什么？"]);
		expect(files).toEqual([
			{ message_id: messages[0]?.message_id, media_type: "image/png" },
		]);
		// 文字消息结束窗口，Turn 立即可认领。
		expect(
			await sql`select available_at <= clock_timestamp() as claimable from platform.outbox_items where id=${`conversation:turn:${image.executionId}`}`,
		).toEqual([{ claimable: true }]);
		// 附件消息的回复以“已合并”说明结束；最终答案在文字消息的回复中。
		const sent: Parameters<WecomSendPortV1["send"]>[0][] = [];
		const delivery = createWecomDeliveryV1({
			store,
			authorization,
			answerReferences: parseWecomAnswerReferencesV1,
			sender: {
				async send(input) {
					sent.push(input);
					return "sent";
				},
			},
		});
		while (await delivery.dispatch());
		expect(sent.map((input) => input.text)).toContain(
			"已与下一条消息合并处理，回复见下一条",
		);
		await completeWecomExecutionFixture(sql, image.executionId);
		while (await delivery.dispatch());
	});

	it("AC-3: a busy image hands its written attachment to reconciliation", async () => {
		const sender = { ...base, senderId: "busy_sender", peerId: "busy_sender" };
		const question = await receiveMerged({
			...sender,
			eventId: "busy-question",
			text: "先问一个问题",
		});
		const image = await receiveMerged({
			...sender,
			eventId: "busy-image",
			// #3376：回复有效期不足以排队时按繁忙处理（排队期限不晚于有效期前 30 秒）。
			replyExpiresAt: new Date(Date.now() + 20_000).toISOString(),
			media: [{ kind: "image", name: null, download: serve(png) }],
		});
		expect(image).toMatchObject({ status: "busy", executionId: null });
		// 已写入的附件没有绑定任何 Message，转为 expired 由对账在宽限期后删除对象。
		const written = await sql<{ status: string; message_id: string | null }[]>`
			select record->>'status' as status, record->>'messageId' as message_id
			from platform.files where conversation_id=${image.conversationId}
				and record->>'kind'='attachment' and record->>'executionId' is null`;
		expect(written).toEqual([{ status: "expired", message_id: null }]);
		expect(await orphans()).toEqual([]);
		await completeWecomExecutionFixture(sql, question.executionId);
	});

	it("AC-3: a later media failure releases the attachments already written", async () => {
		const failing = serve(png);
		served.set(failing.url, () => new Response("error", { status: 500 }));
		const rejected = await receiveMerged({
			...base,
			senderId: "partial_sender",
			peerId: "partial_sender",
			eventId: "partial-mixed",
			media: [
				{ kind: "image", name: null, download: serve(png) },
				{ kind: "image", name: null, download: failing },
			],
		});
		expect(rejected).toMatchObject({ status: "media_rejected" });
		expect(await orphans()).toEqual([]);
		expect(
			await sql`select record->>'status' as status from platform.files
				where record->>'actorId'='partial_sender' and record->>'kind'='attachment'`,
		).toEqual([{ status: "expired" }]);
	});
});
