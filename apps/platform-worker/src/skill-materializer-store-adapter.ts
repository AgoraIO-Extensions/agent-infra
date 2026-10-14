import {
	type SkillHubAppliedReceiptV1,
	SkillHubAppliedReceiptV1Schema,
	type SkillHubSyncBindingV1,
	SkillHubSyncBindingV1Schema,
	type SkillVersionRefV1,
} from "@agent-infra/contracts";
import {
	parseSkillPackagePublicationObjectV1,
	type SkillPackagePublicationObjectV1,
} from "@agent-infra/platform-core";
import type {
	WorkloadSkillMaterializationBindingV1,
	WorkloadSkillMaterializationInputV1,
} from "./skill-materialization.js";

/**
 * The narrow Store surface consumed by the deployment adapter.  The concrete
 * PostgreSQL implementation owns authorization, current-configuration checks,
 * CAS and receipt persistence; the Worker never receives a database client.
 */
export interface SkillHubMaterializationStoreV1 {
	resolveSyncBindings(input: {
		readonly agentId: string;
		readonly agentVersion: string;
		readonly configurationRevision: number;
		readonly actorId: string;
		readonly organizationIds: readonly string[];
		readonly isAdministrator: boolean;
		/** Reconciliation facts are carried for Store implementations that fence them. */
		readonly workloadRevision?: number;
		readonly fence?: number;
	}): Promise<readonly SkillHubSyncBindingV1[]>;
	recordAppliedReceipt(input: unknown): Promise<SkillHubAppliedReceiptV1>;
}

/** Resolves the immutable ZIP descriptor for one Store Skill Version. */
export type SkillHubPackageObjectResolverV1 = (input: {
	readonly skillVersionId: string;
	readonly packageObjectVersion: string;
	readonly signal: AbortSignal;
}) => Promise<SkillPackagePublicationObjectV1 | null | undefined>;

export type SkillHubMaterializationActorFactsV1 = Readonly<{
	readonly actorId: string;
	readonly organizationIds: readonly string[];
	readonly isAdministrator: boolean;
}>;

export type SkillHubStoreMaterializationAdapterOptionsV1 = Readonly<{
	readonly store: SkillHubMaterializationStoreV1;
	/** The Agent Version is a deployment fact, never a Workload request field. */
	readonly agentVersion:
		| string
		| ((input: WorkloadSkillMaterializationInputV1) => string);
	readonly actor: SkillHubMaterializationActorFactsV1;
	readonly resolvePackageObject: SkillHubPackageObjectResolverV1;
}>;

export class SkillHubMaterializationAdapterErrorV1 extends Error {
	readonly code = "unavailable" as const;

	constructor(message = "Skill Hub materialization unavailable") {
		super(message);
		this.name = "SkillHubMaterializationAdapterErrorV1";
	}
}

const opaqueText = (value: unknown, maximum = 256): value is string =>
	typeof value === "string" &&
	value.length > 0 &&
	value.length <= maximum &&
	!value.includes("\0") &&
	!value.includes("/") &&
	!value.includes("\\") &&
	!/^\w+:\/\//u.test(value);

