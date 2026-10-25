import { ConnectionInstallationProjectionV1Schema } from "@agent-infra/contracts/runtime";
import type { Client } from "../../pilot/generated-v2/client/index.js";
import {
	beginPlatformConnectionInstallationV1,
	readPlatformConnectionInstallationV1,
} from "../../pilot/generated-v2/sdk.gen.js";
import type {
	BeginPlatformConnectionInstallationV1Data,
	BeginPlatformConnectionInstallationV1Response,
	ReadPlatformConnectionInstallationV1Data,
} from "../../pilot/generated-v2/types.gen.js";
import { retryablePollFailure } from "../background-read.js";

type BeginHeaders = BeginPlatformConnectionInstallationV1Data["headers"];
type ReadHeaders = ReadPlatformConnectionInstallationV1Data["headers"];

export type ConnectionInstallationProjectionV1 =
	BeginPlatformConnectionInstallationV1Response;

export type ConnectionInstallationState =
	| { kind: "idle" }
	| { kind: "loading" }
	| {
			kind: "awaiting_confirmation";
			projection: ConnectionInstallationProjectionV1;
	  }
	| { kind: "confirmed"; projection: ConnectionInstallationProjectionV1 }
	| { kind: "revoked"; projection: ConnectionInstallationProjectionV1 }
	| { kind: "expired"; projection: ConnectionInstallationProjectionV1 }
	| { kind: "unknown"; projection: ConnectionInstallationProjectionV1 }
	| { kind: "unavailable"; retryable: boolean };

export function connectionRequestHeaders(idempotencyKey: string): BeginHeaders;
export function connectionRequestHeaders(): ReadHeaders;
export function connectionRequestHeaders(
	idempotencyKey?: string,
): BeginHeaders | ReadHeaders {
	// Browser Fetch supplies Origin and Sec-Fetch-Site for same-origin POSTs;
	// JavaScript cannot set either forbidden header. Only send the CSRF marker
	// and the command idempotency key explicitly.
	return {
		"X-Platform-CSRF": "1" as const,
		...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
	} as BeginHeaders | ReadHeaders;
}

export function safeConnectionAuthorizationUrl(
	value: unknown,
): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "https:" &&
			!url.username &&
			!url.password &&
			!url.hash
			? url.toString()
			: undefined;
	} catch {
		return undefined;
	}
}

const invalidResponseMessage = "CONNECTION_INSTALLATION_INVALID_RESPONSE";

function projection(value: unknown): ConnectionInstallationProjectionV1 {
	const parsed = ConnectionInstallationProjectionV1Schema.safeParse(value);
	if (!parsed.success) throw new Error(invalidResponseMessage);
	return parsed.data;
}

/** 读到 2xx 但投影无效：不可重试（其余抛出的错误是网络中断等，可重试）。 */
export function invalidInstallationResponse(error: unknown) {
	return error instanceof Error && error.message === invalidResponseMessage;
}

function stateFromProjection(
	value: ConnectionInstallationProjectionV1,
): ConnectionInstallationState {
	return { kind: value.status, projection: value };
}

function retryable(status: number | undefined) {
	return (
		status === undefined || status >= 500 || status === 408 || status === 429
	);
}

export async function beginConnectionInstallation(options: {
	client?: Client;
	executionId: string;
	idempotencyKey?: string;
	signal?: AbortSignal;
}): Promise<ConnectionInstallationState> {
	const result = await beginPlatformConnectionInstallationV1({
		client: options.client,
		signal: options.signal,
		responseStyle: "fields",
		throwOnError: false,
		headers: connectionRequestHeaders(
			options.idempotencyKey ?? crypto.randomUUID(),
		),
		body: { schemaVersion: 1, executionId: options.executionId },
	});
	if (result.response?.status !== 202 || !result.data)
		return {
			kind: "unavailable",
			retryable: retryable(result.response?.status),
		};
	return stateFromProjection(projection(result.data));
}

export async function readConnectionInstallation(options: {
	client?: Client;
	authorizationId: string;
	signal?: AbortSignal;
}): Promise<ConnectionInstallationState> {
	const result = await readPlatformConnectionInstallationV1({
		client: options.client,
		signal: options.signal,
		responseStyle: "fields",
		throwOnError: false,
		headers: connectionRequestHeaders(),
		path: { authorizationId: options.authorizationId },
	});
	// 状态读取是轮询：与其他手写轮询同一失败分类（#3433）。
	if (result.response?.status !== 200 || !result.data)
		return {
			kind: "unavailable",
			retryable: retryablePollFailure({
				status: result.response?.status,
				error: result.error,
			}),
		};
	return stateFromProjection(projection(result.data));
}
