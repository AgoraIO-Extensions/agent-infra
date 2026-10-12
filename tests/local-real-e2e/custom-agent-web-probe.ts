import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

interface ProbeInput {
	url: string;
	sourceSha: string;
	imageDigest: string;
	configurationRevision: string;
	contentSha256: string;
	allowedAuthorizationFile: string;
	deniedAuthorizationFile: string;
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
		"allowedAuthorizationFile",
		"deniedAuthorizationFile",
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
		!isAbsolute(parsed.allowedAuthorizationFile) ||
		!isAbsolute(parsed.deniedAuthorizationFile) ||
		parsed.configurationRevision.length > 256
	)
		throw new Error("CONFIGURATION_INVALID");
	return parsed;
}

async function readAuthorization(file: string): Promise<string> {
	const stat = await lstat(file);
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		(stat.mode & 0o077) !== 0 ||
		stat.uid !== process.getuid?.() ||
		stat.size > 8192
	)
		throw new Error("AUTHORIZATION_FILE_INVALID");
	const value = (await readFile(file, "utf8")).trim();
	if (!value || /[\r\n]/.test(value))
		throw new Error("AUTHORIZATION_FILE_INVALID");
	return value;
}

async function responseEvidence(response: Response, expected: string) {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("CONTENT_UNAVAILABLE");
	const hash = createHash("sha256");
	let bytes = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.value) {
				bytes += next.value.byteLength;
				if (bytes > 1024 * 1024) throw new Error("CONTENT_TOO_LARGE");
				hash.update(next.value);
			}
			if (next.done) break;
		}
		return {
			bytes,
			matches: bytes > 0 && hash.digest("hex") === expected,
		};
	} finally {
		await reader.cancel().catch(() => undefined);
	}
}

/** Probe only the protected application request boundary; lifecycle is separate evidence. */
export async function verifyCustomAgentWeb(input: ProbeInput) {
	const allowed = await readAuthorization(input.allowedAuthorizationFile);
	const denied = await readAuthorization(input.deniedAuthorizationFile);
	if (allowed === denied) throw new Error("DISTINCT_PRINCIPALS_REQUIRED");
	const cases: { name: string; headers: Record<string, string> }[] = [
		{ name: "anonymous", headers: {} },
		{
			name: "forged-identity",
			headers: {
				"x-user-id": "forged-user",
				"x-agent-id": "forged-agent",
				"x-forwarded-user": "forged-user",
			},
		},
		{
			name: "invalid-credential",
			headers: { authorization: "Bearer invalid-controlled-probe" },
		},
		{ name: "denied-credential", headers: { authorization: denied } },
		{ name: "authorized-content", headers: { authorization: allowed } },
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
				probe.name === "authorized-content"
					? response.status === 200 &&
						evidence.matches &&
						response.headers.get("content-type")?.includes("text/html") === true
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
		kind: "custom-agent-web-content-and-identity-probe",
		observedAt: new Date().toISOString(),
		declaredSourceSha: input.sourceSha,
		declaredImageDigest: input.imageDigest,
		declaredConfigurationRevision: input.configurationRevision,
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
		const result = await verifyCustomAgentWeb(
			parseInput(JSON.parse(await readFile(file, "utf8"))),
		);
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		if (!result.pass) process.exitCode = 1;
	} catch {
		process.stderr.write("CUSTOM_AGENT_WEB_PROBE_FAILED\n");
		process.exitCode = 1;
	}
}
