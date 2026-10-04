import { createPrivateKey, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface RuntimeHostTls {
	readonly cert: string;
	readonly key: string;
	readonly serviceDnsNames: readonly string[];
}

function invalid(): never {
	throw new Error("RUNTIME_TLS_CONFIGURATION_INVALID");
}

/** Validate before opening the listener, without exposing certificate or key bytes. */
export function validateRuntimeHostTls(input: RuntimeHostTls): void {
	try {
		if (
			!input ||
			typeof input.cert !== "string" ||
			typeof input.key !== "string" ||
			input.cert.length > 131_072 ||
			input.key.length > 32_768 ||
			!Array.isArray(input.serviceDnsNames) ||
			!input.serviceDnsNames.length ||
			new Set(input.serviceDnsNames).size !== input.serviceDnsNames.length
		)
			invalid();
		const pem = input.cert.match(
			/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
		);
		if (
			!pem?.length ||
			input.cert
				.replace(
					/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
					"",
				)
				.trim()
		)
			invalid();
		const chain = pem.map((value) => new X509Certificate(value));
		const leaf = chain[0];
		if (
			!leaf ||
			leaf.ca ||
			!leaf.keyUsage?.includes("1.3.6.1.5.5.7.3.1") ||
			!leaf.checkPrivateKey(createPrivateKey(input.key))
		)
			invalid();
		const now = Date.now();
		for (const [index, certificate] of chain.entries()) {
			if (
				now < certificate.validFromDate.getTime() ||
				now >= certificate.validToDate.getTime()
			)
				invalid();
			if (index > 0) {
				const child = chain[index - 1];
				if (
					!certificate.ca ||
					!child?.checkIssued(certificate) ||
					!child.verify(certificate.publicKey)
				)
					invalid();
			}
		}
		for (const name of input.serviceDnsNames) {
			if (
				typeof name !== "string" ||
				name.length > 253 ||
				!name
					.split(".")
					.every((part) =>
						/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(part),
					) ||
				leaf.checkHost(name, { subject: "never", wildcards: false }) !== name
			)
				invalid();
		}
	} catch {
		invalid();
	}
}

/** Only the trusted deployment sets this binding and the fixed read-only mount. */
export async function readRuntimeHostTls(
	environment: NodeJS.ProcessEnv,
): Promise<RuntimeHostTls> {
	try {
		const binding = JSON.parse(
			environment.AGENT_INFRA_RUNTIME_TLS_BINDING ?? "",
		);
		if (
			!binding ||
			Object.keys(binding).sort().join(",") !==
				"agentId,namespace,serviceDnsNames" ||
			typeof binding.agentId !== "string" ||
			!binding.agentId ||
			binding.agentId !== environment.AGENT_INFRA_RUNTIME_AGENT_ID ||
			typeof binding.namespace !== "string" ||
			!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(binding.namespace) ||
			!Array.isArray(binding.serviceDnsNames) ||
			!binding.serviceDnsNames.length ||
			!binding.serviceDnsNames.every(
				(name: unknown) =>
					typeof name === "string" &&
					name.endsWith(`.${binding.namespace}.svc`),
			)
		)
			invalid();
		const [cert, key] = await Promise.all([
			readFile("/var/run/agent-infra/runtime-tls/tls.crt", "utf8"),
			readFile("/var/run/agent-infra/runtime-tls/tls.key", "utf8"),
		]);
		const tls = { cert, key, serviceDnsNames: binding.serviceDnsNames };
		validateRuntimeHostTls(tls);
		return tls;
	} catch {
		invalid();
	}
}
