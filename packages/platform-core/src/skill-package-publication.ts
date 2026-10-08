import { snapshotAgentManagementDataObject, requireAgentManagementExactKeys, isAgentManagementText } from "./agent-management-input.js";
import { MagicSkillProviderOrderV1, skillHubVisibilityV1, type SkillProviderIdV1, type SkillHubVisibilityV1 } from "./skill-hub.js";
import { parseSkillHubIdV1, parseSkillHubObjectVersionV1, SkillHubOperationErrorV1, type SkillHubRegistrationV1 } from "./skill-hub-management.js";

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

export const skillPackagePublicationStagesV1 = ["zip", "source-proof", "manifest", "scan", "signature-record", "signature", "bundle"] as const;
export type SkillPackagePublicationStageV1 = typeof skillPackagePublicationStagesV1[number];

export type SkillPackagePublicationObjectV1 = Readonly<{
	objectRef: string;
	version: string;
	etag: string;
	sizeBytes: number;
	mediaType: string;
	sha256: string;
}>;

export type SkillPackagePublicationStateV1 = Readonly<{
	schemaVersion: 1;
	operationId: string;
	ownerId: string;
	selection: SkillPackagePublicationSelectionV1;
	started: readonly SkillPackagePublicationStageV1[];
	objects: Readonly<Partial<Record<SkillPackagePublicationStageV1, SkillPackagePublicationObjectV1>>>;
}>;

export type SkillPackagePublicationContextV1 = Readonly<{
	state: SkillPackagePublicationStateV1;
	start: (stage: SkillPackagePublicationStageV1) => Promise<void>;
	save: (stage: SkillPackagePublicationStageV1, object: SkillPackagePublicationObjectV1) => Promise<void>;
}>;

export type SkillPackagePublicationResultV1 = Readonly<{
	registration: SkillHubRegistrationV1;
	objects: SkillPackagePublicationStateV1["objects"];
}>;

function invalid(): never { throw new SkillHubOperationErrorV1("invalid_input"); }
function text(value: unknown, maximum = 1024): string {
	if (!isAgentManagementText(value) || !value.isWellFormed() || value.length > maximum) invalid();
	return value;
}
function sha(value: unknown): string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) invalid();
	return value;
}

export function parseSkillPackagePublicationSelectionV1(input: unknown): SkillPackagePublicationSelectionV1 {
	const value = snapshotAgentManagementDataObject(input);
	requireAgentManagementExactKeys(value, ["schemaVersion", "name", "skillId", "skillVersionId", "visibility", "provider", "version", "sourceVersion", "sourceDigest", "approvalRef", "trustRevision", "policyRevision", "archiveDigest"]);
	if (value.schemaVersion !== 1 || typeof value.name !== "string" || !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(value.name) ||
		!skillHubVisibilityV1.some((item) => item === value.visibility) || !MagicSkillProviderOrderV1.some((item) => item === value.provider)) invalid();
	return Object.freeze({
		schemaVersion: 1, name: value.name, skillId: parseSkillHubIdV1(value.skillId), skillVersionId: parseSkillHubIdV1(value.skillVersionId),
		visibility: value.visibility as SkillHubVisibilityV1, provider: value.provider as SkillProviderIdV1, version: parseSkillHubIdV1(value.version),
		sourceVersion: text(value.sourceVersion), sourceDigest: sha(value.sourceDigest), approvalRef: value.approvalRef === null ? null : text(value.approvalRef, 256),
		trustRevision: text(value.trustRevision), policyRevision: text(value.policyRevision), archiveDigest: sha(value.archiveDigest),
	});
}

export function parseSkillPackagePublicationObjectV1(input: unknown): SkillPackagePublicationObjectV1 {
	const value = snapshotAgentManagementDataObject(input);
	requireAgentManagementExactKeys(value, ["objectRef", "version", "etag", "sizeBytes", "mediaType", "sha256"]);
	if (typeof value.objectRef !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.objectRef) ||
		typeof value.sizeBytes !== "number" || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0 || value.sizeBytes > 50_000_000) invalid();
	return Object.freeze({ objectRef: value.objectRef, version: parseSkillHubObjectVersionV1(value.version), etag: text(value.etag, 256), sizeBytes: value.sizeBytes, mediaType: text(value.mediaType, 128), sha256: sha(value.sha256) });
}

export function parseSkillPackagePublicationStateV1(input: unknown): SkillPackagePublicationStateV1 {
	const value = snapshotAgentManagementDataObject(input);
	requireAgentManagementExactKeys(value, ["schemaVersion", "operationId", "ownerId", "selection", "started", "objects"]);
	if (value.schemaVersion !== 1 || typeof value.operationId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.operationId) ||
		!Array.isArray(value.started) || value.started.length > skillPackagePublicationStagesV1.length || new Set(value.started).size !== value.started.length ||
		!value.started.every((stage) => skillPackagePublicationStagesV1.some((item) => item === stage))) invalid();
	const supplied = snapshotAgentManagementDataObject(value.objects);
	const objects: Partial<Record<SkillPackagePublicationStageV1, SkillPackagePublicationObjectV1>> = {};
	for (const [stage, object] of Object.entries(supplied)) {
		if (!skillPackagePublicationStagesV1.some((item) => item === stage) || !value.started.includes(stage)) invalid();
		objects[stage as SkillPackagePublicationStageV1] = parseSkillPackagePublicationObjectV1(object);
	}
	return Object.freeze({ schemaVersion: 1, operationId: value.operationId, ownerId: text(value.ownerId), selection: parseSkillPackagePublicationSelectionV1(value.selection), started: Object.freeze([...value.started]) as readonly SkillPackagePublicationStageV1[], objects: Object.freeze(objects) });
}
