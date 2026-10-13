import { timingSafeEqual } from "node:crypto";
import {
	type ExecutionGrantV1,
	type RuntimeModelDirectoryDispatchRequestV1,
	RuntimeModelDirectoryDispatchRequestV1Schema,
	type RuntimeModelDirectoryResponseV1,
	RuntimeModelDirectoryResponseV1Schema,
} from "@agent-infra/contracts/runtime";
import type { WorkerRuntimeHostClientV1 } from "./runtime-host-client.js";

function authorized(header: string | undefined, expectedToken: string) {
	if (!header?.startsWith("Bearer ")) return false;
	const supplied = Buffer.from(header.slice("Bearer ".length));
	const expected = Buffer.from(expectedToken);
	return (
		supplied.length === expected.length && timingSafeEqual(supplied, expected)
	);
}

export interface WorkerRuntimeModelDirectoryReaderV1 {
	read(
		request: RuntimeModelDirectoryDispatchRequestV1,
		signal: AbortSignal,
	): Promise<RuntimeModelDirectoryResponseV1>;
}

/**
 * Worker-owned bridge: resolve the deployment-bound RuntimeHost, issue the
 * short-lived V1 Grant, and forward the already-bound dispatch. The API never
 * supplies a Grant or a RuntimeHost URL to this function.
 */
export function createWorkerRuntimeModelDirectoryReaderV1(options: {
	readonly resolveRuntimeHost: (
		request: RuntimeModelDirectoryDispatchRequestV1,
		signal: AbortSignal,
	) => Promise<WorkerRuntimeHostClientV1>;
	readonly signGrant: (
		request: RuntimeModelDirectoryDispatchRequestV1,
	) => ExecutionGrantV1;
}): WorkerRuntimeModelDirectoryReaderV1 {
	if (
		typeof options.resolveRuntimeHost !== "function" ||
		typeof options.signGrant !== "function"
	)
		throw new TypeError("Worker model-directory reader options are invalid");
	return {
		async read(request, signal) {
			const bound = RuntimeModelDirectoryDispatchRequestV1Schema.parse(request);
			signal.throwIfAborted();
			const client = await options.resolveRuntimeHost(bound, signal);
			const response = await client.modelDirectory(
				{ ...bound, grant: options.signGrant(bound) },
				signal,
			);
			return RuntimeModelDirectoryResponseV1Schema.parse(response);
		},
	};
}

/** Authenticated API → Worker model-directory HTTP entry point. */
export function createWorkerRuntimeModelDirectoryApp(options: {
	readonly serviceToken: string;
	readonly reader: WorkerRuntimeModelDirectoryReaderV1;
}) {
	if (
		!/^[\x21-\x7e]{1,8192}$/.test(options.serviceToken) ||
		typeof options.reader?.read !== "function"
	)
		throw new TypeError("Worker model-directory app options are invalid");
	const fetch = async (request: Request) => {
		const url = new URL(request.url);
		if (url.pathname !== "/internal/worker/v1/model-directory")
			return new Response(null, { status: 404 });
		if (
			!authorized(
				request.headers.get("authorization") ?? undefined,
				options.serviceToken,
			)
		)
			return Response.json(
				{ code: "PLATFORM_WORKER_UNAUTHORIZED", retryable: false },
				{ status: 401 },
			);
		if (request.method !== "POST") return new Response(null, { status: 405 });
		const raw = await request.json().catch(() => undefined);
		const parsed = RuntimeModelDirectoryDispatchRequestV1Schema.safeParse(raw);
		if (!parsed.success)
			return Response.json(
				{ code: "PLATFORM_WORKER_MODEL_DIRECTORY_INVALID", retryable: false },
				{ status: 400 },
			);
		try {
			const response = await options.reader.read(parsed.data, request.signal);
			return Response.json(
				RuntimeModelDirectoryResponseV1Schema.parse(response),
			);
		} catch {
			return Response.json(
				{
					code: "PLATFORM_WORKER_MODEL_DIRECTORY_UNAVAILABLE",
					retryable: true,
				},
				{ status: 503 },
			);
		}
	};
	return {
		fetch,
		request(input: Request | URL, init?: RequestInit) {
			return fetch(new Request(input, init));
		},
	};
}
