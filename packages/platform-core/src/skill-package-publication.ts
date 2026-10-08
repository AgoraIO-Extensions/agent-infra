import { isDeepStrictEqual, types } from "node:util";
import {
	isAgentManagementText,
	requireAgentManagementExactKeys,
	snapshotAgentManagementDataObject,
} from "./agent-management-input.js";
import {
	MagicSkillProviderOrderV1,
	type SkillHubVersionV1,
	type SkillHubVisibilityV1,
	type SkillProviderIdV1,
	skillHubVisibilityV1,
} from "./skill-hub.js";
import {
	parseSkillHubIdV1,
	parseSkillHubObjectVersionV1,
	SkillHubOperationErrorV1,
	type SkillHubRegistrationV1,
	type SkillHubRequestV1,
} from "./skill-hub-management.js";
import { skillPackageObjectRefV1 } from "./skill-package-ref.js";

export type SkillPackagePublicationSelectionV1 = Readonly<{
	schemaVersion: 1;
	name: string;
	skillId: string;
	skillVersionId: string;
	visibility: SkillHubVisibilityV1;
	provider: SkillProviderIdV1;
	version: string;
	sourceVersion: string;
	sourceDigest: string;
	approvalRef: string | null;
	trustRevision: string;
	policyRevision: string;
	archiveDigest: string;
}>;
export const skillPackagePublicationStagesV1 = [
	"zip",
	"source-proof",
	"manifest",
	"scan",
	"signature-record",
	"signature",
	"bundle",
] as const;
export type SkillPackagePublicationStageV1 =
	(typeof skillPackagePublicationStagesV1)[number];
