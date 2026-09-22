import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { RuntimeConnectionAssociationV1 } from "@agent-infra/contracts/runtime";
import Ajv2020 from "ajv/dist/2020.js";
import type { FromSchema } from "json-schema-to-ts";
import schema from "../../../deploy/runtime/vendor/codex/callback-v2.schema.json" with {
	type: "json",
};
import type { codexCallbackSchema } from "./codex-callback-schema.generated.js";

type SchemaType<Name extends keyof typeof codexCallbackSchema.$defs> =
	FromSchema<{
		$ref: `#/$defs/${Name}`;
		$defs: typeof codexCallbackSchema.$defs;
	}>;

export type CodexConnectionProfile = SchemaType<"connectionProfile">;
export type CodexConnectionBootstrapRequest =
	SchemaType<"connectionBootstrapRequest">;
export type CodexConnectionBootstrapResponse =
	SchemaType<"connectionBootstrapResponse">;
export type CodexConnectionRequest = SchemaType<"connectionRequest">;
export type CodexConnectionEvidence = SchemaType<"connectionEvidence">;
export type CodexConnectionOperationRequest =
	SchemaType<"connectionOperationRequest">;
export type CodexConnectionOperationResponse =
	SchemaType<"connectionOperationResponse">;
export type CodexConnectionEvidenceUpdateRequest =
	SchemaType<"connectionEvidenceUpdateRequest">;
export type CodexConnectionEvidenceUpdateResponse =
	SchemaType<"connectionEvidenceUpdateResponse">;
export type CodexConnectionOrigin = SchemaType<"connectionOrigin">;
export type CodexConnectionRecoveryRequest =
	SchemaType<"connectionRecoveryRequest">;
export type CodexConnectionRecoveryResponse =
	SchemaType<"connectionRecoveryResponse">;
export type CodexConnectionRecoveryOriginal =
	SchemaType<"connectionRecoveryOriginal">;
export type CodexConnectionClientConfiguration =
	SchemaType<"connectionClientConfiguration">;
export type CodexConnectionQueryMetadata = Omit<
	CodexConnectionClientConfiguration,
	"credential"
> & {
	credential: Pick<
		CodexConnectionClientConfiguration["credential"],
		"revision" | "expiresAt"
	>;
};
type Slot = SchemaType<"connectionSlot">;
type SlotMetadata = Omit<Slot, "credential"> & {
	credential: Pick<Slot["credential"], "revision" | "expiresAt">;
};

const ajv = new Ajv2020({ strict: true, strictRequired: false });
ajv.addFormat(
	"uuid",
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
);
ajv.addSchema(schema);
const validator = <Value>(name: keyof typeof codexCallbackSchema.$defs) =>
	ajv.compile<Value>({ $ref: `${schema.$id}#/$defs/${name}` });
export const isCodexConnectionRequest =
	validator<CodexConnectionRequest>("connectionRequest");
export const isCodexConnectionEvidence =
	validator<CodexConnectionEvidence>("connectionEvidence");
export const isCodexConnectionOriginalBinding = validator<
	SchemaType<"connectionOriginalBinding">
>("connectionOriginalBinding");
export const isCodexConnectionRecoveryOriginal =
	validator<CodexConnectionRecoveryOriginal>("connectionRecoveryOriginal");
export const isCodexConnectionOrigin =
	validator<CodexConnectionOrigin>("connectionOrigin");
const isProfile = validator<CodexConnectionProfile>("connectionProfile");
export const isCodexConnectionClientConfiguration = validator<
	SchemaType<"connectionClientConfiguration">
>("connectionClientConfiguration");
const isBootstrapRequest = validator<CodexConnectionBootstrapRequest>(
	"connectionBootstrapRequest",
);
const isBootstrapResponse = validator<CodexConnectionBootstrapResponse>(
	"connectionBootstrapResponse",
);

function unavailable() {
	return new Error("CODEX_CONNECTION_CLIENT_UNAVAILABLE");
}

function copyMetadata(slot: Slot): SlotMetadata {
	return structuredClone({
		slotId: slot.slotId,
		originalBinding: slot.originalBinding,
		service: slot.service,
		connectionIdentity: slot.connectionIdentity,
		credential: {
			revision: slot.credential.revision,
			expiresAt: slot.credential.expiresAt,
		},
	});
}

const maximumHistoricalSlots = 1_024;

export function validateCodexConnectionProfile(
	value: unknown,
): CodexConnectionProfile {
	if (!isProfile(value)) throw unavailable();
	const profile = structuredClone(value);
	const issuer = new URL(profile.issuer);
	const resource = new URL(profile.resource);
	if (
		issuer.origin !== resource.origin ||
		resource.pathname !== "/mcp" ||
		(issuer.href !== profile.issuer && issuer.href !== `${profile.issuer}/`) ||
		resource.href !== profile.resource
	)
		throw unavailable();
	return profile;
}