function positiveRevision(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function reject(message?: string): never {
	throw new SkillHubMaterializationAdapterErrorV1(message);
}

function validateActorFacts(actor: SkillHubMaterializationActorFactsV1) {
	if (!actor || !opaqueText(actor.actorId))
		reject("Invalid materialization actor");
	if (
		!Array.isArray(actor.organizationIds) ||
		actor.organizationIds.some((id) => !opaqueText(id)) ||
		typeof actor.isAdministrator !== "boolean"
	)
		reject("Invalid materialization actor");
	return Object.freeze({
		actorId: actor.actorId,
		organizationIds: Object.freeze([...actor.organizationIds]),
		isAdministrator: actor.isAdministrator,
	});
}

function resolveAgentVersion(
	value: SkillHubStoreMaterializationAdapterOptionsV1["agentVersion"],
	input: WorkloadSkillMaterializationInputV1,
): string {
	const result = typeof value === "function" ? value(input) : value;
	if (!opaqueText(result)) reject("Invalid Agent Version");
	return result;
}

function validateInput(input: WorkloadSkillMaterializationInputV1) {
	if (
		!input ||
		!opaqueText(input.agentId) ||
		!positiveRevision(input.configurationRevision) ||
		!positiveRevision(input.workloadRevision) ||
		!positiveRevision(input.fence)
	)
		reject("Invalid materialization input");
}

function validatePackageObject(
	object: unknown,
	skillVersion: SkillVersionRefV1,
): SkillPackagePublicationObjectV1 {
	let parsed: SkillPackagePublicationObjectV1;
	try {
		parsed = parseSkillPackagePublicationObjectV1(object);
	} catch {
		reject("Invalid Skill package object");
	}
	if (
		parsed.version !== skillVersion.packageObjectVersion ||
		parsed.sha256 !== skillVersion.packageDigest ||
		parsed.mediaType !== "application/zip"
	)
		reject("Skill package object mismatch");
	return parsed;
}

function validateBinding(
	binding: unknown,
	input: WorkloadSkillMaterializationInputV1,
	agentVersion: string,
): SkillHubSyncBindingV1 {
	let parsed: SkillHubSyncBindingV1;
	try {
		parsed = SkillHubSyncBindingV1Schema.parse(binding);
	} catch {
		reject("Invalid Skill binding");
	}
	if (parsed.state !== "pending_sync" && parsed.state !== "synced")
		reject("Skill binding is not current");
	if (
		parsed.agentId !== input.agentId ||
		parsed.agentVersion !== agentVersion ||
		parsed.configurationRevision !== input.configurationRevision ||
		!positiveRevision(parsed.syncRevision)
	)
		reject("Skill binding identity mismatch");
	return parsed;
}

/**
 * Bridges the Store's authorized binding contract to the existing physical
 * object-storage materializer.  All actor facts and Agent Version selection
 * are deployment-owned; no caller path, URL or identity is accepted.
 */
export function createSkillHubStoreMaterializationAdapterV1(
	options: SkillHubStoreMaterializationAdapterOptionsV1,
) {
	if (
		!options?.store ||
		typeof options.store.resolveSyncBindings !== "function" ||
		typeof options.store.recordAppliedReceipt !== "function" ||
		typeof options.resolvePackageObject !== "function" ||
		(typeof options.agentVersion !== "string" &&
			typeof options.agentVersion !== "function")
	)
		reject("Invalid Skill materialization adapter");
	const actor = validateActorFacts(options.actor);

	return {
		async resolveBindings(
			input: WorkloadSkillMaterializationInputV1,
		): Promise<readonly WorkloadSkillMaterializationBindingV1[]> {
			validateInput(input);
			input.signal?.throwIfAborted();
			const agentVersion = resolveAgentVersion(options.agentVersion, input);
			const signal = input.signal ?? new AbortController().signal;
			let bindings: readonly SkillHubSyncBindingV1[];
			try {
				bindings = await options.store.resolveSyncBindings({
					agentId: input.agentId,
					agentVersion,
					configurationRevision: input.configurationRevision,
					actorId: actor.actorId,
					organizationIds: actor.organizationIds,
					isAdministrator: actor.isAdministrator,
					workloadRevision: input.workloadRevision,
					fence: input.fence,
				});
			} catch {
				reject("Skill binding admission unavailable");
			}
			if (!Array.isArray(bindings) || bindings.length > 10)
				reject("Invalid Skill binding set");
			const names = new Set<string>();
			const result: WorkloadSkillMaterializationBindingV1[] = [];
			for (const rawBinding of bindings) {
				signal.throwIfAborted();
				const binding = validateBinding(rawBinding, input, agentVersion);
				if (names.has(binding.skillName)) reject("Duplicate Skill name");
				names.add(binding.skillName);
				let object: SkillPackagePublicationObjectV1 | null | undefined;
				try {
					object = await options.resolvePackageObject({
						skillVersionId: binding.skillVersion.skillVersionId,
						packageObjectVersion: binding.skillVersion.packageObjectVersion,
						signal,
					});
				} catch {
					reject("Skill package object unavailable");
				}
				if (!object) reject("Skill package object unavailable");
				result.push({
					agentId: binding.agentId,
					name: binding.skillName,
					agentVersion: binding.agentVersion,
					skillVersion: binding.skillVersion,
					packageObject: validatePackageObject(object, binding.skillVersion),
					grant: binding.grant,
					syncRevision: binding.syncRevision,
				});
			}
			return Object.freeze(result);
		},
		async recordAppliedReceipt(
			receipt: SkillHubAppliedReceiptV1,
		): Promise<void> {
			let parsed: SkillHubAppliedReceiptV1;
			try {
				parsed = SkillHubAppliedReceiptV1Schema.parse(receipt);
			} catch {
				reject("Invalid Skill Applied receipt");
			}
			try {
				await options.store.recordAppliedReceipt(parsed);
			} catch {
				reject("Skill Applied receipt unavailable");
			}
		},
	};
}

/** Alias matching the Worker materializer terminology used by deployment code. */
export const createSkillHubWorkloadMaterializationAdapterV1 =
	createSkillHubStoreMaterializationAdapterV1;
