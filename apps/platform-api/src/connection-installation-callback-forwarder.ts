import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
	RuntimeOAuthCallbackRequestV1Schema,
	RuntimeOAuthResponseV1Schema,
} from "@agent-infra/contracts/runtime";
import type { ConnectionInstallationCallbackRouteDependenciesV1 } from "./http/connection-installation-callback-routes.js";

const tokenPattern = /^[\x21-\x7e]{16,4096}$/;
const callbackPath = "/internal/runtime/oauth/v1/callback" as const;

async function readProtectedCallbackToken(path: string) {
	if (!isAbsolute(path) || resolve(path) !== path) throw new Error();
	const stats = await lstat(path);
	if (
		!stats.isFile() ||
		stats.uid !== process.getuid?.() ||
		(stats.mode & 0o777) !== 0o600 ||
		stats.size < 16 ||
		stats.size > 4096
	)
		throw new Error();
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const value = (await file.readFile("utf8")) as string;
		if (!tokenPattern.test(value)) throw new Error();
		return value;
	} finally {
		await file.close();
	}
}

async function readResponseBody(response: Response) {
	const reader = response.body?.getReader();
	if (!reader) throw new Error();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			length += part.value.byteLength;
			if (length > 16_384) throw new Error();
			chunks.push(part.value);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
	return JSON.parse(
		new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
	);
}

export type ProtectedConnectionInstallationForwarder = NonNullable<
	ConnectionInstallationCallbackRouteDependenciesV1["forward"]
>;

/**
 * Platform-owned callback-only transport. The SecretRef contains only the
 * Host callback service credential; it is never persisted or returned.
 */
export function createProtectedConnectionInstallationForwarder(options: {
	authFile: string;
	fetch?: typeof fetch;
}): ProtectedConnectionInstallationForwarder {
	return async ({ target, callbackPath: targetPath, request, signal }) => {
		if (targetPath !== callbackPath) throw new Error();
		const runtime = new URL(target.runtimeOrigin);
		if (
			runtime.protocol !== "https:" ||
			runtime.pathname !== "/" ||
			runtime.search ||
			runtime.hash ||
			runtime.username ||
			runtime.password ||
			target.expiresAt <= Date.now()
		)
			throw new Error();
		const token = await readProtectedCallbackToken(options.authFile);
		const body = JSON.stringify(
			RuntimeOAuthCallbackRequestV1Schema.parse(request),
		);
		if (Buffer.byteLength(body) > 16_384) throw new Error();
		const response = await (options.fetch ?? fetch)(
			new URL(callbackPath.slice(1), runtime),
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body,
				redirect: "error",
				signal,
			},
		);
		if (response.status !== 200 || response.redirected) throw new Error();
		const result = RuntimeOAuthResponseV1Schema.parse(
			await readResponseBody(response),
		);
		if (result.authorizationId !== target.authorizationId) throw new Error();
	};
}
