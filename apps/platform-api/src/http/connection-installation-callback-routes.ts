import { createHash } from "node:crypto";
import {
	type RuntimeOAuthCallbackRequestV1,
	RuntimeOAuthCallbackRequestV1Schema,
} from "@agent-infra/contracts/runtime";
import type {
	ConnectionInstallationCallbackClaimV1,
	createConnectionInstallationAuthorizationV1,
} from "@agent-infra/platform-core";
import type { Hono } from "hono";
import { HttpProtocolError, requestMetadata } from "./common.js";

type Installation = Pick<
	ReturnType<typeof createConnectionInstallationAuthorizationV1>,
	"callback"
>;

export interface ConnectionInstallationCallbackRouteDependenciesV1 {
	readonly publicOrigin: string;
	readonly callbackUrl: string;
	readonly issuer: string;
	readonly installation: Installation;
	/** Deployment-owned protected forwarder. It must use callback-only auth and no retry. */
	readonly forward: (input: {
		target: ConnectionInstallationCallbackClaimV1;
		callbackPath: "/internal/runtime/oauth/v1/callback";
		request: RuntimeOAuthCallbackRequestV1;
		signal: AbortSignal;
	}) => Promise<void>;
}

function stateHash(state: string) {
	return createHash("sha256").update(state).digest("hex");
}

function callbackRequest(request: Request, issuer: string) {
	const url = new URL(request.url);
	const keys = [...url.searchParams.keys()].sort().join(",");
	if (keys !== "error,iss,state" && keys !== "code,iss,state") {
		throw new HttpProtocolError(
			"INVALID_REQUEST",
			requestMetadata(request).traceId,
		);
	}
	const state = url.searchParams.get("state");
	const iss = url.searchParams.get("iss");
	const code = url.searchParams.get("code");
	const error = url.searchParams.get("error");
	if (
		["code", "error", "iss", "state"].some(
			(key) => url.searchParams.getAll(key).length > 1,
		) ||
		url.searchParams.getAll("state").length !== 1 ||
		url.searchParams.getAll("iss").length !== 1 ||
		state === null ||
		iss === null ||
		iss !== issuer ||
		(code === null) === (error === null)
	)
		throw new HttpProtocolError(
			"INVALID_REQUEST",
			requestMetadata(request).traceId,
		);
	const parsed = RuntimeOAuthCallbackRequestV1Schema.safeParse({
		schemaVersion: 1,
		state,
		issuer: iss,
		...(code === null ? { error } : { code }),
	});
	if (!parsed.success)
		throw new HttpProtocolError(
			"INVALID_REQUEST",
			requestMetadata(request).traceId,
		);
	return parsed.data;
}

export function registerConnectionInstallationCallbackRoutesV1(
	app: Hono,
	dependencies: ConnectionInstallationCallbackRouteDependenciesV1,
) {
	const publicOrigin = new URL(dependencies.publicOrigin);
	const callbackUrl = new URL(dependencies.callbackUrl);
	if (
		publicOrigin.protocol !== "https:" ||
		publicOrigin.origin !== dependencies.publicOrigin ||
		callbackUrl.protocol !== "https:" ||
		callbackUrl.origin !== dependencies.publicOrigin ||
		callbackUrl.search ||
		callbackUrl.hash ||
		callbackUrl.username ||
		callbackUrl.password ||
		!callbackUrl.pathname.startsWith("/") ||
		new URL(dependencies.issuer).protocol !== "https:" ||
		typeof dependencies.forward !== "function"
	)
		throw new Error("CONNECTION_OAUTH_CALLBACK_UNAVAILABLE");
	const path = callbackUrl.pathname;
	app.get(path, async (context) => {
		context.header("Cache-Control", "no-store");
		context.header("Referrer-Policy", "no-referrer");
		const request = context.req.raw;
		if (new URL(request.url).origin !== dependencies.publicOrigin) {
			return context.json(
				new HttpProtocolError(
					"INVALID_REQUEST",
					requestMetadata(request).traceId,
				).body,
				400,
			);
		}
		let claimed: ConnectionInstallationCallbackClaimV1 | null = null;
		let hash: string | undefined;
		try {
			const parsed = callbackRequest(request, dependencies.issuer);
			hash = stateHash(parsed.state);
			claimed = await dependencies.installation.callback.claim({
				stateHash: hash,
				now: Date.now(),
			});
			if (!claimed || claimed.issuer !== parsed.issuer) {
				if (claimed && hash)
					await dependencies.installation.callback.settle({
						stateHash: hash,
						attemptId: claimed.attemptId,
						now: Date.now(),
						status: "unknown",
					});
				throw new HttpProtocolError(
					"RESOURCE_UNAVAILABLE",
					requestMetadata(request).traceId,
				);
			}
			const forwardSignal = AbortSignal.any([
				request.signal,
				AbortSignal.timeout(10_000),
			]);
			await dependencies.forward({
				target: claimed,
				callbackPath: claimed.callbackPath,
				request: parsed,
				signal: forwardSignal,
			});
			const settled = await dependencies.installation.callback.settle({
				stateHash: hash,
				attemptId: claimed.attemptId,
				now: Date.now(),
				status: "delivered",
			});
			if (!settled)
				throw new HttpProtocolError(
					"DEPENDENCY_UNAVAILABLE",
					requestMetadata(request).traceId,
				);
			return new Response(null, { status: 204 });
		} catch (error) {
			if (hash && claimed) {
				await dependencies.installation.callback
					.settle({
						stateHash: hash,
						attemptId: claimed.attemptId,
						now: Date.now(),
						status: "unknown",
					})
					.catch(() => undefined);
			}
			const protocol =
				error instanceof HttpProtocolError
					? error
					: new HttpProtocolError(
							"DEPENDENCY_UNAVAILABLE",
							requestMetadata(request).traceId,
						);
			return context.json(protocol.body, protocol.status);
		}
	});
}
