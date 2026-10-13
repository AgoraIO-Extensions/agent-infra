import {
	isAgentManagementText,
	requireAgentManagementExactKeys,
	snapshotAgentManagementDataObject,
} from "./agent-management-input.js";
import type { SkillHubVisibilityV1 } from "./skill-hub.js";
import {
	parseSkillHubIdempotencyKeyV1,
	parseSkillHubIdV1,
	SkillHubOperationErrorV1,
} from "./skill-hub-management.js";

export const skillHubProjectStatusesV1 = ["active", "disabled"] as const;
export type SkillHubProjectStatusV1 =
	(typeof skillHubProjectStatusesV1)[number];

export type SkillHubProjectV1 = Readonly<{
	schemaVersion: 1;
	projectId: string;
	name: string;
	ownerId: string;
	organizationId: string | null;
	status: SkillHubProjectStatusV1;
	createdAt: string;
	updatedAt: string;
}>;

export type SkillHubProjectCreateV1 = Readonly<{
	schemaVersion: 1;
	name: string;
	organizationId?: string | null;
}>;
export type SkillHubProjectUpdateV1 = Readonly<{
	schemaVersion: 1;
	name?: string;
	organizationId?: string | null;
	status?: SkillHubProjectStatusV1;
}>;

function invalid(): never {
	throw new SkillHubOperationErrorV1("invalid_input");
}
function text(value: unknown, max = 1024): string {
	if (!isAgentManagementText(value, max)) invalid();
	return value;
}
function object(value: unknown, keys: readonly string[]) {
	const result = snapshotAgentManagementDataObject(value);
	requireAgentManagementExactKeys(result, keys);
	return result;
}
function parseOrganization(value: unknown): string | null | undefined {
	if (value === undefined) return undefined;
	return value === null ? null : parseSkillHubIdV1(value);
}
export function parseSkillHubProjectCreateV1(
	input: unknown,
): SkillHubProjectCreateV1 {
	const value = object(
		input,
		Object.hasOwn((input as Record<string, unknown>) ?? {}, "organizationId")
			? ["schemaVersion", "name", "organizationId"]
			: ["schemaVersion", "name"],
	);
	if (
		value.schemaVersion !== 1 ||
		typeof value.name !== "string" ||
		!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(value.name)
	)
		invalid();
	return Object.freeze({
		schemaVersion: 1,
		name: value.name,
		...(Object.hasOwn(value, "organizationId")
			? { organizationId: parseOrganization(value.organizationId) }
			: {}),
	});
}
export function parseSkillHubProjectUpdateV1(
	input: unknown,
): SkillHubProjectUpdateV1 {
	const raw = snapshotAgentManagementDataObject(input);
	const keys = [
		"schemaVersion",
		...(Object.hasOwn(raw, "name") ? ["name"] : []),
		...(Object.hasOwn(raw, "organizationId") ? ["organizationId"] : []),
		...(Object.hasOwn(raw, "status") ? ["status"] : []),
	];
	if (keys.length === 1) invalid();
	const value = object(raw, keys);
	if (value.schemaVersion !== 1) invalid();
	if (
		Object.hasOwn(value, "name") &&
		(typeof value.name !== "string" ||
			!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(value.name))
	)
		invalid();
	if (
		Object.hasOwn(value, "status") &&
		!skillHubProjectStatusesV1.includes(value.status as SkillHubProjectStatusV1)
	)
		invalid();
	return Object.freeze({
		schemaVersion: 1,
		...(Object.hasOwn(value, "name") ? { name: text(value.name, 63) } : {}),
		...(Object.hasOwn(value, "organizationId")
			? { organizationId: parseOrganization(value.organizationId) }
			: {}),
		...(Object.hasOwn(value, "status")
			? { status: value.status as SkillHubProjectStatusV1 }
			: {}),
	});
}
export function parseSkillHubProjectIdV1(value: unknown): string {
	return parseSkillHubIdV1(value);
}
export function parseSkillHubProjectIdempotencyKeyV1(value: unknown): string {
	return parseSkillHubIdempotencyKeyV1(value);
}
export function projectVisibilityOrganizationV1(
	visibility: SkillHubVisibilityV1,
	organizationId?: string | null,
) {
	if (visibility === "ORGANIZATION" && !organizationId) invalid();
	if (visibility !== "ORGANIZATION" && organizationId !== undefined) invalid();
	return organizationId;
}
