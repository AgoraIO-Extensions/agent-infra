import { createHmac } from "node:crypto";

const attestationPattern = /^[A-Za-z0-9_-]{43}$/;
const scopePattern = /^[\x21-\x7e]{1,256}(?:\0[\x21-\x7e]{1,256})?$/;

export function containerBoundaryAttestationV1(
	serviceToken: string,
	scope: string,
): string {
	if (!serviceToken || !scopePattern.test(scope)) throw new Error("policy");
	const value = createHmac("sha256", serviceToken)
		.update(`agent-infra-container-boundary-v1\0${scope}`)
		.digest("base64url");
	if (!attestationPattern.test(value)) throw new Error("policy");
	return value;
}
