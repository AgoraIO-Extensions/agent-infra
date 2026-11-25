import { createHash, timingSafeEqual } from "node:crypto";
import { ConnectionRegistrationOwnerV1Schema } from "@agent-infra/contracts";
import type { ConnectionRegistrationOwnerV1 } from "@agent-infra/platform-core";
import type { Hono } from "hono";

export interface ConnectionRegistrationOwnerRoutesV1 {
	readonly credentialHash: string;
	readonly read: (
		source: string,
		agent: string,
		purpose: "create" | "read" | "disable" | "delete",
		signal: AbortSignal,
	) => Promise<ConnectionRegistrationOwnerV1 | undefined>;
}

/** Machine-only metadata; never invokes browser identity or provisions an account. */
export function registerConnectionRegistrationOwnerRoutesV1(
	app: Hono,
	input: ConnectionRegistrationOwnerRoutesV1,
) {
	if (
		!/^[a-f0-9]{64}$/.test(input.credentialHash) ||
		typeof input.read !== "function"
	)
		throw new Error("CONNECTION_REGISTRATION_OWNER_CONFIGURATION_INVALID");
	const root = "/api/internal/connection-registration/v1/owners";
	app.get(`${root}/:sourceNamespace/:platformAgentId`, async (c) => {
		c.header("cache-control", "no-store");
		const failure = (status: 400 | 401 | 404 | 503) =>
			c.json(
				{
					error: {
						code:
							status === 404
								? "RESOURCE_NOT_FOUND"
								: "CONNECTION_REGISTRATION_OWNER_UNAVAILABLE",
					},
				},
				status,
			);
		const token = /^Bearer (conn_platform_owner_[A-Za-z0-9_-]{43})$/.exec(
			c.req.header("authorization") ?? "",
		)?.[1];
		if (
			!token ||
			c.req.header("cookie") !== undefined ||
			c.req.header("origin") !== undefined ||
			!timingSafeEqual(
				createHash("sha256").update(token).digest(),
				Buffer.from(input.credentialHash, "hex"),
			)
		)
			return failure(401);
		const url = new URL(c.req.url);
		const purpose = url.searchParams.get("purpose");
		if (
			c.req.raw.body !== null ||
			c.req.header("transfer-encoding") !== undefined ||
			(c.req.header("content-length") !== undefined &&
				c.req.header("content-length") !== "0") ||
			url.searchParams.size !== 1 ||
			!["create", "read", "disable", "delete"].includes(purpose ?? "")
		)
			return failure(400);
		const source = c.req.param("sourceNamespace");
		const agent = c.req.param("platformAgentId");
		if (
			![source, agent].every((v) =>
				/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(v),
			) ||
			url.pathname !==
				`${root}/${encodeURIComponent(source)}/${encodeURIComponent(agent)}`
		)
			return failure(400);
		const deadline = new AbortController();
		const timeout = setTimeout(() => deadline.abort(), 5000);
		const signal = AbortSignal.any([c.req.raw.signal, deadline.signal]);
		let abort = () => {};
		const aborted = new Promise<never>((_, reject) => {
			abort = () =>
				reject(new Error("CONNECTION_REGISTRATION_OWNER_UNAVAILABLE"));
		});
		signal.addEventListener("abort", abort, { once: true });
		try {
			signal.throwIfAborted();
			const owner = await Promise.race([
				input.read(
					source,
					agent,
					purpose as "create" | "read" | "disable" | "delete",
					signal,
				),
				aborted,
			]);
			signal.throwIfAborted();
			return owner
				? c.json(ConnectionRegistrationOwnerV1Schema.parse(owner))
				: failure(404);
		} catch {
			return failure(503);
		} finally {
			clearTimeout(timeout);
			signal.removeEventListener("abort", abort);
		}
	});
}
