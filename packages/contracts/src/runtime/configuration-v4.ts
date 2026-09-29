import { z } from "zod";

import { RuntimeModelProtocolV1Schema } from "./configuration.ts";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const reasoning = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const loopbackHttp = /^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:\/|$)/;
const dnsHostname =
	/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;
const endpoint = z
	.string()
	.min(1)
	.max(2048)
	.regex(
		/^(?:[Hh][Tt][Tt][Pp][Ss]:\/\/|http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:\/|$))/,
	)
	.refine((value) => {
		if (/[\s\\?#]/.test(value)) return false;
		try {
			const url = new URL(value);
			const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
			const httpsAuthorityAllowed =
				url.protocol === "https:" &&
				dnsHostname.test(hostname) &&
				!/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(hostname) &&
				!hostname.startsWith("[") &&
				hostname !== "localhost" &&
				!hostname.endsWith(".localhost");
			return (
				(httpsAuthorityAllowed || loopbackHttp.test(value)) &&
				!url.username &&
				!url.password &&
				!url.search &&
				!url.hash
			);
		} catch {
			return false;
		}
	});

const option = {
	modelOptionId: identifier,
	endpoint,
	model: identifier,
	reasoningLevels: z.array(reasoning).min(1).max(32),
};

export const RuntimeModelConfigurationV4Schema = z
	.strictObject({
		schemaVersion: z.literal(4),
		configVersion: identifier,
		defaultModelOptionId: identifier,
		defaultReasoningLevel: reasoning,
		modelOptions: z
			.array(
				z.discriminatedUnion("protocol", [
					z.strictObject({
						...option,
						protocol: z.literal(
							RuntimeModelProtocolV1Schema.enum["openai-responses-v1"],
						),
						authentication: z.literal("bearer"),
					}),
					z.strictObject({
						...option,
						protocol: z.literal(
							RuntimeModelProtocolV1Schema.enum["anthropic-messages-v1"],
						),
						authentication: z.enum(["bearer", "api-key"]),
					}),
				]),
			)
			.min(1)
			.max(128),
	})
	.refine(
		(value) =>
			new Set(value.modelOptions.map(({ modelOptionId }) => modelOptionId))
				.size === value.modelOptions.length &&
			value.modelOptions.every(
				({ reasoningLevels }) =>
					new Set(reasoningLevels).size === reasoningLevels.length,
			) &&
			value.modelOptions.some(
				({ modelOptionId, reasoningLevels }) =>
					modelOptionId === value.defaultModelOptionId &&
					reasoningLevels.includes(value.defaultReasoningLevel),
			),
	)
	.describe(
		"JSON Schema validates structure only. Configuration admission additionally requires endpoint URL semantics (HTTPS DNS authority without IP literals or localhost), unique modelOptionId values, unique reasoningLevels within each option, and a default option/reasoning pair present in modelOptions, as enforced by RuntimeModelConfigurationV4Schema. Passing JSON Schema validation does not replace shared semantic validation or Runtime Host admission.",
	);

export type RuntimeModelConfigurationV4 = z.infer<
	typeof RuntimeModelConfigurationV4Schema
>;
