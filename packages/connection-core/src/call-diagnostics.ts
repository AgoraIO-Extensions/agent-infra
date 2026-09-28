import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type HttpDiagnostic = {
	sequence: number;
	service: string;
	method: string;
	origin: string;
	pathTemplate: string;
	startedAt: string;
	finishedAt: string | null;
	durationMs: number | null;
	status: number | null;
	outcome: "STARTED" | "RESPONSE_HEADERS" | "TRANSPORT_ERROR";
	errorCategory: "TIMEOUT" | "ABORTED" | "TRANSPORT_ERROR" | null;
	requestIds: Array<{ name: string; value: string }>;
};
export type CallDiagnostics = {
	executionId: string;
	phase: "EXECUTE" | "RECONCILE";
	requests: HttpDiagnostic[];
	droppedRequests: number;
};
const currentDiagnostics = new AsyncLocalStorage<CallDiagnostics>();
const maxRequests = 32;
const services = new Set([
	"github",
	"github-fallback",
	"bitbucket",
	"atlassian",
	"jenkins",
	"jenkins-ci",
	"rehoboam",
	"manhattan",
	"datalego",
]);
const methods = new Set([
	"GET",
	"HEAD",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"OPTIONS",
]);
// Keep only reviewed static route segments. Identifiers, query and fragment are never retained.
const routeSegments = new Set([
	"plugins",
	"servlet",
	"applinks",
	"issue",
	"project",
	"comment",
	"attachment",
	"field",
	"transitions",
	"changelog",
	"createmeta",
	"space",
	"child",
	"descendant",
	"history",
	"version",
	"api",
	"rest",
	"v1",
	"v2",
	"v3",
	"1.0",
	"2",
	"3",
	"latest",
	"user",
	"users",
	"whoami",
	"myself",
	"projects",
	"repos",
	"repositories",
	"pulls",
	"pull-requests",
	"issues",
	"comments",
	"branches",
	"commits",
	"search",
	"content",
	"spaces",
	"pages",
	"attachments",
	"job",
	"build",
	"buildWithParameters",
	"json",
	"consoleText",
	"queue",
	"item",
	"graphql",
	"oauth",
	"token",
	"oauth2",
	"current",
	"metadata",
	"releases",
	"pipelines",
	"executions",
	"dumps",
	"symbols",
	"query",
	"status",
	"auth",
	"login",
	"profile",
	"me",
]);
const requestIdNames = [
	"x-request-id",
	"x-correlation-id",
	"x-github-request-id",
	"x-arequestid",
	"x-atlassian-request-id",
	"traceparent",
];
function validRequestId(name: string, value: unknown): value is string {
	if (typeof value !== "string" || value.length > 128) return false;
	if (name === "traceparent")
		return (
			/^00-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{2}$/.test(value) &&
			!value.includes(`-${"0".repeat(32)}-`) &&
			!value.includes(`-${"0".repeat(16)}-`)
		);
	if (!requestIdNames.includes(name)) return false;
	return (
		/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
			value,
		) ||
		/^[a-f0-9]{16,64}$/i.test(value) ||
		(name === "x-github-request-id" &&
			/^[a-f0-9]{4,16}(?::[a-f0-9]{4,16}){2,4}$/i.test(value)) ||
		(name === "x-arequestid" && /^\d{1,16}x\d{1,16}x\d{1,16}$/.test(value))
	);
}
function safeUrl(value: string) {
	try {
		const url = new URL(value);
		if (url.origin.length > 300) throw new Error();
		if (!["https:", "http:"].includes(url.protocol)) throw new Error();
		return {
			origin: url.origin,
			pathTemplate: url.pathname
				.split("/")
				.slice(0, 24)
				.map((segment) =>
					!segment || routeSegments.has(segment) ? segment : "{segment}",
				)
				.join("/"),
		};
	} catch {
		return { origin: "未记录", pathTemplate: "未记录" };
	}
}
export function newCallDiagnostics(
	phase: CallDiagnostics["phase"],
): CallDiagnostics {
	return { executionId: randomUUID(), phase, requests: [], droppedRequests: 0 };
}
export function withCallDiagnostics<T>(
	diagnostics: CallDiagnostics,
	operation: () => Promise<T>,
): Promise<T> {
	return currentDiagnostics.run(diagnostics, operation);
}

