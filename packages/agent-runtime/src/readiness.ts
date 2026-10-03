import { type KeyObject, verify } from "node:crypto";
import {
	type WorkloadReadinessBindingV1,
	WorkloadReadinessBindingV1Schema,
	WorkloadReadinessGrantClaimsV1Schema,
	type WorkloadReadinessRequestV1,
	WorkloadReadinessRequestV1Schema,
} from "@agent-infra/contracts/runtime";
import { RuntimeHostError } from "./errors.js";

function denied(): never {
	throw new RuntimeHostError(
		"RUNTIME_READINESS_GRANT_INVALID",
		"Workload readiness authorization is invalid",
		403,
	);
}
const utf8 = new TextDecoder("utf-8", { fatal: true });
function decode(value: string) {
	if (!value) denied();
	const bytes = Buffer.from(value, "base64url");
	if (bytes.toString("base64url") !== value) denied();
	return bytes;
}

/** Deployment binding and authenticated Worker identity are never taken from the request. */
export function createWorkloadReadinessVerifierV1(options: {
	readonly publicKeys: ReadonlyMap<string, KeyObject>;
	readonly expectedIssuer: string;
	readonly binding: WorkloadReadinessBindingV1;
	readonly now?: () => number;
}) {
	const binding = WorkloadReadinessBindingV1Schema.parse(options.binding);
	const publicKeys = new Map(options.publicKeys);
	const issuer = options.expectedIssuer;
	return (value: WorkloadReadinessRequestV1, authenticatedWorkerId: string) => {
		try {
			const request = WorkloadReadinessRequestV1Schema.parse(value);
			const parts = request.grant.token.split(".");
			if (parts.length !== 3) denied();
			const [headerPart, payloadPart, signaturePart] = parts;
			if (!headerPart || !payloadPart || !signaturePart) denied();
			const header = JSON.parse(utf8.decode(decode(headerPart)));
			if (
				!header ||
				typeof header !== "object" ||
				Array.isArray(header) ||
				Object.keys(header).sort().join(",") !== "alg,kid,typ" ||
				header.alg !== "EdDSA" ||
				header.typ !== "workload-readiness+jws" ||
				typeof header.kid !== "string"
			)
				denied();
			const key = publicKeys.get(header.kid);
			if (
				key?.type !== "public" ||
				key.asymmetricKeyType !== "ed25519" ||
				!verify(
					null,
					Buffer.from(`${headerPart}.${payloadPart}`, "ascii"),
					key,
					decode(signaturePart),
				)
			)
				denied();
			const claims = WorkloadReadinessGrantClaimsV1Schema.parse(
				JSON.parse(utf8.decode(decode(payloadPart))),
			);
			const now = (options.now ?? Date.now)();
			if (
				!Number.isSafeInteger(now) ||
				claims.issuer !== issuer ||
				claims.issuedAt > now ||
				now >= claims.expiresAt ||
				claims.expiresAt <= claims.issuedAt ||
				claims.expiresAt - claims.issuedAt > 30_000 ||
				authenticatedWorkerId !== binding.workerId
			)
				denied();
			for (const field of [
				"workerId",
				"agentId",
				"workloadRevision",
				"fence",
				"imageDigest",
			] as const)
				if (
					claims[field] !== binding[field] ||
					request[field] !== binding[field]
				)
					denied();
			if (
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
