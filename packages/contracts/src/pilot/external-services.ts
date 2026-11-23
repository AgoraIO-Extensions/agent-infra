import { z } from "zod";

export const ExternalServiceId = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
export const ExternalServiceDiscoveryRequest = z.strictObject({
	id: ExternalServiceId,
});
export function externalServiceOrigin(input: string) {
	const url = new URL(input);
	if (
		url.protocol !== "https:" ||
		url.origin !== input.replace(/\/$/, "") ||
		!url.hostname.includes(".") ||
		url.hostname.startsWith("[") ||
		/^[.\d]+$/.test(url.hostname) ||
		url.hostname.endsWith(".localhost") ||
		url.hostname.endsWith(".")
	)
		throw Error("Invalid external service origin");
	return url.origin;
}
const revision = z.number().int().positive().max(2147483647);
export const ExternalServiceCandidate = z.strictObject({
	id: ExternalServiceId,
	modelEndpointId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
	expectedRevision: revision.or(z.literal(0)),
	url: z.string().url().max(2048),
	credential: z.string().regex(/^[\x21-\x7e]{16,8192}$/),
});
export const ExternalServiceCommand = z.strictObject({
	id: ExternalServiceId,
	revision,
	action: z.enum(["test", "enable", "disable", "discover"]),
});
export const ExternalServiceManifest = z.strictObject({
	schemaVersion: z.literal(1),
	instanceId: ExternalServiceId,
	capabilities: z
		.array(z.enum(["discovery", "execution", "model-authorization"]))
		.min(1)
		.max(3),
});
export const ExternalAuthorizations = z.strictObject({
	schemaVersion: z.literal(1),
	instanceId: ExternalServiceId,
	subjectId: z.string().min(1).max(256),
	items: z
		.array(
			z.strictObject({
				ref: z.string().min(1).max(256),
				displayName: z.string().min(1).max(128),
			}),
		)
		.max(256),
});
export const ExternalServiceView = z.strictObject({
	services: z.array(
		z.strictObject({
			id: ExternalServiceId,
			revision,
			active: revision.nullable(),
			verified: revision.nullable(),
			url: z.string(),
			modelEndpointId: z.string().nullable(),
			activeUrl: z.string().nullable(),
		}),
	),
	history: z.array(
		z.strictObject({
			actor: z.string(),
			action: z.string(),
			id: z.string(),
			revision: z.number(),
			outcome: z.string(),
			time: z.string(),
		}),
	),
});
export const ExternalServiceReceipt = z.strictObject({
	revision,
	manifest: ExternalServiceManifest.optional(),
	discovery: ExternalAuthorizations.optional(),
});
