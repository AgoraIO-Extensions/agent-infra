import { createHash, type KeyObject, timingSafeEqual } from "node:crypto";
import type {
	FileAccessClaimsV1,
	FileAccessGrantV1,
	RuntimeFileExchangeRequestV2,
} from "@agent-infra/contracts/files";
import type { ObjectStorageDataV1 } from "@agent-infra/object-storage";
import {
	createFileAuthorityV1,
	createFileLimitDeclarationReaderV1,
	type FileAuthorizationPortV1,
	type FileExecutionV1,
	type FileLimitDeclarationStoreV1,
	type FileLimitDeclarationsV1,
	type FileScopeV1,
	parseTaskAuthorizationBoundaryV1,
	resolveFileLimitsV1,
	sessionSandboxFileExchangeTokenV1,
} from "@agent-infra/platform-core";
import {
	PostgresConversationQueryV1,
	PostgresFileLimitDeclarationStoreV1,
	PostgresFileStoreV1,
	type RuntimeFileExchangeCredentialScopeRequestV1,
	type RuntimeFileExchangeCredentialScopeResponseV1,
} from "@agent-infra/platform-store";
import {
	createFileGrantCodecV1,
	verifyExecutionGrantForFilesV1,
	verifyRuntimeExecutionGrantForFilesV4,
} from "./file-grants.js";
import { requestMetadata } from "./http/common.js";
import type { ConversationAuthorization } from "./http/conversation-routes.js";
import {
	type FileExchangeDenialStepV1,
	type FileRoutesDependenciesV1,
	recordFileExchangeDenialV1,
} from "./http/file-routes.js";
import {
	type IdentityAdapter,
	type IdentityContext,
	resolveIdentity,
} from "./http/identity.js";

export interface PlatformFileDeploymentV1 {
	readonly storage: ObjectStorageDataV1;
	readonly issuer: string;
	readonly keyVersion: string;
	readonly privateKey: KeyObject;
	readonly publicKeys: ReadonlyMap<string, KeyObject>;
	readonly runtimeIssuer: string;
	// The Worker identity that signs business V4 Grants. File exchange fails
	// closed when files are configured without it.
	readonly runtimeWorkerId: string;
	readonly runtimePublicKeys: ReadonlyMap<string, KeyObject>;
	readonly intentTtlMs: number;
	readonly accessTtlMs: number;
	readonly maxConcurrentTransfers: number;
	readonly services: readonly {
		readonly token: string;
		readonly agentIds: readonly string[];
	}[];
	resolveActor(actorId: string): Promise<unknown | null>;
	/** Defaults to the authoritative Platform DB reader when omitted. */
	readLimits?(input: {
		readonly agentId: string;
		readonly channelId: string;
		readonly configurationRevision: number;
		readonly kind: "attachment" | "result";
	}): Promise<{
		readonly configurationRevision: number;
		readonly declarations: FileLimitDeclarationsV1;
	}>;
}

/**
 * 读取执行当前的 Session Sandbox 分配（Platform DB 权威，#3276）。生产装配传入共用的
 * `PostgresConversationQueryV1`；它的连接池独立于文件 Store，文件事务内调用不会互相等待。
 */
export interface RuntimeFileExchangeCredentialReaderV1 {
	readRuntimeFileExchangeCredentialScopeV1(
		request: RuntimeFileExchangeCredentialScopeRequestV1,
	): Promise<RuntimeFileExchangeCredentialScopeResponseV1 | undefined>;
}

