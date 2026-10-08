import type { AgentManagementActorContextV1 } from "./agent-management.js";
import type { SkillHubVersionV1 } from "./skill-hub.js";
import {
	parseSkillHubIdV1,
	SkillHubOperationErrorV1,
} from "./skill-hub-management.js";

export const skillHubPrincipalTypesV1 = ["user", "organization"] as const;
export type SkillHubPrincipalTypeV1 = (typeof skillHubPrincipalTypesV1)[number];
export const skillHubInstallationStatesV1 = [
	"installed",
	"uninstalled",
	"failed",
] as const;
export type SkillHubInstallationStateV1 =
	(typeof skillHubInstallationStatesV1)[number];

export type SkillHubInstallationV1 = Readonly<{
	schemaVersion: 1;
	installationId: string;
	principalType: SkillHubPrincipalTypeV1;
	principalId: string;
	skillVersionId: string;
	state: SkillHubInstallationStateV1;
	needUpgrade: boolean;
	installedAt: string;
	updatedAt: string;
}>;

export type SkillHubInstallationCommandV1 = Readonly<{
	principalType: SkillHubPrincipalTypeV1;
	principalId: string;
	skillVersionId: string;
}>;

function invalid(): never {
	throw new SkillHubOperationErrorV1("invalid_input");
}

export function parseSkillHubPrincipalTypeV1(
	input: unknown,
): SkillHubPrincipalTypeV1 {
	if (!skillHubPrincipalTypesV1.some((item) => item === input)) invalid();
	return input as SkillHubPrincipalTypeV1;
}

export function parseSkillHubInstallationCommandV1(
	input: unknown,
): SkillHubInstallationCommandV1 {
	if (typeof input !== "object" || input === null || Array.isArray(input))
		invalid();
	const value = input as Record<string, unknown>;
	if (
		Object.keys(value).toSorted().join(",") !==
		["principalId", "principalType", "skillVersionId"].join(",")
	)
		invalid();
	return Object.freeze({
		principalType: parseSkillHubPrincipalTypeV1(value.principalType),
		principalId: parseSkillHubIdV1(value.principalId),
		skillVersionId: parseSkillHubIdV1(value.skillVersionId),
	});
}

export function canViewSkillHubVersionV1(
	version: SkillHubVersionV1,
	actor: AgentManagementActorContextV1,
	organizationId: string | null = null,
): boolean {
	if (actor.accountStatus !== "active" || version.state !== "published")
		return false;
	if (actor.isAdministrator || version.visibility === "MARKET") return true;
	if (version.visibility === "PRIVATE") return version.ownerId === actor.userId;
	return (
		version.visibility === "MEMBER" ||
		(version.visibility === "ORGANIZATION" &&
			organizationId !== null &&
			actor.organizationIds.includes(organizationId))
	);
}

export function canInstallSkillHubVersionV1(
	version: SkillHubVersionV1,
	command: SkillHubInstallationCommandV1,
	actor: AgentManagementActorContextV1,
	organizationId: string | null = null,
): boolean {
	if (!canViewSkillHubVersionV1(version, actor, organizationId)) return false;
	if (command.principalType === "user")
		return command.principalId === actor.userId;
	return (
		actor.isAdministrator || actor.organizationIds.includes(command.principalId)
	);
}

export function installSkillHubVersionV1(
	version: SkillHubVersionV1,
	command: SkillHubInstallationCommandV1,
	installationId: string,
	now: string,
): SkillHubInstallationV1 {
	if (command.skillVersionId !== version.skillVersionId)
		throw new SkillHubOperationErrorV1("invalid_input");
	if (version.state !== "published")
		throw new SkillHubOperationErrorV1("version_unavailable");
	return Object.freeze({
		schemaVersion: 1,
		installationId,
		principalType: command.principalType,
		principalId: command.principalId,
		skillVersionId: command.skillVersionId,
		state: "installed",
		needUpgrade: false,
		installedAt: now,
		updatedAt: now,
	});
}

export function uninstallSkillHubInstallationV1(
	installation: SkillHubInstallationV1,
	now: string,
): SkillHubInstallationV1 {
	return Object.freeze({
		...installation,
		state: "uninstalled",
		updatedAt: now,
	});
}

export function markSkillHubInstallationUpgradeV1(
	installation: SkillHubInstallationV1,
	latest: SkillHubVersionV1,
	installedVersion: SkillHubVersionV1,
): SkillHubInstallationV1 {
	if (
		installedVersion.skillVersionId !== installation.skillVersionId ||
		latest.skillId !== installedVersion.skillId
	)
		throw new SkillHubOperationErrorV1("invalid_input");
	if (installation.state !== "installed" || latest.state !== "published")
		throw new SkillHubOperationErrorV1("version_unavailable");
	if (latest.skillVersionId === installation.skillVersionId)
		throw new SkillHubOperationErrorV1("version_unavailable");
	return Object.freeze({ ...installation, needUpgrade: true });
}