/** Wrap the actual transport, below DNS/redirect guards and separately for each fallback. */
export function observeProviderFetch(
	service: string,
	transport: typeof fetch,
): typeof fetch {
	if (!services.has(service)) throw new Error("Unknown diagnostic service");
	return async (input, init) => {
		const context = currentDiagnostics.getStore();
		if (!context) return transport(input, init);
		if (context.requests.length >= maxRequests) {
			context.droppedRequests++;
			return transport(input, init);
		}
		const method = (
			init?.method ?? (input instanceof Request ? input.method : "GET")
		).toUpperCase();
		const url = input instanceof Request ? input.url : String(input);
		const record: HttpDiagnostic = {
			sequence: context.requests.length + 1,
			service,
			method: methods.has(method) ? method : "OTHER",
			...safeUrl(url),
			startedAt: new Date().toISOString(),
			finishedAt: null,
			durationMs: null,
			status: null,
			outcome: "STARTED",
			errorCategory: null,
			requestIds: [],
		};
		context.requests.push(record);
		const started = performance.now();
		try {
			const response = await transport(input, init);
			record.status = response.status;
			record.outcome = "RESPONSE_HEADERS";
			for (const name of requestIdNames) {
				const value = response.headers.get(name);
				if (validRequestId(name, value))
					record.requestIds.push({ name, value });
			}
			return response;
		} catch (error) {
			record.outcome = "TRANSPORT_ERROR";
			const name = error instanceof Error ? error.name : "";
			record.errorCategory =
				name === "TimeoutError"
					? "TIMEOUT"
					: name === "AbortError"
						? "ABORTED"
						: "TRANSPORT_ERROR";
			throw error;
		} finally {
			record.finishedAt = new Date().toISOString();
			record.durationMs = Math.round(Math.max(0, performance.now() - started));
		}
	};
}

function isTime(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
		Number.isFinite(Date.parse(value))
	);
}
/** Re-project at storage/read boundaries; never spread an untrusted diagnostic object. */
export function projectCallDiagnostics(value: unknown): CallDiagnostics | null {
	if (!value || typeof value !== "object") return null;
	const group = value as CallDiagnostics;
	if (
		!validRequestId("x-request-id", group.executionId) ||
		!["EXECUTE", "RECONCILE"].includes(group.phase) ||
		!Array.isArray(group.requests)
	)
		return null;
	const requests: HttpDiagnostic[] = [];
	for (const row of group.requests.slice(0, maxRequests)) {
		if (
			!row ||
			!services.has(row.service) ||
			!isTime(row.startedAt) ||
			!["STARTED", "RESPONSE_HEADERS", "TRANSPORT_ERROR"].includes(row.outcome)
		)
			continue;
		requests.push({
			sequence: requests.length + 1,
			service: row.service,
			method: methods.has(row.method) ? row.method : "OTHER",
			...safeUrl(`${row.origin}${row.pathTemplate}`),
			startedAt: row.startedAt,
			finishedAt: isTime(row.finishedAt) ? row.finishedAt : null,
			durationMs:
				Number.isSafeInteger(row.durationMs) && (row.durationMs ?? -1) >= 0
					? row.durationMs
					: null,
			status:
				Number.isInteger(row.status) &&
				(row.status ?? 0) >= 100 &&
				(row.status ?? 0) <= 599
					? row.status
					: null,
			outcome: row.outcome,
			errorCategory:
				row.errorCategory &&
				["TIMEOUT", "ABORTED", "TRANSPORT_ERROR"].includes(row.errorCategory)
					? row.errorCategory
					: null,
			requestIds: Array.isArray(row.requestIds)
				? row.requestIds
						.filter((id) => id && validRequestId(id.name, id.value))
						.slice(0, 6)
						.map(({ name, value }) => ({ name, value }))
				: [],
		});
	}
	return {
		executionId: group.executionId,
		phase: group.phase,
		requests,
		droppedRequests:
			Number.isSafeInteger(group.droppedRequests) && group.droppedRequests >= 0
				? group.droppedRequests
				: 0,
	};
}
