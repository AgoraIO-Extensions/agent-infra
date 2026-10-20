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
} from "@agent-infra/platform-core";
import {
	PostgresFileLimitDeclarationStoreV1,
	PostgresFileStoreV1,
} from "@agent-infra/platform-store";
import {
	createFileGrantCodecV1,
	verifyExecutionGrantForFilesV1,
	verifyRuntimeExecutionGrantForFilesV4,
} from "./file-grants.js";
import { requestMetadata } from "./http/common.js";
import type { ConversationAuthorization } from "./http/conversation-routes.js";
import type { FileRoutesDependenciesV1 } from "./http/file-routes.js";
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
export function assemblePlatformFilesV1(input: {
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
}) {
	const deployment = input.deployment;
	if (!deployment.runtimeWorkerId?.trim())
		throw new Error("File runtime worker identity configuration is invalid");
	const store = new PostgresFileStoreV1(input.databaseUrl);
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
	function serviceAllowed(request: Request, agentId: string) {
		const authorization = request.headers.get("Authorization");
		if (!authorization?.startsWith("Bearer ") || authorization.length > 4096)
			return false;
		const digest = createHash("sha256").update(authorization.slice(7)).digest();
		return serviceMappings.some(
			(mapping) =>
				timingSafeEqual(digest, mapping.digest) &&
				mapping.agentIds.includes(agentId),
		);
	}
	function authorization(
		request: Request,
		execution?: FileExecutionV1 & FileScopeV1,
	): FileAuthorizationPortV1 {
		return {
			async authorize(conversationId, operation) {
				if (
					execution &&
					(!serviceAllowed(request, execution.agentId) ||
						execution.conversationId !== conversationId)
				)
					return null;
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
				if (execution && identity.userId !== execution.actorId) return null;
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
				);
				if (allowed.outcome !== "allowed") return null;
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
					return null;
				let limits = null;
				if (operation === "write" || execution) {
					let declarations: FileLimitDeclarationsV1 | null = null;
					try {
						declarations = await input.readCurrentLimits(
							identity,
							scope,
							execution && operation === "write" ? "result" : "attachment",
						);
					} catch {
						// A declaration read failure denies the operation instead of
						// falling back to a wider or synthetic limit.
						declarations = null;
					}
					limits = declarations
						? resolveFileLimitsV1(declarations, new Date())
						: null;
					if (!limits) return null;
				}
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
				const claims = verifyExecutionGrantForFilesV1(grant, {
					issuer: deployment.runtimeIssuer,
					publicKeys: deployment.runtimePublicKeys,
					now: new Date().toISOString(),
				});
				if (!serviceAllowed(request, claims.agentId))
					throw new Error("File exchange denied");
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
				const claims = verifyRuntimeExecutionGrantForFilesV4(
					value.executionGrant,
					{
						issuer: deployment.runtimeIssuer,
						workerId: deployment.runtimeWorkerId,
						publicKeys: deployment.runtimePublicKeys,
					},
				);
				if (!serviceAllowed(request, claims.agentId))
					throw new Error("Runtime file exchange denied");
				// Read the current persisted authority inside one transaction before
				// any object I/O. A missing, foreign, terminal, stopped, stale-fenced
				// or revoked Execution is indistinguishable to the caller.
				const current = await store.transaction(
					claims.conversationId,
					async (transaction) => {
						const conversation = transaction.conversation;
						if (
							!conversation ||
							conversation.actorId !== claims.principal.id ||
							conversation.agentId !== claims.agentId ||
							conversation.channelId !== claims.channelId ||
							conversation.sessionGeneration !== claims.sessionGeneration
						)
							return null;
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
							!["submitted", "processing"].includes(execution.status) ||
							execution.stopPending
						)
							return null;
						// The execution-bound submit Grant names the persisted delivery
						// fence. A supplement proof names its Message and has no comparable
						// persisted Message fence in this milestone (OQ-3 in #2968).
						if (
							claims.operation.kind === "execution" &&
							execution.deliveryFence !==
								claims.operation.executionDeliveryFence
						)
							return null;
						const record = await transaction.getTaskAuthorization(
							claims.authorizationRecordId,
							claims.executionId,
						);
						if (
							!record ||
							record.revoked ||
							record.executionId !== claims.executionId
						)
							return null;
						let boundary: ReturnType<typeof parseTaskAuthorizationBoundaryV1>;
						try {
							boundary = parseTaskAuthorizationBoundaryV1(record.boundary);
						} catch {
							return null;
						}
						if (
							boundary.principal.kind !== claims.principal.kind ||
							boundary.principal.id !== claims.principal.id ||
							boundary.agentId !== claims.agentId ||
							boundary.channelId !== claims.channelId ||
							boundary.agentAuthorizationRevision !==
								execution.authorizationRevision
						)
							return null;
						return execution;
					},
				);
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
		},
	};
}
