import { X509Certificate } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
	RuntimeOAuthCallbackRequestV1Schema,
	RuntimeOAuthResponseV1Schema,
} from "@agent-infra/contracts/runtime";
import { Client } from "undici";
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
		const openedStats = await file.stat();
		if (
			openedStats.dev !== stats.dev ||
			openedStats.ino !== stats.ino ||
			!openedStats.isFile() ||
			openedStats.uid !== process.getuid?.() ||
			(openedStats.mode & 0o777) !== 0o600 ||
			openedStats.size < 16 ||
			openedStats.size > 4096
		)
			throw new Error();
		const value = (await file.readFile("utf8")) as string;
		if (!tokenPattern.test(value)) throw new Error();
		return value;
	} finally {
		await file.close();
	}
}

export type ProtectedConnectionInstallationForwarder = NonNullable<
	ConnectionInstallationCallbackRouteDependenciesV1["forward"]
>;

async function readHostCa(path: string) {
	const ca = await readFile(path);
	if (!new X509Certificate(ca).ca) throw new Error();
	return ca;
}

/**
 * Check the mounted transport files using the same readers as callback delivery.
 */
export async function isProtectedConnectionCallbackTransportReadyV1(
	authFile: string | undefined,
	hostCaFile: string | undefined,
): Promise<boolean> {
	if (!authFile || !hostCaFile) return false;
	try {
		await readProtectedCallbackToken(authFile);
		await readHostCa(hostCaFile);
		return true;
	} catch {
		return false;
	}
}

/**
 * Platform-owned callback-only transport. The SecretRef contains only the
 * Host callback service credential; it is never persisted or returned.
 */
export function createProtectedConnectionInstallationForwarder(options: {
	authFile: string;
	hostCaFile?: string;
}): ProtectedConnectionInstallationForwarder {
	return async ({ target, callbackPath: targetPath, request, signal }) => {
		if (targetPath !== callbackPath || target.callbackPath !== callbackPath)
			throw new Error();
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
		const ca =
			options.hostCaFile === undefined
				? undefined
				: await readHostCa(options.hostCaFile);
		const client = new Client(runtime.origin, {
			connect: {
				ca,
				rejectUnauthorized: true,
				...(ca && { minVersion: "TLSv1.3" }),
			},
			pipelining: 0,
			allowH2: false,
			maxResponseSize: 16_384,
		});
		try {
			// A consumed callback must never be automatically retried or redirected.
			const response = await client.request({
				path: callbackPath,
				method: "POST",
				idempotent: false,
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body,
				signal,
			});
			const bytes = await response.body.bytes();
			if (response.statusCode !== 200) throw new Error();
			const result = RuntimeOAuthResponseV1Schema.parse(
				JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
			);
			if (result.authorizationId !== target.authorizationId) throw new Error();
		} finally {
			await client.destroy();
		}
	};
}
