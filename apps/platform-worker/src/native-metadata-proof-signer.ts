import { sign, type KeyObject } from "node:crypto";
import type { RuntimeNativeMetadataReadRequestV1 } from "@agent-infra/contracts/runtime";
import { nativeMetadataRequestDigest } from "@agent-infra/agent-runtime";

function encode(value: unknown) {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function createWorkerNativeMetadataProofSignerV1(options: {
	readonly issuer: string;
	readonly workerId: string;
	readonly keyVersion: string;
	readonly privateKey: KeyObject;
	readonly now?: () => number;
}) {
	return (request: Omit<RuntimeNativeMetadataReadRequestV1, "proof">) => {
		const issuedAt = (options.now ?? Date.now)();
		const header = encode({ alg: "EdDSA", kid: options.keyVersion, typ: "native-metadata+jws" });
		const claims = {
			...request,
			purpose: "native_metadata_read" as const,
			issuedAt,
			issuer: options.issuer,
			audience: "runtime_host.native_metadata_read" as const,
			workerId: options.workerId,
			keyVersion: options.keyVersion,
			requestDigest: nativeMetadataRequestDigest(request),
		};
		const payload = encode(claims);
		const signature = sign(null, Buffer.from(`${header}.${payload}`, "ascii"), options.privateKey).toString("base64url");
		return { schemaVersion: 1 as const, format: "native-metadata-jws" as const, token: `${header}.${payload}.${signature}` };
	};
}
