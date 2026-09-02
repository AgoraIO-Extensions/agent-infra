import { createHash, randomUUID } from "node:crypto";
import {
	IdempotencyKeyV1Schema,
	OpaqueCursorV1Schema,
} from "@agent-infra/contracts";
import type { PilotProtocolErrorV1 } from "@agent-infra/contracts/pilot";

export type HttpErrorStatus = 400 | 401 | 403 | 404 | 409 | 500 | 503;

type ProtocolErrorCode = PilotProtocolErrorV1["code"];

const protocolErrors = {
	INVALID_REQUEST: [400, "INVALID_REQUEST", "Request is invalid.", false],
	CONFLICT: [
		409,
		"INVALID_REQUEST",
		"Request conflicts with current state.",
		false,
	],
	FORBIDDEN: [403, "RESOURCE_UNAVAILABLE", "Request is not authorized.", false],
	AUTHENTICATION_REQUIRED: [
		401,
		"AUTHENTICATION_REQUIRED",
		"Authentication is required.",
		false,
	],
	RESOURCE_UNAVAILABLE: [
		404,
		"RESOURCE_UNAVAILABLE",
		"Resource is unavailable.",
		false,
	],
	AUTHORIZATION_REVOKED: [
		403,
		"AUTHORIZATION_REVOKED",
		"Authorization is no longer valid.",
		false,
	],
	DEPENDENCY_UNAVAILABLE: [
		503,
		"DEPENDENCY_UNAVAILABLE",
		"A required service is temporarily unavailable.",
		true,
	],
	INTERNAL_ERROR: [
		500,
		"INTERNAL_ERROR",
		"The request could not be completed.",
		true,
	],
} as const satisfies Partial<
	Record<
		ProtocolErrorCode | "CONFLICT" | "FORBIDDEN",
		readonly [HttpErrorStatus, ProtocolErrorCode, string, boolean]
	>
>;

export class HttpProtocolError extends Error {
	readonly body: PilotProtocolErrorV1;
	readonly status: HttpErrorStatus;

	constructor(code: keyof typeof protocolErrors, traceId: string) {
		const [status, wireCode, message, retryable] = protocolErrors[code];
		super(message);
		this.name = "HttpProtocolError";
		this.status = status;
		this.body = {
			schemaVersion: 1,
			code: wireCode,
			message,
			retryable,
			traceId,
		} as PilotProtocolErrorV1;
	}
}

export interface RequestMetadata {
	requestId: string;
	traceId: string;
}

export function requestMetadata(_request: Request): RequestMetadata {
	return {
		requestId: randomUUID(),
		traceId: randomUUID(),
	};
}

export function parseIdempotencyKey(request: Request, traceId: string): string {
	const parsed = IdempotencyKeyV1Schema.safeParse(
		request.headers.get("Idempotency-Key"),
	);
	if (!parsed.success) throw new HttpProtocolError("INVALID_REQUEST", traceId);
	return parsed.data;
}

export interface PageQuery {
	cursor?: string;
	limit?: number;
}

export function parsePageQuery(request: Request, traceId: string): PageQuery {
	const search = new URL(request.url).searchParams;
	if (
		[...search.keys()].some((key) => key !== "cursor" && key !== "limit") ||
		search.getAll("cursor").length > 1 ||
		search.getAll("limit").length > 1
	) {
		throw new HttpProtocolError("INVALID_REQUEST", traceId);
	}

	const cursorValue = search.get("cursor");
	const cursor =
		cursorValue === null
			? undefined
			: OpaqueCursorV1Schema.safeParse(cursorValue);
	const limitValue = search.get("limit");
	const limit = limitValue === null ? undefined : Number(limitValue);
	if (
		(cursor !== undefined && !cursor.success) ||
		(limit !== undefined &&
			(!Number.isInteger(limit) || limit < 1 || limit > 100))
	) {
		throw new HttpProtocolError("INVALID_REQUEST", traceId);
	}

	return {
		...(cursor === undefined ? {} : { cursor: cursor.data }),
		...(limit === undefined ? {} : { limit }),
	};
}

export interface JsonSchema<T> {
	safeParse(
		value: unknown,
	): { success: true; data: T } | { success: false; error: unknown };
}

export async function parseJson<T>(
	request: Request,
	schema: JsonSchema<T>,
	traceId: string,
): Promise<{ value: T; rawRequestDigest: string }> {
	if (
		request.headers
			.get("content-type")
			?.split(";", 1)[0]
			?.trim()
			.toLowerCase() !== "application/json"
	) {
		throw new HttpProtocolError("INVALID_REQUEST", traceId);
	}
	let bytes: ArrayBuffer;
	let value: unknown;
	try {
		bytes = await request.arrayBuffer();
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new HttpProtocolError("INVALID_REQUEST", traceId);
	}
	const parsed = schema.safeParse(value);
	if (!parsed.success) throw new HttpProtocolError("INVALID_REQUEST", traceId);
	return {
		value: parsed.data,
		rawRequestDigest: createHash("sha256")
			.update(new Uint8Array(bytes))
			.digest("hex"),
	};
}
