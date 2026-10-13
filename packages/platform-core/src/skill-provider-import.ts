import { createHash } from "node:crypto";
import {
	parseSkillHubRequestV1,
	SkillHubOperationErrorV1,
	type SkillHubRequestV1,
} from "./skill-hub-management.js";
import type { SkillPackagePublicationResultV1 } from "./skill-package-publication.js";
import type {
	SkillProviderCandidateV1,
	SkillProviderRegistryV1,
} from "./skill-provider-registry.js";

export type SkillProviderImportInputV1 = Readonly<{
	schemaVersion: 1;
	name: string;
	provider: SkillProviderCandidateV1["provider"];
	version: string;
}>;
export type SkillProviderImportSelectionV1 = SkillProviderImportInputV1 &
	Readonly<{
		skillId: string;
		skillVersionId: string;
		visibility: "PRIVATE";
	}>;

export interface SkillProviderImportPortV1 {
	importVersion(
		context: SkillHubRequestV1,
		key: string,
		input: unknown,
	): Promise<SkillPackagePublicationResultV1>;
}

export type SkillProviderImportDependenciesV1 = Readonly<{
	registry: SkillProviderRegistryV1;
	admit: (input: {
		context: SkillHubRequestV1;
		key: string;
		selection: SkillProviderImportSelectionV1;
		candidate: SkillProviderCandidateV1;
	}) => Promise<SkillPackagePublicationResultV1>;
}>;

function invalid(): never {
	throw new SkillHubOperationErrorV1("invalid_input");
}

function text(value: unknown, maximum = 1024): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maximum ||
		!value.isWellFormed()
	)
		invalid();
	return value;
}

function parseInput(value: unknown): SkillProviderImportInputV1 {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	const record = value as Record<string, unknown>;
	const keys = ["schemaVersion", "name", "provider", "version"];
	if (
		Object.keys(record).some((key) => !keys.includes(key)) ||
		keys.some((key) => !Object.hasOwn(record, key)) ||
		record.schemaVersion !== 1 ||
		typeof record.provider !== "string"
	)
		invalid();
	return Object.freeze({
		schemaVersion: 1,
		name: text(record.name, 63),
		provider: record.provider as SkillProviderCandidateV1["provider"],
		version: text(record.version, 128),
	});
}

function id(prefix: string, value: string) {
	return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 48)}`;
}

export function createSkillProviderImportV1(
	dependencies: SkillProviderImportDependenciesV1,
): SkillProviderImportPortV1 {
	return {
		async importVersion(context, key, input) {
			const request = parseSkillHubRequestV1(context);
			const selection = parseInput(input);
			const candidates = await dependencies.registry.discover();
			const matches = candidates.filter(
				(candidate) =>
					candidate.provider === selection.provider &&
					candidate.name === selection.name &&
					candidate.version === selection.version,
			);
			if (matches.length !== 1) {
				// Do not reveal whether an unapproved provider or source exists.
				throw new SkillHubOperationErrorV1("unavailable");
			}
			const candidate = matches[0];
			if (!candidate) throw new SkillHubOperationErrorV1("unavailable");
			return dependencies.admit({
				context: request,
				key,
				selection: {
					...selection,
					skillId: id("skill", `${request.userId}:${selection.name}`),
					skillVersionId: id("skill-version", `${request.userId}:${key}`),
					visibility: "PRIVATE",
				},
				candidate,
			});
		},
	};
}
