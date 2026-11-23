import { timingSafeEqual } from "node:crypto";
import {
	type RuntimeSavedKeyCandidatesRequestV1,
	RuntimeSavedKeyCandidatesRequestV1Schema,
	RuntimeSavedKeyCandidatesResponseV1Schema,
} from "@agent-infra/contracts/runtime";

function authorized(header: string | undefined, expectedToken: string) {
	if (!header?.startsWith("Bearer ")) return false;
	const supplied = Buffer.from(header.slice("Bearer ".length));
	const expected = Buffer.from(expectedToken);
	return (
		supplied.length === expected.length && timingSafeEqual(supplied, expected)
	);
}

export interface WorkerSavedKeyCandidatesReaderV1 {
	read(
		request: RuntimeSavedKeyCandidatesRequestV1,
		signal: AbortSignal,
	): Promise<unknown>;
}

/**
 * Worker-owned saved-Key seam. The reader owns transient decrypt and candidate
 * validation; this HTTP adapter only authenticates the API caller and returns
 * the bounded candidate projection. Plaintext and ciphertext never cross it.
 */
export function createWorkerSavedKeyCandidatesApp(options: {
	readonly serviceToken: string;
	readonly reader: WorkerSavedKeyCandidatesReaderV1;
}) {
	if (
		!/^[\x21-\x7e]{1,8192}$/.test(options.serviceToken) ||
		typeof options.reader?.read !== "function"
	)
		throw new TypeError("Worker saved-Key candidates options are invalid");
	return {
		async fetch(request: Request) {
			const url = new URL(request.url);
			if (url.pathname !== "/internal/worker/v1/saved-key-candidates")
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
			const parsed = RuntimeSavedKeyCandidatesRequestV1Schema.safeParse(raw);
			if (!parsed.success)
				return Response.json(
					{
						code: "PLATFORM_WORKER_SAVED_KEY_CANDIDATES_INVALID",
						retryable: false,
					},
					{ status: 400 },
				);
			try {
				const response = RuntimeSavedKeyCandidatesResponseV1Schema.parse(
					await options.reader.read(parsed.data, request.signal),
				);
				if (
					response.agentId !== parsed.data.agentId ||
					response.configurationRevision !==
						parsed.data.configurationRevision ||
					(response.keyVersion !== parsed.data.keyVersion &&
						parsed.data.keyVersion !== null)
				)
					throw new Error(
						"PLATFORM_WORKER_SAVED_KEY_CANDIDATES_BINDING_INVALID",
					);
				return Response.json(response);
			} catch {
				return Response.json(
					{
						code: "PLATFORM_WORKER_SAVED_KEY_CANDIDATES_UNAVAILABLE",
						retryable: true,
					},
					{ status: 503 },
				);
			}
		},
	};
}
