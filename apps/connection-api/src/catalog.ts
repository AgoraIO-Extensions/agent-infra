import { randomUUID } from "node:crypto";
import {
	ClientAuthorizationDenied,
	InvalidDpopProof,
	projectDirectCatalog,
} from "@agent-infra/connection-core";
import type { createConnectionCatalogRepository } from "@agent-infra/connection-store";
import { DirectCatalogResponseV1Schema } from "@agent-infra/contracts/pilot";
import type { Context, Hono } from "hono";
import {
	authenticateDirectClient,
	type ConnectionClientDependencies,
} from "./client.js";

function catalogError(context: Context, status: 401 | 503) {
	return context.json(
		{
			schemaVersion: 1,
			code: status === 401 ? "unauthorized" : "unavailable",
			message: status === 401 ? "Unauthorized" : "Connection unavailable",
			retryable: status === 503,
			traceId: randomUUID(),
		},
		status,
		{ "Cache-Control": "no-store" },
	);
}

export function addConnectionCatalogRoutes(
	app: Hono,
	client: ConnectionClientDependencies,
	repository: ReturnType<typeof createConnectionCatalogRepository>,
) {
	app.get("/api/v1/catalog", async (context) => {
		try {
			if (
				new URL(context.req.url).search ||
				[...context.req.raw.headers.keys()].some((header) =>
					/^x-(?:principal|consumer|actor|connection|grant|credential|provider|action|platform)(?:-|$)/i.test(
						header,
					),
				)
			)
				throw new ClientAuthorizationDenied();
			const binding = await authenticateDirectClient(context, client);
			const body = DirectCatalogResponseV1Schema.parse(
				projectDirectCatalog(await repository.list(), binding.scopes),
			);
			await repository.auditRead(
				binding,
				body.catalogVersion,
				body.actions.length,
			);
			const etag = `W/"${body.catalogVersion}"`;
			const headers = { "Cache-Control": "private, no-cache", ETag: etag };
			if (context.req.header("if-none-match") === etag)
				return context.body(null, 304, headers);
			return context.json(body, 200, headers);
		} catch (error) {
			return catalogError(
				context,
				error instanceof ClientAuthorizationDenied ||
					error instanceof InvalidDpopProof
					? 401
					: 503,
			);
		}
	});
}
