import { createHash, type KeyObject, timingSafeEqual } from "node:crypto";
import type {
	FileAccessClaimsV1,
	FileAccessGrantV1,
} from "@agent-infra/contracts/files";
import type { ObjectStorageDataV1 } from "@agent-infra/object-storage";
import {
	createFileAuthorityV1,
	type FileAuthorizationPortV1,
	type FileExecutionV1,
	type FileLimitDeclarationsV1,
	type FileScopeV1,
	resolveFileLimitsV1,
} from "@agent-infra/platform-core";
import { PostgresFileStoreV1 } from "@agent-infra/platform-store";
import {
	createFileGrantCodecV1,
	verifyExecutionGrantForFilesV1,
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
	readonly runtimePublicKeys: ReadonlyMap<string, KeyObject>;
	readonly intentTtlMs: number;
	readonly accessTtlMs: number;
	readonly maxConcurrentTransfers: number;
	readonly services: readonly {
		readonly token: string;
		readonly agentIds: readonly string[];
		readonly component: "worker" | "runtime_host";
	}[];
	resolveActor(actorId: string): Promise<unknown | null>;
	readLimits(input: {
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
}) {
	const deployment = input.deployment;
	const store = new PostgresFileStoreV1(input.databaseUrl);
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
					const declarations = await input.readCurrentLimits(
						identity,
						scope,
						execution && operation === "write" ? "result" : "attachment",
					);
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
	};
	return { dependencies, close: () => store.close() };
}
