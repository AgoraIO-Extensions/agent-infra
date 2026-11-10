import { provisionRuntimeOAuthFiles } from "./runtime-oauth-provisioning.js";

try {
	await provisionRuntimeOAuthFiles({
		dataDirectory: process.env.AGENT_INFRA_RUNTIME_DATA_DIR ?? "",
		privateDirectory: "/oauth-private",
		tlsSource: "/oauth-source-tls",
		callbackSource: "/oauth-source-callback",
		configurationBundle: JSON.parse(
			process.env.AGENT_INFRA_RUNTIME_OAUTH_PROVISIONING ?? "null",
		),
		...(process.env.AGENT_INFRA_RUNTIME_OAUTH_REGISTRATION === undefined
			? {}
			: {
					registrationDescriptor: JSON.parse(
						process.env.AGENT_INFRA_RUNTIME_OAUTH_REGISTRATION,
					),
					registrationSource: "/oauth-source-registration",
				}),
	});
} catch {
	process.stderr.write('{"code":"RUNTIME_OAUTH_PROVISIONING_UNAVAILABLE"}\n');
	// The Host rejects incomplete bootstrap; ordinary model/control startup continues.
}
