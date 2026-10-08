import { createHash, type KeyObject, verify } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { RuntimeHostError } from "@agent-infra/agent-runtime";
import {
	canonicalRuntimeRequestSigningPayload,
	type RuntimeOAuthAuthorizedRequestV1,
	RuntimeOAuthAuthorizedRequestV1Schema,
	RuntimeOAuthGrantClaimsV1Schema,
	type RuntimeOAuthScopeV1,
	RuntimeOAuthScopeV1Schema,
	runtimeOAuthScopeV1,
} from "@agent-infra/contracts/runtime";

function denied(): never {
	throw new RuntimeHostError(
		"RUNTIME_GRANT_INVALID",
		"Connection installation authorization is invalid",
		403,
		false,
	);
}
function decode(value: string) {
	const bytes = Buffer.from(value, "base64url");
	if (bytes.toString("base64url") !== value) denied();
	return bytes;
}
export function createRuntimeOAuthGrantVerifier(options: {
	key: KeyObject;
	keyId: string;
	issuer: string;
	workerId: string;
	scope: RuntimeOAuthScopeV1;
	principal: { kind: "user"; id: string };
	now?: () => number;
}) {
	const scope = RuntimeOAuthScopeV1Schema.parse(options.scope);
	const { key, keyId, issuer, workerId } = options;
	const principal = structuredClone(options.principal);
	const now = options.now ?? Date.now;
	return (input: RuntimeOAuthAuthorizedRequestV1) => {
		try {
			const request = RuntimeOAuthAuthorizedRequestV1Schema.parse(input);
			const [headerPart, payloadPart, signaturePart] =
				request.grant.token.split(".");
			if (!headerPart || !payloadPart || !signaturePart) denied();
			const decoder = new TextDecoder("utf-8", { fatal: true });
			const header = JSON.parse(decoder.decode(decode(headerPart)));
			if (
				!header ||
				Object.keys(header).sort().join(",") !== "alg,kid,typ" ||
				header.alg !== "EdDSA" ||
				header.kid !== keyId ||
				header.typ !== "runtime-connection-installation+jws" ||
				key.asymmetricKeyType !== "ed25519" ||
				!verify(
					null,
					Buffer.from(`${headerPart}.${payloadPart}`, "ascii"),
					key,
					decode(signaturePart),
				)
			)
				denied();
			const claims = RuntimeOAuthGrantClaimsV1Schema.parse(
				JSON.parse(decoder.decode(decode(payloadPart))),
			);
			const current = now();
			if (
				claims.issuer !== issuer ||
				claims.workerId !== workerId ||
				claims.principal.kind !== "user" ||
				!isDeepStrictEqual(claims.principal, principal) ||
				!Number.isSafeInteger(current) ||
				claims.issuedAt > current ||
				claims.expiresAt <= current ||
				claims.expiresAt <= claims.issuedAt ||
				claims.expiresAt - claims.issuedAt > 30_000 ||
				claims.command !== request.command ||
				claims.authorizationId !== request.authorizationId ||
				!isDeepStrictEqual(claims.reference, request.reference) ||
				claims.reference.agentId !== scope.agentId ||
				claims.reference.sessionGeneration !== scope.sessionGeneration ||
				!isDeepStrictEqual(runtimeOAuthScopeV1(claims), scope) ||
				!isDeepStrictEqual(runtimeOAuthScopeV1(request), scope) ||
				claims.requestDigest !==
					createHash("sha256")
						.update(canonicalRuntimeRequestSigningPayload(request))
						.digest("hex")
			)
				denied();
			return claims;
		} catch {
			denied();
		}
	};
}
