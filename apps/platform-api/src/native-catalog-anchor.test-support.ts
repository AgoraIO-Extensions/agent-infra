import { generateKeyPairSync } from "node:crypto";
import type { RuntimeHost } from "@agent-infra/agent-runtime";
import type { SessionSandboxPolicyV1 } from "@agent-infra/platform-core";
import type { PostgresConversationQueryV1 } from "@agent-infra/platform-store";
import { Hono } from "hono";
import {
	createRuntimeNativeMetadataCurrentAssemblyV1,
	createRuntimeNativeMetadataReadV1,
} from "../../agent-runtime-host/src/native-metadata-assembly.js";
import { createRuntimeNativeMetadataProofVerifierV1 } from "../../agent-runtime-host/src/native-metadata-proof.js";
import { createWorkerRuntimeNativeMetadataGatewayV1 } from "../../platform-worker/src/runtime-native-metadata-gateway.js";
import { createWorkerRuntimeNativeMetadataProofIssuerV1 } from "../../platform-worker/src/runtime-native-metadata-proof.js";
import { registerNativeMetadataRoutes } from "./http/native-metadata-routes.js";
import {
	createRuntimeNativeMetadataCurrentCheckerV1,
	createRuntimeNativeMetadataRequestRegistryV1,
} from "./runtime-native-metadata-current.js";
import { createRuntimeNativeMetadataWorkerReaderV1 } from "./runtime-native-metadata-reader.js";
import { createRuntimeNativeMetadataScopeResolverV1 } from "./runtime-native-metadata-scope-resolver.js";

/** Real PG scope, signed Worker proof, Host original mapping and Driver. Identity/policy are controlled. */
export async function readCatalogAnchorFixture(input: {
	query: Pick<
		PostgresConversationQueryV1,
		"readNativeMetadataObjectScopeV1" | "readNativeMetadataRuntimeTargetScopeV1"
	>;
	host: Pick<
		RuntimeHost,
		"readNativeMetadataV1" | "resolveNativeMetadataSessionRef"
	>;
	agentId: string;
	conversationId: string;
	executionId: string;
	userId: string;
	selector: "commands" | "skills";
	sandboxPolicy: SessionSandboxPolicyV1;
}) {
	const registry = createRuntimeNativeMetadataRequestRegistryV1();
	const identity = {
		schemaVersion: 1 as const,
		userId: input.userId,
		displayName: "Synthetic reader",
		accountStatus: "active" as const,
		organizationIds: [],
		roles: ["employee" as const],
		authorizationRevision: "identity-v6",
	};
	const authorize = async () => ({
		outcome: "allowed" as const,
		authority: {
			actorId: input.userId,
			agentId: input.agentId,
			channelId: "web",
			authorizationRevision: "native-v6-auth",
		},
	});
	const checker = createRuntimeNativeMetadataCurrentCheckerV1({
		registry,
		authorize,
	});
	const keys = generateKeyPairSync("ed25519");
	const proof = {
		issuer: "anchor-fixture",
		workerId: "anchor-worker",
		keyVersion: "anchor-key",
	};
	const verifier = createRuntimeNativeMetadataProofVerifierV1({
		...proof,
		publicKey: keys.publicKey,
	});
	const scopeOf = (scope: {
		principal: { kind: "user" | "application"; id: string };
		channelId: string;
	}) => ({
		actorId: scope.principal.id,
		channelId: scope.channelId,
		principal: scope.principal,
	});
	const gateway: ReturnType<typeof createWorkerRuntimeNativeMetadataGatewayV1> =
		createWorkerRuntimeNativeMetadataGatewayV1({
			current: checker,
			binding: {
				async resolve({ request, signal }) {
					const original = await input.query.readNativeMetadataObjectScopeV1({
						scope: scopeOf(request.scope),
						conversationId: request.scope.conversationId,
						executionId: request.scope.executionId,
						signal,
					});
					if (!original?.originalHostScopeRef) return null;
					const { apiRequestSourceRef: _source, ...binding } = request;
					return {
						...binding,
						originalHostScopeRef: original.originalHostScopeRef,
					};
				},
			},
			proofIssuer: createWorkerRuntimeNativeMetadataProofIssuerV1({
				...proof,
				privateKey: keys.privateKey,
			}),
			transport: {
				async resolve({ binding, signal }) {
					const target =
						await input.query.readNativeMetadataRuntimeTargetScopeV1({
							scope: scopeOf(binding.scope),
							agentId: binding.scope.agentId,
							conversationId: binding.scope.conversationId,
							executionId: binding.scope.executionId,
							sandboxPolicy: input.sandboxPolicy,
							signal,
						});
					if (
						!target ||
						target.originalHostScopeRef !== binding.originalHostScopeRef
					)
						return null;
					return {
						read: createRuntimeNativeMetadataReadV1(
							input.host,
							createRuntimeNativeMetadataCurrentAssemblyV1({
								current: {
									check: (request) =>
										gateway.checkHostCurrent(request, request.signal),
								},
								verifyProof: (request) => verifier.verify(request),
								resolveNativeSessionRef: async ({ request }) =>
									input.host.resolveNativeMetadataSessionRef(
										request.scope,
										request.originalHostScopeRef,
									),
							}),
						),
					};
				},
			},
		});
	const reader = createRuntimeNativeMetadataWorkerReaderV1({
		resolveRequest: createRuntimeNativeMetadataScopeResolverV1({
			query: input.query,
			authorize,
		}),
		requestRegistry: registry,
		gateway,
	});
	const app = new Hono();
	registerNativeMetadataRoutes(app, {
		identity: { resolve: async () => identity, hydrateUsers: async () => [] },
		reader,
	});
	try {
		return await app.fetch(
			new Request(
				`http://anchor.invalid/api/v2/conversations/${input.conversationId}/executions/${input.executionId}/native-metadata?selector=${input.selector}${input.selector === "commands" ? "&projectionVersion=2" : ""}`,
			),
		);
	} finally {
		registry.clear();
	}
}
