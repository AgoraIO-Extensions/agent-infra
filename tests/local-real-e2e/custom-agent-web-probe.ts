import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open, readFile } from "node:fs/promises";
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

export async function readAuthorization(file: string): Promise<string> {
	if (typeof constants.O_NOFOLLOW !== "number")
		throw new Error("AUTHORIZATION_FILE_INVALID");
	let handle: FileHandle | undefined;
	try {
		handle = await open(
			file,
			constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0),
		);
		const stat = await handle.stat();
		if (
			!stat.isFile() ||
			(stat.mode & 0o077) !== 0 ||
			stat.uid !== process.getuid?.() ||
			stat.size > 8192
		)
			throw new Error("AUTHORIZATION_FILE_INVALID");
		const buffer = Buffer.alloc(8193);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead > 8192) throw new Error("AUTHORIZATION_FILE_INVALID");
		const value = new TextDecoder("utf-8", { fatal: true })
			.decode(buffer.subarray(0, bytesRead))
			.trim();
		if (!value || /[\r\n]/.test(value))
			throw new Error("AUTHORIZATION_FILE_INVALID");
		return value;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

export async function responseEvidence(response: Response, expected: string) {
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

export function isHtmlContentType(value: string | null): boolean {
	return value?.split(";", 1)[0]?.trim().toLowerCase() === "text/html";
}

const transientTransportCodes = new Set([
	"EAI_AGAIN",
	"ENOTFOUND",
	"ECONNRESET",
	"ECONNREFUSED",
	"ETIMEDOUT",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"EPIPE",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_SOCKET",
	"REQUEST_TIMEOUT",
]);
function transportFailure(error: unknown): string {
	const value = error as {
		name?: string;
		code?: string;
		cause?: { code?: string };
	};
	if (value?.name === "TimeoutError") return "REQUEST_TIMEOUT";
	const code = value?.cause?.code ?? value?.code;
	if (typeof code === "string" && transientTransportCodes.has(code))
		return code;
	if (typeof code === "string" && /CERT|TLS|SSL|SELF_SIGNED/u.test(code))
		return "TLS_INVALID";
	return "TRANSPORT_UNCLASSIFIED";
}

/** Probe only the protected application request boundary; lifecycle is separate evidence. */
export async function verifyCustomAgentWeb(
	input: ProbeInput,
	options: { transportRetryTimeoutMs?: number } = {},
) {
	const retryTimeout = options.transportRetryTimeoutMs ?? 0;
	if (
		!Number.isSafeInteger(retryTimeout) ||
		retryTimeout < 0 ||
		retryTimeout > 120_000
	)
		throw new Error("TRANSPORT_RETRY_BUDGET_INVALID");
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
		attempts: number;
		transportFailures: string[];
		error?: string;
	}[] = [];
	for (const probe of cases) {
		const deadline = Date.now() + retryTimeout;
		const transportFailures: string[] = [];
		let attempts = 0;
		for (;;) {
			attempts++;
			let receivedResponse = false;
			try {
				const response = await fetch(input.url, {
					headers: { ...probe.headers, "cache-control": "no-cache" },
					redirect: "error",
					signal: AbortSignal.timeout(
						retryTimeout
							? Math.max(1, Math.min(10_000, deadline - Date.now()))
							: 10_000,
					),
				});
				receivedResponse = true;
				const evidence = await responseEvidence(response, input.contentSha256);
				const authorized = probe.name === "authorized-content";
				const expectedStatus = authorized
					? response.status === 200
					: response.status === 401 || response.status === 403;
				const error = !expectedStatus
					? "HTTP_STATUS_UNEXPECTED"
					: authorized &&
							!isHtmlContentType(response.headers.get("content-type"))
						? "CONTENT_TYPE_MISMATCH"
						: authorized && !evidence.matches
							? "CONTENT_HASH_MISMATCH"
							: !authorized && evidence.bytes !== 0
								? "UNAUTHORIZED_BODY"
								: undefined;
				results.push({
					name: probe.name,
					status: response.status,
					pass: error === undefined,
					attempts,
					transportFailures,
					...(error ? { error } : {}),
				});
				break;
			} catch (error) {
				const code = receivedResponse
					? "CONTENT_READ_FAILED"
					: transportFailure(error);
				if (!receivedResponse) transportFailures.push(code);
				if (
					!receivedResponse &&
					transientTransportCodes.has(code) &&
					Date.now() < deadline
				) {
					await new Promise((resolve) =>
						setTimeout(resolve, Math.min(2000, deadline - Date.now())),
					);
					if (Date.now() < deadline) continue;
				}
				results.push({
					name: probe.name,
					status: null,
					pass: false,
					attempts,
					transportFailures,
					error: code,
				});
				break;
			}
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
