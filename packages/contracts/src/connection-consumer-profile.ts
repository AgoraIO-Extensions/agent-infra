import { createHash } from "node:crypto";

export interface ConnectionConsumerProfileV1 {
	readonly schemaVersion: 1;
	readonly publicOrigin: string;
	readonly mcpPath: string;
	readonly consumerId: string;
	readonly audience: string;
	readonly egressProfile: {
		readonly ref: string;
		readonly revision: string;
	};
}

export interface ConnectionConsumerApprovalV1 {
	readonly schemaVersion: 1;
	readonly configFingerprint: string;
	readonly egressEnforced: true;
	readonly source: { readonly ref: string; readonly revision: string };
}

export interface ConnectionConsumerTargetV1 {
	readonly url: string;
	readonly publicOrigin: string;
	readonly mcpPath: string;
	readonly consumerId: string;
	readonly audience: string;
	readonly egressProfile: ConnectionConsumerProfileV1["egressProfile"];
	readonly schemaVersion: 1;
	readonly configFingerprint: string;
	readonly source: ConnectionConsumerApprovalV1["source"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function hasKeys(value: Record<string, unknown>, keys: readonly string[]) {
	const actual = Object.keys(value).sort();
	return (
		actual.length === keys.length &&
		actual.every((key, index) => key === keys[index])
	);
}

function validOrigin(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "https:" && url.origin === value;
	} catch {
		return false;
	}
}

function validPath(value: string): boolean {
	return (
		value.startsWith("/") &&
		!value.startsWith("//") &&
		!/\s|\p{Cc}|\\|\?|#/u.test(value) &&
		!/%(?:2f|2e|5c)/i.test(value) &&
		!value.split("/").some((part) => part === "." || part === "..")
	);
}

export function connectionConsumerProfileFingerprintV1(
	profile: ConnectionConsumerProfileV1,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				profile.schemaVersion,
				profile.publicOrigin,
				profile.mcpPath,
				profile.consumerId,
				profile.audience,
				profile.egressProfile.ref,
				profile.egressProfile.revision,
			]),
			"utf8",
		)
		.digest("hex");
}

export function validateConnectionConsumerProfileV1(
	value: unknown,
	approval: unknown,
): ConnectionConsumerTargetV1 {
	if (
		!isRecord(value) ||
		!hasKeys(value, [
			"audience",
			"consumerId",
			"egressProfile",
			"mcpPath",
			"publicOrigin",
			"schemaVersion",
		]) ||
		value.schemaVersion !== 1
	)
		throw unavailable();
	if (
		!isNonEmptyString(value.publicOrigin) ||
		!isNonEmptyString(value.mcpPath) ||
		!isNonEmptyString(value.consumerId) ||
		!isNonEmptyString(value.audience) ||
		!isRecord(value.egressProfile) ||
		!hasKeys(value.egressProfile, ["ref", "revision"]) ||
		!isNonEmptyString(value.egressProfile.ref) ||
		!isNonEmptyString(value.egressProfile.revision) ||
		!validOrigin(value.publicOrigin) ||
		!validPath(value.mcpPath)
	)
		throw unavailable();
	if (
		!isRecord(approval) ||
		!hasKeys(approval, [
			"configFingerprint",
			"egressEnforced",
			"schemaVersion",
			"source",
		]) ||
		approval.schemaVersion !== 1 ||
		approval.egressEnforced !== true ||
		!isNonEmptyString(approval.configFingerprint) ||
		!/^[a-f0-9]{64}$/.test(approval.configFingerprint) ||
		!isRecord(approval.source) ||
		!hasKeys(approval.source, ["ref", "revision"]) ||
		!isNonEmptyString(approval.source.ref) ||
		!isNonEmptyString(approval.source.revision)
	)
		throw unavailable();
	const profile = value as unknown as ConnectionConsumerProfileV1;
	const fingerprint = connectionConsumerProfileFingerprintV1(profile);
	if (fingerprint !== approval.configFingerprint) throw unavailable();
	return {
		schemaVersion: 1,
		publicOrigin: profile.publicOrigin,
		mcpPath: profile.mcpPath,
		consumerId: profile.consumerId,
		audience: profile.audience,
		egressProfile: { ...profile.egressProfile },
		configFingerprint: fingerprint,
		source: {
			ref: approval.source.ref as string,
			revision: approval.source.revision as string,
		},
		url: new URL(profile.mcpPath, `${profile.publicOrigin}/`).toString(),
	};
}

export function resolveConnectionConsumerTargetV1(
	target: ConnectionConsumerTargetV1,
	overrides?: Record<string, unknown>,
): ConnectionConsumerTargetV1 {
	if (overrides && Object.keys(overrides).length > 0) throw unavailable();
	return structuredClone(target);
}

function unavailable(): never {
	throw new Error("CONNECTION_CONSUMER_PROFILE_UNAVAILABLE");
}
