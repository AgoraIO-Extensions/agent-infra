import { createHash } from "node:crypto";

export type SkillPackageObjectKindV1 =
	| "zip"
	| "manifest"
	| "source-proof"
	| "scan"
	| "signature-record"
	| "signature"
	| "bundle";

export function skillPackageObjectRefV1(
	operationId: string,
	kind: SkillPackageObjectKindV1,
) {
	if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(operationId))
		throw new Error("Invalid package operation");
	const bytes = createHash("sha256")
		.update(`agent-infra:skill-package-object:v1:${kind}:${operationId}`)
		.digest();
	const byte6 = bytes.at(6);
	const byte8 = bytes.at(8);
	if (byte6 === undefined || byte8 === undefined)
		throw new Error("Invalid object ref");
	bytes[6] = (byte6 & 0x0f) | 0x50;
	bytes[8] = (byte8 & 0x3f) | 0x80;
	return [
		bytes.subarray(0, 4).toString("hex"),
		bytes.subarray(4, 6).toString("hex"),
		bytes.subarray(6, 8).toString("hex"),
		bytes.subarray(8, 10).toString("hex"),
		bytes.subarray(10, 16).toString("hex"),
	].join("-");
}
