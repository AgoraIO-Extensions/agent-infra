import { createHash } from "node:crypto";
import { z } from "zod";
import { OpaqueIdV1Schema } from "../index.ts";
import {
	type RuntimeOAuthConfigurationsByAgentAndPrincipalV1,
	type RuntimeOAuthConfigurationV1,
	RuntimeOAuthConfigurationV1Schema,
} from "./oauth.ts";

/** Exact parsed configuration bytes used by the protected Host publication receipt. */
export function runtimeOAuthConfigurationFingerprintV1(
	value: RuntimeOAuthConfigurationV1,
): string {
	return createHash("sha256")
		.update(JSON.stringify(RuntimeOAuthConfigurationV1Schema.parse(value)))
		.digest("hex");
}

/** Content-bound revisions are required only by the explicit per-user installation index. */
export function runtimeOAuthConfigurationRevisionV1(
	value: RuntimeOAuthConfigurationV1,
): string {
	const c = RuntimeOAuthConfigurationV1Schema.parse(value);
	const fields = {
		schemaVersion: c.schemaVersion,
		ref: c.ref,
		clientId: c.clientId,
		issuer: c.issuer,
		authorizationEndpoint: c.authorizationEndpoint,
		tokenEndpoint: c.tokenEndpoint,
		revocationEndpoint: c.revocationEndpoint,
		callbackUrl: c.callbackUrl,
		runtimeOrigin: c.runtimeOrigin,
		resource: c.resource,
		scope: c.scope,
		configFingerprint: c.configFingerprint,
		source: { ref: c.source.ref, revision: c.source.revision },
		...(c.patBinding
			? {
					patBinding: {
						consumerId: c.patBinding.consumerId,
						bindingEndpoint: c.patBinding.bindingEndpoint,
					},
				}
			: {}),
		...("clientRegistration" in c
			? {
					clientRegistration: c.clientRegistration,
					registrationEndpoint: c.registrationEndpoint,
				}
			: {}),
	};
	return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

/** A trusted snapshot; requests never supply these selectors. */
export function parseRuntimeOAuthConfigurationsByAgentAndPrincipalV1(
	value: unknown,
): RuntimeOAuthConfigurationsByAgentAndPrincipalV1 {
	const map = z
		.record(
			OpaqueIdV1Schema,
			z.record(OpaqueIdV1Schema, RuntimeOAuthConfigurationV1Schema),
		)
		.parse(value);
	const clients = new Set<string>();
	let first: RuntimeOAuthConfigurationV1 | undefined;
	for (const users of Object.values(map)) {
		for (const c of Object.values(users)) {
			const clientKey = JSON.stringify([c.issuer, c.clientId]);
			if (
				c.patBinding ||
				"clientRegistration" in c ||
				c.clientId === "dcr" ||
				new URL(c.callbackUrl).protocol !== "https:" ||
				c.revision !== runtimeOAuthConfigurationRevisionV1(c) ||
				clients.has(clientKey) ||
				(first &&
					(c.issuer !== first.issuer || c.callbackUrl !== first.callbackUrl))
			)
				throw new Error("CONNECTION_INSTALLATION_UNAVAILABLE");
			clients.add(clientKey);
			first ??= c;
		}
	}
	return map;
}