/** One socket-bound client; only the returned bootstrap response contains a token. */
export function createCodexConnectionClient(options: {
	profile: CodexConnectionProfile;
	resolveOriginalClient: (
		request: { profileRef: string; nativeSessionRef?: string },
		signal: AbortSignal,
	) => Promise<unknown>;
	now?: () => number;
}) {
	const now = options.now ?? Date.now;
	const profile = validateCodexConnectionProfile(options.profile);
	let slot: SlotMetadata | undefined;
	const slots = new Map<string, SlotMetadata>();
	let processNonce: string | undefined;
	let closed = false;
	const bootstrapRequests = new Set<string>();

	const assertRequest = (descriptor: CodexConnectionRequest) => {
		if (
			closed ||
			!isCodexConnectionRequest(descriptor) ||
			!slot ||
			descriptor.slotId !== slot.slotId ||
			descriptor.profileRef !== profile.profileRef ||
			descriptor.serviceRef !== slot.service.serviceRef ||
			slot.credential.expiresAt <= now()
		)
			throw unavailable();
		return structuredClone(slot.originalBinding);
	};

	const bootstrap = async (
		request: CodexConnectionBootstrapRequest,
		signal: AbortSignal,
	): Promise<CodexConnectionBootstrapResponse> => {
		const deny = (
			reason:
				| "profile_unavailable"
				| "binding_mismatch"
				| "credential_unavailable"
				| "credential_expired"
				| "authorization_unavailable",
		): CodexConnectionBootstrapResponse => ({
			schemaVersion: 2,
			requestId: request.requestId,
			phase: "connection-bootstrap",
			request,
			decision: "unavailable",
			reason,
		});
		if (
			closed ||
			!isBootstrapRequest(request) ||
			bootstrapRequests.has(request.requestId)
		)
			throw unavailable();
		// Keep request IDs for the socket lifetime. Evicting an old ID would let a
		// successful bootstrap be replayed after enough denied requests.
		if (bootstrapRequests.size >= maximumHistoricalSlots)
			return deny("credential_unavailable");
		bootstrapRequests.add(request.requestId);
		if (request.profileRef !== profile.profileRef)
			return deny("profile_unavailable");
		if (processNonce !== undefined && processNonce !== request.processNonce)
			return deny("binding_mismatch");
		processNonce = request.processNonce;
		signal.throwIfAborted();
		let configuration: unknown;
		try {
			configuration = await options.resolveOriginalClient(
				{
					profileRef: profile.profileRef,
					...(request.nativeSessionRef
						? { nativeSessionRef: request.nativeSessionRef }
						: {}),
				},
				signal,
			);
		} catch {
			return deny("authorization_unavailable");
		}
		signal.throwIfAborted();
		if (closed) throw unavailable();
		if (!isCodexConnectionClientConfiguration(configuration))
			return deny("credential_unavailable");
		if (
			!isDeepStrictEqual(configuration.service, {
				serviceRef: profile.serviceRef,
				issuer: profile.issuer,
				resource: profile.resource,
			})
		)
			return deny("binding_mismatch");
		if (configuration.credential.expiresAt <= now())
			return deny("credential_expired");
		if (
			slot &&
			(!isDeepStrictEqual(
				slot.originalBinding.principal,
				configuration.originalBinding.principal,
			) ||
				!isDeepStrictEqual(
					{ ...slot.originalBinding.scope, executionId: undefined },
					{ ...configuration.originalBinding.scope, executionId: undefined },
				) ||
				!isDeepStrictEqual(slot.service, configuration.service) ||
				!isDeepStrictEqual(
					slot.connectionIdentity,
					configuration.connectionIdentity,
				))
		)
			return deny("binding_mismatch");
		const candidate: Slot = { slotId: randomUUID(), ...configuration };
		const response: CodexConnectionBootstrapResponse = {
			schemaVersion: 2,
			requestId: request.requestId,
			phase: "connection-bootstrap",
			request,
			decision: "permit",
			slot: candidate,
		};
		if (
			!isBootstrapResponse(response) ||
			Buffer.byteLength(JSON.stringify(response)) + 1 > 16_384
		)
			return deny("credential_unavailable");
		if (slots.size >= maximumHistoricalSlots)
			return deny("credential_unavailable");
		slot = copyMetadata(candidate);
		slots.set(slot.slotId, slot);
		return response;
	};

	const associate = (input: {
		requestDescriptor: CodexConnectionRequest;
		evidence: CodexConnectionEvidence;
		previousEvidence?: CodexConnectionEvidence;
		metadataOnly: boolean;
		occurredAt: number;
		origin?: CodexConnectionOrigin;
		queryClient?: CodexConnectionQueryMetadata;
	}): RuntimeConnectionAssociationV1 | undefined => {
		const {
			requestDescriptor: descriptor,
			evidence,
			previousEvidence,
			metadataOnly,
			occurredAt,
		} = input;
		// Historical slots contain no token and cannot reopen dispatch.
		const evidenceSlot = input.origin ?? slots.get(descriptor.slotId);
		if (
			!evidenceSlot ||
			(input.origin !== undefined &&
				(!isCodexConnectionOrigin(input.origin) ||
					input.origin.slotId !== descriptor.slotId ||
					!isDeepStrictEqual(input.origin.service, {
						serviceRef: profile.serviceRef,
						issuer: profile.issuer,
						resource: profile.resource,
					}))) ||
			closed ||
			!isCodexConnectionRequest(descriptor) ||
			descriptor.profileRef !== profile.profileRef ||
			descriptor.serviceRef !== evidenceSlot.service.serviceRef ||
			!isCodexConnectionEvidence(evidence) ||
			(previousEvidence !== undefined &&
				!isCodexConnectionEvidence(previousEvidence))
		)
			throw unavailable();
		if (descriptor.toolName !== "execute_action") return undefined;
		if (
			!Number.isSafeInteger(occurredAt) ||
			occurredAt <= 0 ||
			occurredAt > now()
		)
			throw unavailable();
		const original = evidence.originalResponse;
		const receipt = original?.receipt;
		const prior = previousEvidence?.originalResponse;
		if (
			metadataOnly &&
			(!previousEvidence ||
				!prior ||
				!original ||
				!isDeepStrictEqual(prior, original))
		)
			throw unavailable();
		if (prior && original && !isDeepStrictEqual(prior, original))
			throw unavailable();
		if (
			previousEvidence?.verification === "verified" &&
			evidence.verification !== "verified"
		)
			throw unavailable();
		const receiptMatches =
			receipt !== undefined &&
			original !== undefined &&
			original.rpcRequestId === descriptor.rpcRequestId &&
			original.receivedAt <= occurredAt &&
			receipt.operationNonce === descriptor.operationNonce &&
			receipt.attemptNonce === descriptor.attemptNonce &&
			receipt.requestDigestVersion === descriptor.requestDigestVersion &&
			receipt.requestDigest === descriptor.requestDigest &&
			isDeepStrictEqual(
				receipt.principal,
				evidenceSlot.connectionIdentity.principal,
			) &&
			receipt.actorId === evidenceSlot.connectionIdentity.actorId;
		if (evidence.verification === "unverified") {
			return {
				serviceRef: descriptor.serviceRef,
				verification: "unverified",
				...(receiptMatches ? { callRef: receipt.callRef } : {}),
				reason:
					original && !receiptMatches ? "binding_mismatch" : evidence.reason,
			};
		}
		const query = evidence.recordQuery;
		const record = query?.record;
		const queryCredentialKnown =
			query !== undefined &&
			(input.queryClient ? [input.queryClient] : [...slots.values()]).some(
				(known) =>
					isDeepStrictEqual(known.service, evidenceSlot.service) &&
					(input.queryClient === undefined ||
						isDeepStrictEqual(
							known.originalBinding,
							evidenceSlot.originalBinding,
						)) &&
					known.credential.revision === query.credentialRevision &&
					known.credential.expiresAt > query.queriedAt &&
					isDeepStrictEqual(
						known.connectionIdentity,
						evidenceSlot.connectionIdentity,
					),
			);
		if (
			!queryCredentialKnown ||
			!receiptMatches ||
			!receipt ||
			!query ||
			!record ||
			!original ||
			query.queriedAt < original.receivedAt ||
			query.queriedAt > evidence.verifiedAt ||
			evidence.verifiedAt > occurredAt ||
			record.callRef !== receipt.callRef ||
			record.operationNonce !== descriptor.operationNonce ||
			!record.attemptNonces.includes(descriptor.attemptNonce) ||
			record.requestDigestVersion !== descriptor.requestDigestVersion ||
			record.requestDigest !== descriptor.requestDigest ||
			!isDeepStrictEqual(
				record.principal,
				evidenceSlot.connectionIdentity.principal,
			) ||
			record.actorId !== evidenceSlot.connectionIdentity.actorId ||
			record.actionVersionId !== receipt.actionVersionId ||
			record.consumerId !== evidenceSlot.connectionIdentity.consumerId ||
			record.clientId !== evidenceSlot.connectionIdentity.clientId
		)
			throw unavailable();
		return {
			serviceRef: descriptor.serviceRef,
			verification: "verified",
			callRef: receipt.callRef,
		};
	};

	return {
		snapshotOriginal(
			descriptor: CodexConnectionRequest,
		): CodexConnectionOrigin {
			assertRequest(descriptor);
			const original = slots.get(descriptor.slotId);
			if (!original) throw unavailable();
			return structuredClone({
				schemaVersion: 1,
				slotId: original.slotId,
				originalBinding: original.originalBinding,
				service: original.service,
				connectionIdentity: original.connectionIdentity,
			});
		},
		bootstrap,
		assertRequest,
		associate,
		close() {
			closed = true;
			slot = undefined;
			slots.clear();
			bootstrapRequests.clear();
		},
	};
}
