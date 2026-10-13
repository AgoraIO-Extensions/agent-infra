import type {
	CredentialForExecution,
	GitHubActionName,
} from "@agent-infra/connection-core";
import { createPinnedProviderFetch } from "../../../provider-fetch.ts";
import {
	OpenConnectorGitHubAdapter as PreviousAdapter,
	OpenConnectorGitHubOAuthAdapter as PreviousOAuthAdapter,
	githubConnectionCatalog as previousCatalog,
} from "./github-v10.ts";
import { githubV11ExecutorDigest } from "./github-v11-integrity.ts";

const logAction = "github.get_workflow_job_logs";
const maxScanBytes = 8 * 1024 * 1024;
const maxTextBytes = 64 * 1024;

export const githubV10ConnectionCatalog = previousCatalog;
export const githubV11ConnectionCatalog = {
	...previousCatalog,
	providerReleaseId: previousCatalog.providerReleaseId.replace(/-v10$/, "-v11"),
	executorDigest: githubV11ExecutorDigest,
	actions: [
		...previousCatalog.actions.map((action) => ({
			...action,
			id: action.id.replace(/@v10$/, "@v11"),
		})),
		{
			id: "github.get_workflow_job_logs@v11",
			name: logAction,
			effect: "READ",
			requiredScopes: ["repo"],
			description:
				"Read bounded GitHub Actions Job logs. Raw build logs may enter the authorized consumer/model context. Use nextStartLine for subsequent pages; scanLimitReached means the remaining log is unavailable through this bounded reader.",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				required: ["owner", "repo", "jobId"],
				properties: {
					owner: { type: "string", minLength: 1, maxLength: 100 },
					repo: { type: "string", minLength: 1, maxLength: 100 },
					jobId: {
						type: "integer",
						minimum: 1,
						maximum: Number.MAX_SAFE_INTEGER,
					},
					startLine: {
						type: "integer",
						minimum: 1,
						maximum: 8388609,
						default: 1,
					},
					maxLines: {
						type: "integer",
						minimum: 1,
						maximum: 1000,
						default: 200,
					},
				},
			},
		},
	],
} as const;

type DownloadTransport = { fetch: typeof fetch; close: () => Promise<void> };
export type GitHubLogTransportFactory = (origin: string) => DownloadTransport;

/** Old actions keep their immutable v10 execution closure. */
export class OpenConnectorGitHubAdapter extends PreviousAdapter {
	private readonly logApiFetch?: typeof fetch;
	private readonly logTransport: GitHubLogTransportFactory;
	constructor(
		logApiFetch?: typeof fetch,
		logTransport: GitHubLogTransportFactory = (origin) =>
			createPinnedProviderFetch({ origins: [origin] }),
	) {
		super(logApiFetch);
		this.logApiFetch = logApiFetch;
		this.logTransport = logTransport;
	}

	override async execute(input: {
		action: GitHubActionName;
		credential: CredentialForExecution;
		input: Record<string, unknown>;
	}) {
		if (input.action !== logAction) return super.execute(input);
		const args = validateLogInput(input.input);
		if (!input.credential.accessToken)
			throw logError("GitHub credential is unavailable", 401);
		const apiTransport = this.logApiFetch
			? undefined
			: createPinnedProviderFetch({ origins: ["https://api.github.com"] });
		const apiFetch = this.logApiFetch ?? apiTransport?.fetch;
		if (!apiFetch) throw new Error("GitHub log transport is unavailable");
		const controller = new AbortController();
		const deadline = setTimeout(() => controller.abort(), 30_000);
		let download: DownloadTransport | undefined;
		let response: Response | undefined;
		try {
			response = await apiFetch(
				`https://api.github.com/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/actions/jobs/${args.jobId}/logs`,
				{
					method: "GET",
					headers: {
						authorization: `Bearer ${input.credential.accessToken}`,
						accept: "application/vnd.github+json",
						"x-github-api-version": "2022-11-28",
					},
					redirect: "manual",
					signal: controller.signal,
				},
			);
			if (response.status === 302) {
				const url = validateDownloadUrl(response.headers.get("location"));
				await response.body?.cancel();
				download = this.logTransport(url.origin);
				response = await download.fetch(url, {
					method: "GET",
					headers: { accept: "text/plain, application/octet-stream" },
					redirect: "manual",
					signal: controller.signal,
				});
			}
			if (response.status !== 200)
				throw logError(
					response.status >= 300 && response.status < 400
						? "GitHub log redirect is not allowed"
						: "GitHub Job logs are unavailable",
					response.status,
				);
			const type = response.headers
				.get("content-type")
				?.split(";", 1)[0]
				?.trim();
			if (type !== "text/plain" && type !== "application/octet-stream")
				throw logError("GitHub Job logs returned unsupported content");
			const { text, scanLimitReached } = await readLog(
				response,
				controller.signal,
			);
			// Mask complete tokens first so self-overlapping prefixes cannot break them.
			const token = input.credential.accessToken;
			let safeText = text.replaceAll(token, "[REDACTED]");
			if (scanLimitReached) {
				for (
					let length = Math.min(token.length - 1, safeText.length);
					length > 0;
					length--
				) {
					if (safeText.endsWith(token.slice(0, length))) {
						safeText = `${safeText.slice(0, -length)}[REDACTED]`;
						break;
					}
				}
			}
			return logPage(safeText, args.startLine, args.maxLines, scanLimitReached);
		} catch (error) {
			if (error instanceof Error && "providerCode" in error) throw error;
			throw logError(
				controller.signal.aborted
					? "GitHub Job log request timed out"
					: "GitHub Job log transport failed",
				503,
			);
		} finally {
			clearTimeout(deadline);
			await response?.body?.cancel().catch(() => undefined);
			await download?.close().catch(() => undefined);
			await apiTransport?.close().catch(() => undefined);
		}
	}
}

