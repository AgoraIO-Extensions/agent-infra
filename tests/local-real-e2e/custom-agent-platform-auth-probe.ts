import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import {
	isHtmlContentType,
	readAuthorization,
	responseEvidence,
} from "./custom-agent-web-probe.ts";

interface ProbeInput {
	url: string;
	sourceSha: string;
	imageDigest: string;
	configurationRevision: string;
	contentSha256: string;
	allowedRequestHeaderFile: string;
	deniedRequestHeaderFile: string;
}

export function parseInput(value: unknown): ProbeInput {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("CONFIGURATION_INVALID");
	const input = value as Record<string, unknown>;
	const names = [
		"url",
		"sourceSha",
		"imageDigest",
		"configurationRevision",
		"contentSha256",
		"allowedRequestHeaderFile",
		"deniedRequestHeaderFile",
	];
	if (
		Object.keys(input).length !== names.length ||
		names.some((name) => typeof input[name] !== "string" || !input[name])
	)
		throw new Error("CONFIGURATION_INVALID");
	const parsed = input as unknown as ProbeInput;
	const url = new URL(parsed.url);
	let normalizedPath: string;
	try {
		normalizedPath =
			decodeURIComponent(url.pathname).replace(/\/+$/, "") || "/";
	} catch {
		throw new Error("CONFIGURATION_INVALID");
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		new Set(["/healthz", "/readyz", "/livez"]).has(normalizedPath) ||
		!/^[a-f0-9]{40}$/.test(parsed.sourceSha) ||
		!/^sha256:[a-f0-9]{64}$/.test(parsed.imageDigest) ||
		!/^[a-f0-9]{64}$/.test(parsed.contentSha256) ||
		!isAbsolute(parsed.allowedRequestHeaderFile) ||
		!isAbsolute(parsed.deniedRequestHeaderFile) ||
		parsed.configurationRevision.length > 256
	)
		throw new Error("CONFIGURATION_INVALID");
	return parsed;
}

/** Probe the public platform-auth boundary; Gateway and principal provenance remain external evidence. */
export async function verifyCustomAgentPlatformAuth(input: ProbeInput) {
	const allowed = await readAuthorization(input.allowedRequestHeaderFile);
	const denied = await readAuthorization(input.deniedRequestHeaderFile);
	if (allowed === denied)
		throw new Error("DISTINCT_REQUEST_CREDENTIALS_REQUIRED");
	const cases: {
		name: string;
		expectation: "denied" | "allowed";
		headers: Record<string, string>;
	}[] = [
		{ name: "anonymous", expectation: "denied", headers: {} },
		{
			name: "forged-identity-without-credential",
			expectation: "denied",
			headers: {
				"x-user-id": "forged-user",
				"x-agent-id": "forged-agent",
				"x-agent-infra-platform-context": "forged-context",
			},
		},
		{
			name: "forged-identity-header-with-credential",
			expectation: "allowed",
			headers: {
				cookie: allowed,
				"x-user-id": "forged-user",
				"x-agent-id": "forged-agent",
				"x-agent-infra-platform-context": "forged-context",
			},
		},
		{
			name: "invalid-request-credential",
			expectation: "denied",
			headers: { cookie: "invalid-controlled-probe" },
		},
		{
			name: "denied-principal",
			expectation: "denied",
			headers: { cookie: denied },
		},
		{
			name: "authorized-content",
			expectation: "allowed",
			headers: { cookie: allowed },
		},
	];
	const results: {
		name: string;
		status: number | null;
		pass: boolean;
		error?: string;
	}[] = [];
	for (const probe of cases) {
		try {
			const response = await fetch(input.url, {
				headers: { ...probe.headers, "cache-control": "no-cache" },
				redirect: "error",
				signal: AbortSignal.timeout(10_000),
			});
			const evidence = await responseEvidence(response, input.contentSha256);
			const redirected = response.status >= 300 && response.status < 400;
			const pass =
				probe.expectation === "allowed"
					? response.status === 200 &&
						evidence.matches &&
						isHtmlContentType(response.headers.get("content-type"))
					: (response.status === 401 || response.status === 403) &&
						!redirected &&
						evidence.bytes === 0;
			results.push({ name: probe.name, status: response.status, pass });
		} catch {
			results.push({
				name: probe.name,
				status: null,
				pass: false,
				error: "REQUEST_OR_CONTENT_FAILED",
			});
		}
	}
	return {
		kind: "custom-agent-platform-auth-content-probe",
		observedAt: new Date().toISOString(),
		declaredSourceSha: input.sourceSha,
		declaredImageDigest: input.imageDigest,
		declaredConfigurationRevision: input.configurationRevision,
		declaredContentSha256: input.contentSha256,
		results,
		pass: results.every((result) => result.pass),
		lifecycleVerified: false,
		credentialPrincipalVerified: false,
	};
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		const file = process.argv[2];
		if (!file) throw new Error("CONFIGURATION_REQUIRED");
		const result = await verifyCustomAgentPlatformAuth(
			parseInput(JSON.parse(await readFile(file, "utf8"))),
		);
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		if (!result.pass) process.exitCode = 1;
	} catch {
		process.stderr.write("CUSTOM_AGENT_PLATFORM_AUTH_PROBE_FAILED\n");
		process.exitCode = 1;
	}
}
