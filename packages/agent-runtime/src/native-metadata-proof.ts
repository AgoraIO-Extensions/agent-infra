import { createHash, type KeyObject, verify } from "node:crypto";
import {
	RuntimeNativeMetadataProofClaimsV1Schema,
	RuntimeNativeMetadataReadRequestV1Schema,
	type RuntimeNativeMetadataProofClaimsV1,
	type RuntimeNativeMetadataReadRequestV1,
} from "@agent-infra/contracts/runtime";
import { RuntimeHostError } from "./errors.js";

const utf8 = new TextDecoder("utf-8", { fatal: true });

function denied(): never {
	throw new RuntimeHostError(
		"RUNTIME_NATIVE_METADATA_PROOF_INVALID",
		"Native metadata authorization is invalid",
		403,
	);
}

function decode(value: string) {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) denied();
	const bytes = Buffer.from(value, "base64url");
	if (bytes.toString("base64url") !== value) denied();
	return bytes;
}

export function nativeMetadataRequestDigest(
	request: Pick<RuntimeNativeMetadataReadRequestV1, "schemaVersion" | "readId" | "selector" | "scope" | "readStartedAt" | "expiresAt" | "requestId" | "traceId" | "originalHostScopeRef">,
) {
	return createHash("sha256")
		.update(
			JSON.stringify([
				"runtime-native-metadata-request-v1",
				request.schemaVersion,
				request.readId,
				request.selector,
				request.scope,
				request.readStartedAt,
				request.expiresAt,
				request.requestId,
				request.traceId,
				request.originalHostScopeRef,
			]),
		)
		.digest("hex");
}

export function createRuntimeNativeMetadataProofVerifierV1(options: {
	readonly expectedIssuer: string;
	readonly expectedWorkerId: string;
	readonly allowedAgentIds: ReadonlySet<string>;
	readonly publicKeys: ReadonlyMap<string, KeyObject>;
	readonly now?: () => number;
}) {
	return (
		value: RuntimeNativeMetadataReadRequestV1,
		authenticatedWorkerId: string,
	): RuntimeNativeMetadataProofClaimsV1 => {
		try {
			const request = RuntimeNativeMetadataReadRequestV1Schema.parse(value);
			if (
				authenticatedWorkerId !== options.expectedWorkerId ||
				!options.allowedAgentIds.has(request.scope.agentId)
			)
				denied();
			const parts = request.proof.token.split(".");
			if (parts.length !== 3) denied();
			const [headerPart, claimsPart, signaturePart] = parts;
			if (!headerPart || !claimsPart || !signaturePart) denied();
			const header = JSON.parse(utf8.decode(decode(headerPart))) as Record<
				string,
				unknown
			>;
			if (
				Object.keys(header).sort().join(",") !== "alg,kid,typ" ||
				header.alg !== "EdDSA" ||
				header.typ !== "native-metadata+jws" ||
				typeof header.kid !== "string"
			)
				denied();
			const key = options.publicKeys.get(header.kid);
			if (
				!key ||
				key.asymmetricKeyType !== "ed25519" ||
				!verify(
					null,
					Buffer.from(`${headerPart}.${claimsPart}`, "ascii"),
					key,
					decode(signaturePart),
				)
			)
				denied();
			const claims = RuntimeNativeMetadataProofClaimsV1Schema.parse(
				JSON.parse(utf8.decode(decode(claimsPart))),
			);
			const now = (options.now ?? Date.now)();
			if (
				claims.issuer !== options.expectedIssuer ||
				claims.workerId !== options.expectedWorkerId ||
				claims.audience !== "runtime_host.native_metadata_read" ||
				claims.purpose !== "native_metadata_read" ||
				claims.issuedAt > now ||
				now >= claims.expiresAt ||
				claims.expiresAt - claims.readStartedAt > 30_000 ||
				claims.requestDigest !== nativeMetadataRequestDigest(request) ||
				claims.readId !== request.readId ||
				claims.selector !== request.selector ||
				claims.originalHostScopeRef !== request.originalHostScopeRef ||
				claims.scope.agentId !== request.scope.agentId ||
				claims.scope.conversationId !== request.scope.conversationId ||
				claims.scope.executionId !== request.scope.executionId ||
				claims.scope.sessionGeneration !== request.scope.sessionGeneration ||
				claims.requestId !== request.requestId ||
				claims.traceId !== request.traceId
			)
				denied();
			return claims;
		} catch {
			denied();
		}
	};
}