/** The added repo READ shares the existing jobs scope, without changing OAuth identity. */
export class OpenConnectorGitHubOAuthAdapter extends PreviousOAuthAdapter {
	constructor(options: ConstructorParameters<typeof PreviousOAuthAdapter>[0]) {
		super({
			...options,
			publishedActions: options.publishedActions?.map((action) =>
				action === logAction ? "github.list_workflow_run_jobs" : action,
			),
		});
	}
}

function logError(message: string, providerStatus?: number) {
	return Object.assign(new Error(message), {
		providerCode: "github_job_logs_error",
		providerStatus,
	});
}

function validateLogInput(input: Record<string, unknown>) {
	const allowed = new Set(["owner", "repo", "jobId", "startLine", "maxLines"]);
	if (Object.keys(input).some((key) => !allowed.has(key)))
		throw logError("Invalid GitHub Job log input", 400);
	const { owner, repo, jobId, startLine = 1, maxLines = 200 } = input;
	if (
		typeof owner !== "string" ||
		typeof repo !== "string" ||
		![owner, repo].every(
			(value) =>
				/^[A-Za-z0-9_.-]{1,100}$/.test(value) &&
				value !== "." &&
				value !== "..",
		) ||
		!Number.isSafeInteger(jobId) ||
		Number(jobId) < 1 ||
		!Number.isSafeInteger(startLine) ||
		Number(startLine) < 1 ||
		Number(startLine) > maxScanBytes + 1 ||
		!Number.isSafeInteger(maxLines) ||
		Number(maxLines) < 1 ||
		Number(maxLines) > 1000
	)
		throw logError("Invalid GitHub Job log input", 400);
	return {
		owner,
		repo,
		jobId: Number(jobId),
		startLine: Number(startLine),
		maxLines: Number(maxLines),
	};
}

function validateDownloadUrl(location: string | null) {
	try {
		if (!location) throw new Error();
		const url = new URL(location);
		if (
			url.protocol !== "https:" ||
			!/^productionresultssa[0-9]+\.blob\.core\.windows\.net$/.test(
				url.hostname,
			) ||
			url.port ||
			url.username ||
			url.password ||
			url.hash
		)
			throw new Error();
		return url;
	} catch {
		throw logError("GitHub log download target is not allowed", 502);
	}
}

async function readLog(response: Response, signal: AbortSignal) {
	const reader = response.body?.getReader();
	if (!reader) return { text: "", scanLimitReached: false };
	const chunks: Uint8Array[] = [];
	let size = 0;
	let scanLimitReached = false;
	const abort = () => {
		void reader.cancel().catch(() => undefined);
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		// ponytail: bounded re-download per page; no persisted logs or cursor cache.
		for (;;) {
			signal.throwIfAborted();
			const { done, value } = await reader.read();
			signal.throwIfAborted();
			if (done) break;
			const remaining = maxScanBytes - size;
			chunks.push(value.subarray(0, remaining));
			size += Math.min(value.length, remaining);
			if (value.length > remaining) {
				scanLimitReached = true;
				await reader.cancel();
				break;
			}
		}
		return {
			text: new TextDecoder("utf-8", { fatal: true }).decode(
				Buffer.concat(chunks),
				{ stream: scanLimitReached },
			),
			scanLimitReached,
		};
	} finally {
		signal.removeEventListener("abort", abort);
		reader.releaseLock();
	}
}

function logPage(
	text: string,
	startLine: number,
	maxLines: number,
	scanLimitReached: boolean,
) {
	let offset = 0;
	for (let line = 1; line < startLine && offset < text.length; line++) {
		const newline = text.indexOf("\n", offset);
		offset = newline < 0 ? text.length : newline + 1;
	}
	const page: string[] = [];
	let bytes = 0;
	let lineTruncated = false;
	let endLine = startLine - 1;
	while (offset < text.length && page.length < maxLines) {
		const newline = text.indexOf("\n", offset);
		const nextOffset = newline < 0 ? text.length : newline + 1;
		const line = text
			.slice(offset, newline < 0 ? text.length : newline)
			.replace(/\r$/, "");
		const separator = page.length ? 1 : 0;
		const length = Buffer.byteLength(line) + separator;
		if (bytes + length > maxTextBytes) {
			if (page.length) break;
			page.push(
				new TextDecoder().decode(Buffer.from(line).subarray(0, maxTextBytes), {
					stream: true,
				}),
			);
			endLine++;
			offset = nextOffset;
			lineTruncated = true;
			break;
		}
		page.push(line);
		bytes += length;
		endLine++;
		offset = nextOffset;
	}
	if (
		scanLimitReached &&
		page.length &&
		offset === text.length &&
		!text.endsWith("\n")
	)
		lineTruncated = true;
	const knownMore = offset < text.length;
	return {
		text: page.join("\n"),
		startLine,
		endLine,
		nextStartLine: knownMore ? endLine + 1 : null,
		moreData: knownMore || scanLimitReached,
		truncated: knownMore || scanLimitReached || lineTruncated,
		scanLimitReached,
		lineTruncated,
	};
}
