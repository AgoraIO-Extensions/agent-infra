import type { Hono } from "hono";

const v2ManagementPaths = [
	/^\/api\/v2\/agents$/,
	/^\/api\/v2\/agents\/[^/]+$/,
	/^\/api\/v2\/agents\/[^/]+\/configuration$/,
	/^\/api\/v2\/agents\/[^/]+\/lifecycle$/,
	/^\/api\/v2\/agent-applications$/,
	/^\/api\/v2\/agent-applications\/[^/]+$/,
	/^\/api\/v2\/agent-applications\/[^/]+\/withdraw$/,
	/^\/api\/v2\/admin\/agent-applications$/,
	/^\/api\/v2\/admin\/agent-applications\/[^/]+\/decision$/,
];

const v2ConversationPaths = [
	/^\/api\/v2\/conversations\/[^/]+$/,
	/^\/api\/v2\/conversations\/[^/]+\/events$/,
	/^\/api\/v2\/conversations\/[^/]+\/executions\/[^/]+$/,
];

function isSupportedV2Path(pathname: string): boolean {
	return [...v2ManagementPaths, ...v2ConversationPaths].some((pattern) =>
		pattern.test(pathname),
	);
}

function v2RequestBody(
	pathname: string,
	method: string,
	body: string,
): string | null {
	if (!body || (method !== "POST" && method !== "PUT")) return body;
	let value: unknown;
	try {
		value = JSON.parse(body);
	} catch {
		return body;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return body;
	const input = value as Record<string, unknown>;
	if (
		(method === "POST" || method === "PUT") &&
		(pathname === "/api/v2/agent-applications" ||
			/^\/api\/v2\/agent-applications\/[^/]+$/.test(pathname))
	) {
		if (input.schemaVersion !== 2) return null;
		return JSON.stringify({
			...input,
			schemaVersion: 1,
			actions: input.actions ?? [],
		});
	}
	if (
		method === "PUT" &&
		/^\/api\/v2\/agents\/[^/]+\/configuration$/.test(pathname)
	) {
		if (input.schemaVersion !== 2) return null;
		return JSON.stringify({ ...input, schemaVersion: 1 });
	}
	return body;
}

function v2AgentProjection(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const input = value as Record<string, unknown>;
	const configuration = input.configuration;
	if (!configuration || typeof configuration !== "object") return value;
	const { actions: _actions, ...v2Configuration } = configuration as Record<
		string,
		unknown
	>;
	return {
		...input,
		schemaVersion: 2,
		configuration: v2Configuration,
	};
}

function v2ManagementPayload(pathname: string, value: unknown): unknown {
	if (
		!v2ManagementPaths.some((pattern) => pattern.test(pathname)) ||
		!value ||
		typeof value !== "object"
	) {
		return value;
	}
	const input = value as Record<string, unknown>;
	if (Array.isArray(input.items)) {
		return { ...input, items: input.items.map(v2AgentProjection) };
	}
	return v2AgentProjection(value);
}

async function rewriteV2Request(
	request: Request,
	pathname: string,
): Promise<Request | null> {
	const url = new URL(request.url);
	url.pathname = pathname.replace(/^\/api\/v2(?=\/|$)/, "/api/v1");
	const search = url.searchParams;
	const ownerScope = search.get("scope");
	if (ownerScope !== null) search.delete("scope");
	const headers = new Headers(request.headers);
	headers.set("x-agent-infra-v2", "1");
	if (ownerScope !== null) headers.set("x-agent-infra-v2-scope", ownerScope);
	if (request.method === "GET" || request.method === "HEAD") {
		return new Request(url, {
			method: request.method,
			headers,
			signal: request.signal,
		});
	}
	const body = await request.clone().text();
	const rewrittenBody = v2RequestBody(pathname, request.method, body);
	if (rewrittenBody === null) return null;
	headers.delete("content-length");
	return new Request(url, {
		method: request.method,
		headers,
		body: rewrittenBody,
		signal: request.signal,
	});
}

async function proxyV2Request(
	app: Hono,
	request: Request,
	pathname: string,
): Promise<Response> {
	const requestedScope = new URL(request.url).searchParams.get("scope");
	const search = new URL(request.url).searchParams;
	if (
		search.getAll("scope").length > 1 ||
		(requestedScope !== null && requestedScope !== "owner") ||
		(requestedScope !== null && pathname !== "/api/v2/agents")
	) {
		return new Response(null, { status: 400 });
	}
	const rewritten = await rewriteV2Request(request, pathname);
	if (!rewritten) return new Response(null, { status: 400 });
	const response = await app.fetch(rewritten);
	if (
		!v2ManagementPaths.some((pattern) => pattern.test(pathname)) ||
		!response.ok ||
		!(response.headers.get("content-type") ?? "").includes("application/json")
	) {
		return response;
	}
	const text = await response.text();
	if (!text) return new Response(null, response);
	try {
		const value = v2ManagementPayload(pathname, JSON.parse(text));
		const headers = new Headers(response.headers);
		headers.delete("content-length");
		headers.set("content-type", "application/json");
		return new Response(JSON.stringify(value), {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	} catch {
		return new Response(text, response);
	}
}

/** Mount the public V2 paths while preserving the existing V1 use cases. */
export function registerV2CompatibilityRoutes(app: Hono): void {
	app.all("/api/v2/*", async (context) => {
		const pathname = new URL(context.req.url).pathname;
		if (!isSupportedV2Path(pathname))
			return new Response(null, { status: 404 });
		return proxyV2Request(app, context.req.raw, pathname);
	});
}