export type SkillPackagePublicationObjectV1 = Readonly<{
	objectRef: string;
	version: string;
	etag: string;
	sizeBytes: number;
	mediaType: string;
	sha256: string;
}>;
export type SkillPackagePublicationIntentV1 = Readonly<{
	objectRef: string;
	sizeBytes: number;
	mediaType: string;
	sha256: string;
	/** Canonical evidence fields only. ZIP/payload and raw signature bytes never enter DB. */
	evidence: Readonly<Record<string, unknown>> | null;
}>;
export type SkillPackagePublicationStateV1 = Readonly<{
	schemaVersion: 1;
	operationId: string;
	ownerId: string;
	selection: SkillPackagePublicationSelectionV1;
	intents: Readonly<
		Partial<
			Record<SkillPackagePublicationStageV1, SkillPackagePublicationIntentV1>
		>
	>;
	objects: Readonly<
		Partial<
			Record<SkillPackagePublicationStageV1, SkillPackagePublicationObjectV1>
		>
	>;
}>;
export type SkillPackagePublicationContextV1 = Readonly<{
	state: SkillPackagePublicationStateV1;
	replayed: boolean;
	guard: () => Promise<void>;
	intend: (
		stage: SkillPackagePublicationStageV1,
		intent: SkillPackagePublicationIntentV1,
	) => Promise<void>;
	save: (
		stage: SkillPackagePublicationStageV1,
		object: SkillPackagePublicationObjectV1,
	) => Promise<void>;
}>;
export type SkillPackagePublicationResultV1 = Readonly<{
	replayed: boolean;
	version: SkillHubVersionV1;
	artifacts: SkillPackagePublicationStateV1["objects"];
}>;
export interface SkillPackagePublicationPortV1 {
	publishPackage(
		context: SkillHubRequestV1,
		key: string,
		selection: unknown,
		work: (
			context: SkillPackagePublicationContextV1,
		) => Promise<SkillHubRegistrationV1>,
		revalidate: () => Promise<void>,
	): Promise<SkillPackagePublicationResultV1>;
}
function invalid(): never {
	throw new SkillHubOperationErrorV1("invalid_input");
}
function text(value: unknown, maximum = 1024): string {
	if (!isAgentManagementText(value, maximum)) invalid();
	return value;
}
function sha(value: unknown): string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) invalid();
	return value;
}
function record(value: unknown) {
	if (
		!value ||
		typeof value !== "object" ||
		types.isProxy(value) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(value))
	)
		invalid();
	return snapshotAgentManagementDataObject(value);
}
export function parseSkillPackagePublicationSelectionV1(
	input: unknown,
): SkillPackagePublicationSelectionV1 {
	const value = record(input);
	requireAgentManagementExactKeys(value, [
		"schemaVersion",
		"name",
		"skillId",
		"skillVersionId",
		"visibility",
		"provider",
		"version",
		"sourceVersion",
		"sourceDigest",
		"approvalRef",
		"trustRevision",
		"policyRevision",
		"archiveDigest",
	]);
	if (
		value.schemaVersion !== 1 ||
		typeof value.name !== "string" ||
		!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(value.name) ||
		!skillHubVisibilityV1.some((item) => item === value.visibility) ||
		!MagicSkillProviderOrderV1.some((item) => item === value.provider)
	)
		invalid();
	return Object.freeze({
		schemaVersion: 1,
		name: value.name,
		skillId: parseSkillHubIdV1(value.skillId),
		skillVersionId: parseSkillHubIdV1(value.skillVersionId),
		visibility: value.visibility as SkillHubVisibilityV1,
		provider: value.provider as SkillProviderIdV1,
		version: parseSkillHubIdV1(value.version),
		sourceVersion: text(value.sourceVersion),
		sourceDigest: sha(value.sourceDigest),
		approvalRef:
			value.approvalRef === null ? null : text(value.approvalRef, 256),
		trustRevision: text(value.trustRevision),
		policyRevision: text(value.policyRevision),
		archiveDigest: sha(value.archiveDigest),
	});
}
function descriptor(value: Record<string, unknown>) {
	if (
		typeof value.objectRef !== "string" ||
		!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.objectRef) ||
		typeof value.sizeBytes !== "number" ||
		!Number.isSafeInteger(value.sizeBytes) ||
		value.sizeBytes < 0 ||
		value.sizeBytes > 50_000_000
	)
		invalid();
	return {
		objectRef: value.objectRef,
		sizeBytes: value.sizeBytes,
		mediaType: text(value.mediaType, 128),
		sha256: sha(value.sha256),
	};
}
export function parseSkillPackagePublicationObjectV1(
	input: unknown,
): SkillPackagePublicationObjectV1 {
	const value = record(input);
	requireAgentManagementExactKeys(value, [
		"objectRef",
		"version",
		"etag",
		"sizeBytes",
		"mediaType",
		"sha256",
	]);
	return Object.freeze({
		...descriptor(value),
		version: parseSkillHubObjectVersionV1(value.version),
		etag: text(value.etag, 256),
	});
}
const evidenceKeys = {
	"source-proof": [
		"schemaVersion",
		"provider",
		"publisherId",
		"sourceVersion",
		"sourceDigest",
		"approvalRef",
		"trustRevision",
	],
	scan: [
		"schemaVersion",
		"scannerId",
		"engineVersion",
		"rulesetDigest",
		"policyRevision",
		"scannedAt",
		"expiresAt",
		"packageDigest",
		"manifestDigest",
		"scannedFileCount",
		"scannedBytes",
		"verdict",
	],
	"signature-record": [
		"schemaVersion",
		"skillId",
		"skillVersionId",
		"ownerId",
		"provider",
		"version",
		"packageObjectVersion",
		"packageDigest",
		"manifestDigest",
		"sourceProofDigest",
		"scanReceiptDigest",
		"trustRevision",
		"policyRevision",
		"signingKeyId",
	],
} as const;
function validatePublicationEvidence(
	stage: keyof typeof evidenceKeys,
	evidence: Record<string, unknown>,
) {
	const stringValue = (key: string, maximum = 1024) =>
		typeof evidence[key] === "string" &&
		(evidence[key] as string).isWellFormed() &&
		Buffer.byteLength(evidence[key] as string) <= maximum;
	const digestValue = (key: string) =>
		typeof evidence[key] === "string" &&
		/^[a-f0-9]{64}$/.test(evidence[key] as string);
	if (evidence.schemaVersion !== 1) invalid();
	if (stage === "source-proof") {
		if (
			!MagicSkillProviderOrderV1.some((item) => item === evidence.provider) ||
			!stringValue("publisherId") ||
			!stringValue("sourceVersion") ||
			!digestValue("sourceDigest") ||
			!(evidence.approvalRef === null || stringValue("approvalRef", 256)) ||
			!stringValue("trustRevision")
		)
			invalid();
	}
	if (stage === "scan") {
		const iso = (key: string) =>
			typeof evidence[key] === "string" &&
			new Date(evidence[key] as string).toISOString() === evidence[key];
		if (
			!stringValue("scannerId") ||
			!stringValue("engineVersion") ||
			!digestValue("rulesetDigest") ||
			!stringValue("policyRevision") ||
			!iso("scannedAt") ||
			!iso("expiresAt") ||
			!digestValue("packageDigest") ||
			!digestValue("manifestDigest") ||
			evidence.verdict !== "clean" ||
			typeof evidence.scannedFileCount !== "number" ||
			!Number.isSafeInteger(evidence.scannedFileCount) ||
			typeof evidence.scannedBytes !== "number" ||
			!Number.isSafeInteger(evidence.scannedBytes)
		)
			invalid();
	}
	if (stage === "signature-record") {
		for (const key of [
			"skillId",
			"skillVersionId",
			"ownerId",
			"version",
			"trustRevision",
			"policyRevision",
			"signingKeyId",
		])
			if (!stringValue(key)) invalid();
		for (const key of ["skillId", "skillVersionId", "version"])
			try {
				parseSkillHubIdV1(evidence[key]);
			} catch {
				invalid();
			}
		try {
			parseSkillHubObjectVersionV1(evidence.packageObjectVersion);
		} catch {
			invalid();
		}
		for (const key of [
			"packageDigest",
			"manifestDigest",
			"sourceProofDigest",
			"scanReceiptDigest",
		])
			if (!digestValue(key)) invalid();
		if (!MagicSkillProviderOrderV1.some((item) => item === evidence.provider))
			invalid();
	}
}
export function parseSkillPackagePublicationIntentV1(
	stage: SkillPackagePublicationStageV1,
	input: unknown,
): SkillPackagePublicationIntentV1 {
	const value = record(input);
	requireAgentManagementExactKeys(value, [
		"objectRef",
		"sizeBytes",
		"mediaType",
		"sha256",
		"evidence",
	]);
	const base = descriptor(value);
	const expectedType =
		stage === "zip"
			? "application/zip"
			: stage === "signature"
				? "application/octet-stream"
				: "application/json";
	if (
		base.mediaType !== expectedType ||
		(stage === "signature" && base.sizeBytes !== 64)
	)
		invalid();
	let evidence: Record<string, unknown> | null = null;
	if (stage in evidenceKeys) {
		evidence = record(value.evidence);
		requireAgentManagementExactKeys(
			evidence,
			evidenceKeys[stage as keyof typeof evidenceKeys],
		);
		for (const field of Object.values(evidence))
			if (
				!(
					field === null ||
					(typeof field === "number" &&
						Number.isSafeInteger(field) &&
						field >= 0) ||
					(typeof field === "string" &&
						field.isWellFormed() &&
						Buffer.byteLength(field) <= 1024)
				)
			)
				invalid();
		validatePublicationEvidence(stage as keyof typeof evidenceKeys, evidence);
	} else if (stage === "bundle") {
		evidence = record(value.evidence);
		requireAgentManagementExactKeys(evidence, [
			"schemaVersion",
			"operationId",
			"ownerId",
			"selection",
			"objects",
		]);
		if (evidence.schemaVersion !== 1) invalid();
		evidence = {
			schemaVersion: 1,
			operationId: text(evidence.operationId),
			ownerId: text(evidence.ownerId),
			selection: parseSkillPackagePublicationSelectionV1(evidence.selection),
			objects: parseObjects(evidence.objects),
		};
	} else if (value.evidence !== null) invalid();
	return Object.freeze({
		...base,
		evidence: evidence === null ? null : Object.freeze(evidence),
	});
}
function parseObjects(input: unknown) {
	const supplied = record(input);
	const objects: Partial<
		Record<SkillPackagePublicationStageV1, SkillPackagePublicationObjectV1>
	> = {};
	for (const [stage, object] of Object.entries(supplied)) {
		if (!skillPackagePublicationStagesV1.some((item) => item === stage))
			invalid();
		objects[stage as SkillPackagePublicationStageV1] =
			parseSkillPackagePublicationObjectV1(object);
	}
	return Object.freeze(objects);
}
export function parseSkillPackagePublicationStateV1(
	input: unknown,
): SkillPackagePublicationStateV1 {
	const value = record(input);
	requireAgentManagementExactKeys(value, [
		"schemaVersion",
		"operationId",
		"ownerId",
		"selection",
		"intents",
		"objects",
	]);
	if (
		value.schemaVersion !== 1 ||
		typeof value.operationId !== "string" ||
		!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.operationId)
	)
		invalid();
	const intents: Partial<
		Record<SkillPackagePublicationStageV1, SkillPackagePublicationIntentV1>
	> = {};
	for (const [stage, intent] of Object.entries(record(value.intents))) {
		if (!skillPackagePublicationStagesV1.some((item) => item === stage))
			invalid();
		intents[stage as SkillPackagePublicationStageV1] =
			parseSkillPackagePublicationIntentV1(
				stage as SkillPackagePublicationStageV1,
				intent,
			);
		if (
			intents[stage as SkillPackagePublicationStageV1]?.objectRef !==
			skillPackageObjectRefV1(
				value.operationId,
				stage as SkillPackagePublicationStageV1,
			)
		)
			invalid();
	}
	const objects = parseObjects(value.objects);
	for (const [stage, object] of Object.entries(objects)) {
		const intent = intents[stage as SkillPackagePublicationStageV1];
		const { version: _version, etag: _etag, ...actual } = object;
		if (!intent) invalid();
		const { evidence: _evidence, ...expected } = intent;
		if (!isDeepStrictEqual(actual, expected)) invalid();
	}
	return Object.freeze({
		schemaVersion: 1,
		operationId: value.operationId,
		ownerId: text(value.ownerId),
		selection: parseSkillPackagePublicationSelectionV1(value.selection),
		intents: Object.freeze(intents),
		objects,
	});
}
