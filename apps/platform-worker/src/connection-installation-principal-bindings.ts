import { OpaqueIdV1Schema } from "@agent-infra/contracts";
import {
	type RuntimeOAuthConfigurationV1,
	RuntimeOAuthScopeV1Schema,
} from "@agent-infra/contracts/runtime";
import type { createConnectionInstallationAuthorizationV1 } from "@agent-infra/platform-core";

type Approved = NonNullable<
	Awaited<
		ReturnType<
			ReturnType<
				typeof createConnectionInstallationAuthorizationV1
			>["authorize"]
		>
	>
>;

function unavailable(): never {
	throw new Error("CONNECTION_INSTALLATION_UNAVAILABLE");
}

function record(value: unknown): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

/** Adds only a deployment-approved identity check after Core authorization. */
export function createConnectionInstallationPrincipalBindingsV1(options: {
	configuration?: RuntimeOAuthConfigurationV1;
	configurationsByAgent?: Readonly<Record<string, RuntimeOAuthConfigurationV1>>;
	principalBindingsByAgent?: unknown;
}) {
	const shared = options.configuration
		? structuredClone(options.configuration)
		: undefined;
	const configurations = options.configurationsByAgent
		? new Map(Object.entries(structuredClone(options.configurationsByAgent)))
		: undefined;
	const configurationFor = (agentId: string) =>
		configurations === undefined ? shared : configurations.get(agentId);
	const mappingConfigured = options.principalBindingsByAgent !== undefined;
	const bindings = new Map<
		string,
		{ ref: string; revision: string; principals: ReadonlyMap<string, string> }
	>();
	const byUser = new Map<string, string>();
	const byConnectionPrincipal = new Map<string, string>();
	if (options.principalBindingsByAgent !== undefined) {
		if (!record(options.principalBindingsByAgent)) unavailable();
		for (const [agentId, value] of Object.entries(
			options.principalBindingsByAgent,
		)) {
			const configuration = configurationFor(agentId);
			if (
				!OpaqueIdV1Schema.safeParse(agentId).success ||
				!configuration ||
				!record(value) ||
				Object.keys(value).sort().join(",") !==
					"configuration,issuer,principals" ||
				value.issuer !== configuration.issuer ||
				!RuntimeOAuthScopeV1Schema.shape.oauthConfiguration.safeParse(
					value.configuration,
				).success ||
				!record(value.configuration) ||
				value.configuration.ref !== configuration.ref ||
				value.configuration.revision !== configuration.revision ||
				!record(value.principals)
			)
				unavailable();
			const principals = new Map<string, string>();
			for (const [userId, connectionPrincipalId] of Object.entries(
				value.principals,
			)) {
				if (
					!OpaqueIdV1Schema.safeParse(userId).success ||
					typeof connectionPrincipalId !== "string" ||
					!OpaqueIdV1Schema.safeParse(connectionPrincipalId).success
				)
					unavailable();
				const userKey = JSON.stringify([configuration.issuer, userId]);
				const principalKey = JSON.stringify([
					configuration.issuer,
					connectionPrincipalId,
				]);
				if (
					(byUser.has(userKey) &&
						byUser.get(userKey) !== connectionPrincipalId) ||
					(byConnectionPrincipal.has(principalKey) &&
						byConnectionPrincipal.get(principalKey) !== userId)
				)
					unavailable();
				byUser.set(userKey, connectionPrincipalId);
				byConnectionPrincipal.set(principalKey, userId);
				principals.set(userId, connectionPrincipalId);
			}
			bindings.set(agentId, {
				ref: configuration.ref,
				revision: configuration.revision,
				principals,
			});
		}
	}

	return (
		approved: Approved | null,
	): (Approved & { connectionPrincipalId?: string }) | null => {
		if (approved === null) return null;
		const agentId = approved.reference.agentId;
		const configuration = configurationFor(agentId);
		if (!configuration) return null;
		if (!configuration.patBinding && !mappingConfigured) return approved;
		const binding = bindings.get(agentId);
		if (
			approved.principal.kind !== "user" ||
			approved.scope.agentId !== agentId ||
			!binding ||
			binding.ref !== approved.scope.oauthConfiguration.ref ||
			binding.revision !== approved.scope.oauthConfiguration.revision
		)
			return null;
		const connectionPrincipalId = binding.principals.get(approved.principal.id);
		return connectionPrincipalId
			? { ...approved, connectionPrincipalId }
			: null;
	};
}
