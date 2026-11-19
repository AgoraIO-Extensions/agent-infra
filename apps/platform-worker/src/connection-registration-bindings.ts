import { isDeepStrictEqual } from "node:util";
import { resolveApprovedConnectionConsumerProfileV1 } from "@agent-infra/contracts/connection-consumer-profile";
import type {
	ConnectionConsumerRegisteredBindingV1,
	ConnectionConsumerRegistrationPolicyV1,
	createConnectionInstallationAuthorizationV1,
} from "@agent-infra/platform-core";
import {
	PostgresConnectionAssociationSourceV1,
	PostgresConnectionConsumerRegistrationStoreV1,
} from "@agent-infra/platform-store";
import type { createConnectionInstallationPrincipalBindingsV1 } from "./connection-installation-principal-bindings.js";
import type { WorkerConnectionInstallationOptions } from "./runtime-oauth-request.js";

export { readConnectionConsumerSourceSelectionV1 } from "@agent-infra/platform-store";

export interface ConnectionConsumerDeploymentBindingV1 {
	readonly profile: unknown;
	readonly approval: unknown;
	readonly oauthClientBinding?: unknown;
	readonly installationSupply: unknown;
}

export type ConnectionConsumerBindingsResolverV1 = (
	signal: AbortSignal,
	registrations?: Readonly<
		Record<string, ConnectionConsumerRegisteredBindingV1>
	>,
) => Promise<Readonly<Record<string, ConnectionConsumerDeploymentBindingV1>>>;

/** Resolve a captured deployment snapshot from verified associations, never a static Consumer fallback. */
export async function resolveRegisteredConnectionConsumerBindingsV1(input: {
	readonly databaseUrl: string;
	readonly policy: ConnectionConsumerRegistrationPolicyV1;
	readonly resolve?: ConnectionConsumerBindingsResolverV1;
	readonly signal: AbortSignal;
}): Promise<Readonly<Record<string, ConnectionConsumerDeploymentBindingV1>>> {
	input.signal.throwIfAborted();
	if (!input.resolve) return {};
	const store = new PostgresConnectionConsumerRegistrationStoreV1(input);
	try {
		const original = await store.registered();
		input.signal.throwIfAborted();
		if (!Object.keys(original).length) return {};
		const supplied = structuredClone(
			await input.resolve(input.signal, structuredClone(original)),
		);
		input.signal.throwIfAborted();
		const current = await store.registered();
		input.signal.throwIfAborted();
		const result: Record<string, ConnectionConsumerDeploymentBindingV1> = {};
		for (const [agentId, binding] of Object.entries(supplied)) {
			const registered = current[agentId];
			if (
				!Object.hasOwn(original, agentId) ||
				!registered ||
				!isDeepStrictEqual(original[agentId], registered)
			)
				continue;
			const approved = resolveApprovedConnectionConsumerProfileV1(
				binding.profile,
				binding.approval,
			);
			if (
				approved.status !== "available" ||
				approved.profile.consumerId !== registered.receipt.consumerId ||
				approved.profile.publicOrigin + approved.profile.mcpPath !==
					registered.intent.resource ||
				!isDeepStrictEqual(approved.source, registered.source) ||
				// Automatic clients belong to original-user installations, not an Agent-wide client.
				binding.oauthClientBinding !== undefined
			)
				continue;
			Object.defineProperty(result, agentId, {
				value: binding,
				enumerable: true,
			});
		}
		return result;
	} finally {
		await store.close();
	}
}

/** Current Platform facts remain mandatory; deployment authorization can only add a check. */
export function bindCurrentConnectionInstallationAuthorizationV1(input: {
	readonly current: ReturnType<
		typeof createConnectionInstallationAuthorizationV1
	>["authorize"];
	readonly bindPrincipal: ReturnType<
		typeof createConnectionInstallationPrincipalBindingsV1
	>;
	readonly additional?: WorkerConnectionInstallationOptions["authorize"];
}): WorkerConnectionInstallationOptions["authorize"] {
	return async (request, signal, finalCheck) => {
		const additional: {
			value: Awaited<
				ReturnType<WorkerConnectionInstallationOptions["authorize"]>
			>;
		} = { value: null };
		try {
			const current = await input.current(request, signal, async () => {
				if (input.additional) {
					additional.value = await input.additional(
						request,
						signal,
						finalCheck,
					);
					if (!additional.value)
						throw new Error("CONNECTION_INSTALLATION_UNAVAILABLE");
				}
				await finalCheck();
			});
			signal.throwIfAborted();
			if (!current) return null;
			if (!input.additional) return input.bindPrincipal(current);
			const approved = additional.value;
			const fields = [
				"principal",
				"reference",
				"scope",
				"authorizationId",
				"command",
				"revision",
				"commandId",
				"attemptId",
				"attemptOwner",
			] as const;
			if (
				!approved ||
				fields.some((key) => !isDeepStrictEqual(approved[key], current[key]))
			)
				return null;
			return {
				...current,
				connectionPrincipalId: approved.connectionPrincipalId,
			};
		} catch {
			return null;
		}
	};
}

/**
 * Current-source check for a Worker that started with a static or shared Consumer
 * selection (Spec §13.5.7). It returns false for an Agent selected as legacy at startup
 * that now has an Owner association or registration (current or disconnected), so the
 * cached Consumer is not delivered. Without a startup legacy set, every Agent was
 * selected as legacy. Source errors throw; callers fail closed.
 */
export function createStartupConnectionSelectionGuardV1(input: {
	readonly source?: { persistent(agentId: string): Promise<boolean> };
	readonly startupLegacyAgentIds?: ReadonlySet<string>;
}): (agentId: string) => Promise<boolean> {
	const { source, startupLegacyAgentIds } = input;
	return async (agentId) => {
		if (
			!source ||
			(startupLegacyAgentIds !== undefined &&
				!startupLegacyAgentIds.has(agentId))
		)
			return true;
		return !(await source.persistent(agentId));
	};
}

/**
 * Opens the current-source check used by every delivery of a startup-selected static or
 * shared Consumer snapshot: business Runtime resolution, Agent Workload apply, Session
 * Sandbox and reserve Pod provisioning (Spec §13.5.7). Close it with the deployment.
 */
export function openStartupConnectionDeliveryGuardV1(input: {
	readonly databaseUrl: string;
	readonly startupLegacyAgentIds?: ReadonlySet<string>;
	readonly manualRevisions?: ReadonlyMap<string, number>;
	readonly checkLegacy?: boolean;
}): {
	readonly current: (agentId: string) => Promise<boolean>;
	readonly close: () => Promise<void>;
} {
	const source = new PostgresConnectionAssociationSourceV1({
		databaseUrl: input.databaseUrl,
	});
	const legacyCurrent = createStartupConnectionSelectionGuardV1({
		source,
		...(input.startupLegacyAgentIds
			? { startupLegacyAgentIds: input.startupLegacyAgentIds }
			: {}),
	});
	return {
		current: (agentId) => {
			const revision = input.manualRevisions?.get(agentId);
			if (revision !== undefined)
				return source.manualCurrent(agentId, revision);
			return input.checkLegacy === false
				? Promise.resolve(true)
				: legacyCurrent(agentId);
		},
		close: () => source.close(),
	};
}
