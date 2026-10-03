import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import {
	type CurrentTaskUserV1,
	parseCurrentTaskUserV1,
	type TaskUserDirectoryV1,
} from "@agent-infra/platform-core";

export class TaskIdentityUnavailableErrorV1 extends Error {
	constructor() {
		super("TASK_IDENTITY_UNAVAILABLE");
		this.name = "TaskIdentityUnavailableErrorV1";
	}
}

function requireUserId(userId: string): void {
	if (
		typeof userId !== "string" ||
		userId.length === 0 ||
		userId.includes("\0") ||
		!String.prototype.isWellFormed.call(userId) ||
		Buffer.byteLength(userId, "utf8") > 1024
	) {
		throw new TaskIdentityUnavailableErrorV1();
	}
}

function parseUser(value: unknown, userId: string): CurrentTaskUserV1 | null {
	if (value === null) return null;
	const user = parseCurrentTaskUserV1(value);
	if (user.userId !== userId) throw new TaskIdentityUnavailableErrorV1();
	return user;
}

/** Shared API/Worker boundary: never obtain authority from a saved browser Request. */
export async function resolveCurrentTaskUserV1(
	directory: TaskUserDirectoryV1 | undefined,
	userId: string,
): Promise<CurrentTaskUserV1 | null> {
	try {
		requireUserId(userId);
		if (!directory) throw new TaskIdentityUnavailableErrorV1();
		return parseUser(await directory.resolveUser(userId), userId);
	} catch {
		// Dependency exceptions can contain credentials or untrusted response bodies.
		throw new TaskIdentityUnavailableErrorV1();
	}
}

export interface HttpTaskUserDirectoryOptionsV1 {
	/** Deployment-selected HTTPS endpoint. No IdP product or endpoint path is assumed. */
	readonly endpoint: string;
	/** Authentication of this API/Worker service, never a browser or task credential. */
	readonly loadServiceAuthorization: (input: {
		readonly signal: AbortSignal;
	}) => Promise<string>;
	/**
	 * Deployment trust boundary required by engineering Spec section 9.1. Verify
	 * issuer, audience, issue/expiry time, unique context ID, key version, deployment
	 * binding and replay protection, including the fresh requestId and requested
	 * userId, before returning current business facts (or authenticated absence).
	 * Bare JSON or a TLS connection alone is not a verified identity response.
	 */
	readonly verifyResponse: (input: {
		readonly payload: unknown;
		readonly requestId: string;
		readonly userId: string;
		readonly signal: AbortSignal;
	}) => Promise<unknown | null>;
	readonly timeoutMs?: number;
	readonly fetch?: typeof globalThis.fetch;
}

const maximumResponseBytes = 64 * 1024;

async function readJson(
	response: Response,
	signal: AbortSignal,
): Promise<unknown> {
	if (
		signal.aborted ||
		response.status !== 200 ||
		response.redirected ||
		!/^application\/json(?:;|$)/i.test(
			response.headers.get("content-type") ?? "",
		) ||
		!response.body
	) {
		void response.body?.cancel().catch(() => undefined);
		throw new TaskIdentityUnavailableErrorV1();
	}
	const reader = response.body.getReader();
	const abort = () => {
		void reader.cancel().catch(() => undefined);
	};
	signal.addEventListener("abort", abort, { once: true });
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			byteLength += value.byteLength;
			if (byteLength > maximumResponseBytes)
				throw new TaskIdentityUnavailableErrorV1();
			chunks.push(value);
		}
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
		);
	} finally {
		signal.removeEventListener("abort", abort);
		void reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

/** Optional deployment HTTP protocol; not an implementation of login or an IdP. */
export function createHttpTaskUserDirectoryV1(
	options: HttpTaskUserDirectoryOptionsV1,
): TaskUserDirectoryV1 {
	let endpoint: string;
	const timeoutMs = options.timeoutMs ?? 5_000;
	const fetcher = options.fetch ?? globalThis.fetch;
	const loadServiceAuthorization = options.loadServiceAuthorization;
	const verifyResponse = options.verifyResponse;
	try {
		const url = new URL(options.endpoint);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			!Number.isInteger(timeoutMs) ||
			timeoutMs < 1 ||
			timeoutMs > 30_000 ||
			typeof fetcher !== "function" ||
			typeof loadServiceAuthorization !== "function" ||
			typeof verifyResponse !== "function"
		)
			throw new Error();
		endpoint = url.href;
	} catch {
		throw new TaskIdentityUnavailableErrorV1();
	}
	return {
		async resolveUser(userId) {
			requireUserId(userId);
			const controller = new AbortController();
			const { signal } = controller;
			const requestId = randomUUID();
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				return await Promise.race([
					(async () => {
						const authorization = await loadServiceAuthorization({ signal });
						signal.throwIfAborted();
						if (
							typeof authorization !== "string" ||
							!/^[\x20-\x7e]{1,8192}$/.test(authorization) ||
							!authorization.trim()
						)
							throw new TaskIdentityUnavailableErrorV1();
						const response = await fetcher(endpoint, {
							method: "POST",
							redirect: "error",
							credentials: "omit",
							cache: "no-store",
							referrerPolicy: "no-referrer",
							signal,
							headers: {
								authorization,
								accept: "application/json",
								"content-type": "application/json",
								"cache-control": "no-store",
							},
							body: JSON.stringify({ schemaVersion: 1, requestId, userId }),
						});
						const payload = await readJson(response, signal);
						signal.throwIfAborted();
						const value = await verifyResponse({
							payload,
							requestId,
							userId,
							signal,
						});
						signal.throwIfAborted();
						return parseUser(value, userId);
					})(),
					new Promise<never>((_resolve, reject) => {
						timer = setTimeout(() => {
							controller.abort();
							reject(new TaskIdentityUnavailableErrorV1());
						}, timeoutMs);
					}),
				]);
			} catch {
				throw new TaskIdentityUnavailableErrorV1();
			} finally {
				if (timer !== undefined) clearTimeout(timer);
				controller.abort();
			}
		},
	};
}