export function assemblePlatformFilesV1(input: {
	evaluationCurrent?: (
		scope: {
			actorId: string;
			channelId: string;
			principal?: { kind: "user" | "application"; id: string };
		},
		conversationId: string,
	) => Promise<boolean>;
	databaseUrl: string;
	deployment: PlatformFileDeploymentV1;
	identity: IdentityAdapter;
	conversationAuthorization: ConversationAuthorization;
	readCurrentLimits(
		identity: IdentityContext,
		scope: FileScopeV1,
		kind: "attachment" | "result",
	): Promise<FileLimitDeclarationsV1 | null>;
	/** Authoritative declaration store; defaults to a Platform DB reader. */
	readonly limitDeclarations?: FileLimitDeclarationStoreV1;
	/** Current Session Sandbox allocation reader; defaults to a Platform DB reader. */
	readonly sandboxCredentials?: RuntimeFileExchangeCredentialReaderV1;
}) {
	const deployment = input.deployment;
	if (!deployment.runtimeWorkerId?.trim())
		throw new Error("File runtime worker identity configuration is invalid");
	const store = new PostgresFileStoreV1(input.databaseUrl);
	const ownedSandboxCredentials =
		input.sandboxCredentials === undefined
			? new PostgresConversationQueryV1({ databaseUrl: input.databaseUrl })
			: undefined;
	const sandboxCredentials: RuntimeFileExchangeCredentialReaderV1 =
		input.sandboxCredentials ??
		(ownedSandboxCredentials as RuntimeFileExchangeCredentialReaderV1);
	const ownedLimitDeclarations =
		deployment.readLimits === undefined && input.limitDeclarations === undefined
			? new PostgresFileLimitDeclarationStoreV1(input.databaseUrl)
			: undefined;
	const limitDeclarations = input.limitDeclarations ?? ownedLimitDeclarations;
	const readLimits =
		deployment.readLimits ??
		(limitDeclarations
			? createFileLimitDeclarationReaderV1({ store: limitDeclarations })
			: undefined);
	if (!readLimits)
		throw new Error("File limit declaration reader is unavailable");
	const service = createFileAuthorityV1({
		store,
		storage: deployment.storage,
		intentTtlMs: deployment.intentTtlMs,
		accessTtlMs: deployment.accessTtlMs,
		issuer: deployment.issuer,
		keyVersion: deployment.keyVersion,
	});
	const codec = createFileGrantCodecV1(deployment);
	const serviceMappings = deployment.services.map((value) => {
		if (!value.token || value.token.length < 32 || value.agentIds.length === 0)
			throw new Error("File service identity configuration is invalid");
		return {
			...value,
			digest: createHash("sha256").update(value.token).digest(),
		};
	});
	/**
	 * 执行期服务身份（工程 Spec §15.4.2，#3276）。先按执行重新读取 Platform DB 中的当前
	 * Sandbox 分配，再决定唯一可接受的凭据：未绑定 Sandbox 的 Agent 级执行只接受部署登记的
	 * 服务 token；绑定 Sandbox 的执行只接受按该分配从登记 token 派生的本 Sandbox 凭据，
	 * 部署 token 本身与其他 Sandbox、旧代次或旧 fence 的派生值都不匹配。两种情形都要求
	 * 登记的 `agentIds` 包含该 Agent。读取在比较之前完成，token 对错走同一路径；比较对全部
	 * 候选逐一执行 timingSafeEqual，不提前返回，也不记录 token。返回拒绝所在的有界步骤，
	 * 通过时返回 null（#3307）。
	 */
	async function serviceIdentityDenial(
		request: Request,
		binding: Omit<RuntimeFileExchangeCredentialScopeRequestV1, "signal">,
	): Promise<"service_identity" | "credential_scope" | null> {
		const authorization = request.headers.get("Authorization");
		if (!authorization?.startsWith("Bearer ") || authorization.length > 4096)
			return "service_identity";
		const presented = createHash("sha256")
			.update(authorization.slice(7))
			.digest();
		let scope: RuntimeFileExchangeCredentialScopeResponseV1 | undefined;
		try {
			scope = await sandboxCredentials.readRuntimeFileExchangeCredentialScopeV1(
				{
					agentId: binding.agentId,
					actorId: binding.actorId,
					channelId: binding.channelId,
					conversationId: binding.conversationId,
					executionId: binding.executionId,
					sessionGeneration: binding.sessionGeneration,
					signal: request.signal,
				},
			);
		} catch {
			// 分配读取不可用时失败关闭，与“不存在”不可区分。
			return "credential_scope";
		}
		let matched = false;
		try {
			for (const mapping of serviceMappings) {
				if (!mapping.agentIds.includes(binding.agentId)) continue;
				const expected = scope?.sandbox
					? createHash("sha256")
							.update(
								sessionSandboxFileExchangeTokenV1(mapping.token, scope.sandbox),
							)
							.digest()
					: mapping.digest;
				matched = timingSafeEqual(presented, expected) || matched;
			}
		} catch {
			// 分配事实非法（派生输入不合法）时失败关闭。
			return "credential_scope";
		}
		if (scope === undefined) return "credential_scope";
		return matched ? null : "service_identity";
	}
	function authorization(
		request: Request,
		execution?: FileExecutionV1 & FileScopeV1,
	): FileAuthorizationPortV1 {
		return {
			async authorize(conversationId, operation) {
				// 执行期访问的每一处拒绝都记录有界步骤；浏览器访问不记录（#3307）。
				const deny = (step: FileExchangeDenialStepV1, error?: unknown) => {
					if (execution) recordFileExchangeDenialV1(step, error);
					return null;
				};
				if (execution) {
					if (execution.conversationId !== conversationId)
						return deny("authorize");
					const denial = await serviceIdentityDenial(request, execution);
					if (denial) return deny(denial);
				}
				const identity = await resolveIdentity(
					execution
						? {
								resolve: () => deployment.resolveActor(execution.actorId),
								hydrateUsers: input.identity.hydrateUsers.bind(input.identity),
							}
						: input.identity,
					request,
					requestMetadata(request).traceId,
				);
				if (execution && identity.userId !== execution.actorId)
					return deny("authorize");
				// #3432：执行期访问按该执行的渠道核对当前授权（企微等非 Web 会话）；浏览器访问只走 Web。
				const allowed = await input.conversationAuthorization.authorize(
					identity,
					{
						schemaVersion: 1,
						conversationId,
						operation:
							operation === "write" || execution
								? "message"
								: "conversation.read",
					},
					execution?.channelId ?? "web",
				);
				if (allowed.outcome !== "allowed") return deny("authorize");
				const scope = {
					actorId: allowed.authority.actorId,
					agentId: allowed.authority.agentId,
					conversationId,
					channelId: allowed.authority.channelId,
				};
				if (
					execution &&
					(scope.agentId !== execution.agentId ||
						scope.actorId !== execution.actorId ||
						scope.channelId !== execution.channelId)
				)
					return deny("authorize");
				let limits = null;
				if (operation === "write" || execution) {
					let declarations: FileLimitDeclarationsV1 | null = null;
					let failure: unknown;
					try {
						declarations = await input.readCurrentLimits(
							identity,
							scope,
							execution && operation === "write" ? "result" : "attachment",
						);
					} catch (error) {
						// A declaration read failure denies the operation instead of
						// falling back to a wider or synthetic limit.
						declarations = null;
						failure = error;
					}
					limits = declarations
						? resolveFileLimitsV1(declarations, new Date())
						: null;
					if (!limits) return deny("limits", failure);
				}
				if (
					scope.channelId === "eval" &&
					(!input.evaluationCurrent ||
						!(await input
							.evaluationCurrent(
								{ actorId: scope.actorId, channelId: "eval" },
								conversationId,
							)
							.catch(() => false)))
				)
					return deny("authorize");
				return { ...scope, execution: execution ?? null, limits };
			},
		};
	}
	const dependencies: FileRoutesDependenciesV1 = {
		service,
		storage: deployment.storage,
		codec,
		maxConcurrentTransfers: deployment.maxConcurrentTransfers,
		authorization(request, claims?: FileAccessClaimsV1) {
			return authorization(
				request,
				claims?.execution
					? {
							actorId: claims.actorId,
							agentId: claims.agentId,
							channelId: claims.channelId,
							conversationId: claims.conversationId,
							...claims.execution,
							attachments: claims.operation === "read" ? [claims.fileId] : [],
							expiresAt: claims.expiresAt,
						}
					: undefined,
			);
		},
		exchange: {
			async authenticate(request: Request, grant: FileAccessGrantV1) {
				let claims: ReturnType<typeof verifyExecutionGrantForFilesV1>;
				try {
					claims = verifyExecutionGrantForFilesV1(grant, {
						issuer: deployment.runtimeIssuer,
						publicKeys: deployment.runtimePublicKeys,
						now: new Date().toISOString(),
					});
				} catch (error) {
					recordFileExchangeDenialV1("grant", error);
					throw error;
				}
				const denial = await serviceIdentityDenial(request, claims);
				if (denial) {
					recordFileExchangeDenialV1(denial);
					throw new Error("File exchange denied");
				}
				return {
					conversationId: claims.conversationId,
					authorization: authorization(request, {
						actorId: claims.actorId,
						agentId: claims.agentId,
						channelId: claims.channelId,
						conversationId: claims.conversationId,
						executionId: claims.executionId,
						sessionGeneration: claims.sessionGeneration,
						grantId: claims.grantId,
						attachments: claims.attachments
							.filter((value) => value.operations.includes("read"))
							.map((value) => value.attachmentId),
						expiresAt: claims.expiresAt,
					}),
				};
			},
		},
		runtimeExchange: {
			// The positive V4 exchange is proven by the original signed Execution
			// Grant. Everything the old V1 wire self-reported (identity, generator,
			// expiry, allowlist) is derived from verified claims and persisted facts.
			async authenticate(
				request: Request,
				value: RuntimeFileExchangeRequestV2,
			): Promise<{
				conversationId: string;
				authorization: FileAuthorizationPortV1;
			}> {
				let claims: ReturnType<typeof verifyRuntimeExecutionGrantForFilesV4>;
				try {
					claims = verifyRuntimeExecutionGrantForFilesV4(value.executionGrant, {
						issuer: deployment.runtimeIssuer,
						workerId: deployment.runtimeWorkerId,
						publicKeys: deployment.runtimePublicKeys,
					});
				} catch (error) {
					recordFileExchangeDenialV1("grant", error);
					throw error;
				}
				// 服务身份在 Grant 验签之后、任何持久写入与对象 I/O 之前校验（#3276）。
				const denial = await serviceIdentityDenial(request, {
					agentId: claims.agentId,
					actorId: claims.principal.id,
					channelId: claims.channelId,
					conversationId: claims.conversationId,
					executionId: claims.executionId,
					sessionGeneration: claims.sessionGeneration,
				});
				if (denial) {
					recordFileExchangeDenialV1(denial);
					throw new Error("Runtime file exchange denied");
				}
				// Read the current persisted authority inside one transaction before
				// any object I/O. A missing, foreign, terminal, stopped, stale-fenced
				// or revoked Execution is indistinguishable to the caller; the bounded
				// step only reaches operational telemetry (#3307).
				const deny = (step: FileExchangeDenialStepV1) => {
					recordFileExchangeDenialV1(step);
					return null;
				};
				const current = await store
					.transaction(claims.conversationId, async (transaction) => {
						const conversation = transaction.conversation;
						if (
							!conversation ||
							conversation.actorId !== claims.principal.id ||
							conversation.agentId !== claims.agentId ||
							conversation.channelId !== claims.channelId ||
							conversation.sessionGeneration !== claims.sessionGeneration
						)
							return deny("conversation");
						const execution = await transaction.getExecution(
							claims.executionId,
						);
						if (
							!execution ||
							execution.actorId !== claims.principal.id ||
							execution.agentId !== claims.agentId ||
							execution.channelId !== claims.channelId ||
							execution.conversationId !== claims.conversationId ||
							execution.sessionGeneration !== claims.sessionGeneration ||
							// 与 FileAuthority 相同的非终态集合：派发 write-ahead 的 unknown 仍可交换（#3307）。
							!["submitted", "processing", "unknown"].includes(
								execution.status,
							) ||
							execution.stopPending
						)
							return deny("execution");
						// The execution-bound submit Grant names the persisted delivery
						// fence. A supplement proof names its Message and has no comparable
						// persisted Message fence in this milestone (OQ-3 in #2968).
						if (
							claims.operation.kind === "execution" &&
							execution.deliveryFence !==
								claims.operation.executionDeliveryFence
						)
							return deny("delivery_fence");
						const record = await transaction.getTaskAuthorization(
							claims.authorizationRecordId,
							claims.executionId,
						);
						if (
							!record ||
							record.revoked ||
							record.executionId !== claims.executionId
						)
							return deny("task_authorization");
						let boundary: ReturnType<typeof parseTaskAuthorizationBoundaryV1>;
						try {
							boundary = parseTaskAuthorizationBoundaryV1(record.boundary);
						} catch {
							return deny("boundary");
						}
						if (
							boundary.principal.kind !== claims.principal.kind ||
							boundary.principal.id !== claims.principal.id ||
							boundary.agentId !== claims.agentId ||
							boundary.channelId !== claims.channelId ||
							boundary.agentAuthorizationRevision !==
								execution.authorizationRevision
						)
							return deny("boundary");
						if (
							boundary.channelId === "eval" &&
							(!input.evaluationCurrent ||
								!(await input.evaluationCurrent(
									{
										actorId: boundary.principal.id,
										channelId: "eval",
										principal: boundary.principal,
									},
									claims.conversationId,
								)))
						)
							return deny("task_authorization");
						return execution;
					})
					.catch((error: unknown) => {
						recordFileExchangeDenialV1("store", error);
						throw error;
					});
				if (!current) throw new Error("Runtime file exchange denied");
				return {
					conversationId: claims.conversationId,
					authorization: authorization(request, {
						actorId: claims.principal.id,
						agentId: claims.agentId,
						channelId: claims.channelId,
						conversationId: claims.conversationId,
						executionId: claims.executionId,
						sessionGeneration: claims.sessionGeneration,
						grantId: claims.grantId,
						// Only the signed attachment allowlist may be read.
						attachments: claims.attachments
							.filter((attachment) => attachment.operations.includes("read"))
							.map((attachment) => attachment.attachmentId),
						// The File Grant horizon is a deployment decision, never a
						// request- or Grant-claimed value.
						expiresAt: new Date(
							Date.now() + deployment.accessTtlMs,
						).toISOString(),
					}),
				};
			},
		},
	};
	return {
		dependencies,
		readLimits,
		close: async () => {
			await store.close();
			await ownedLimitDeclarations?.close();
			await ownedSandboxCredentials?.close();
		},
	};
}
