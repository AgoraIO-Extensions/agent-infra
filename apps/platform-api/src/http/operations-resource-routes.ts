import {
	type OperationsHistoryQueryV2,
	OperationsHistoryQueryV2Schema,
	OperationsHistoryV2Schema,
	type OperationsResourceQueryV2,
	OperationsResourceQueryV2Schema,
	OperationsResourcesV2Schema,
} from "@agent-infra/contracts/pilot";
import { OperationsScopeErrorV2 } from "@agent-infra/platform-core";
import type { Hono } from "hono";
import { HttpProtocolError, requestMetadata } from "./common.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";

export interface OperationsResourceRoutesDependenciesV2 {
	readonly identity: IdentityAdapter;
	readonly operations?: {
		history?(
			input: OperationsHistoryQueryV2,
			signal: AbortSignal,
		): Promise<unknown>;
		read(
			input: OperationsResourceQueryV2,
			signal?: AbortSignal,
		): Promise<unknown>;
	};
}

export function registerOperationsResourceRoutesV2(
	app: Hono,
	dependencies: OperationsResourceRoutesDependenciesV2,
): void {
	app.get("/api/v2/ops/history", async (context) => {
		const metadata = requestMetadata(context.req.raw);
		const identity = await resolveIdentity(
			dependencies.identity,
			context.req.raw,
			metadata.traceId,
		);
		if (!identity.roles.includes("system_admin"))
			throw new HttpProtocolError("FORBIDDEN", metadata.traceId);
		const query = OperationsHistoryQueryV2Schema.safeParse(context.req.query());
		if (!query.success || Date.parse(query.data.end) > Date.now() + 60_000)
			throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
		if (!dependencies.operations?.history)
			throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
		try {
			const value = await dependencies.operations.history(
				query.data,
				AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(10_000)]),
			);
			return context.json(OperationsHistoryV2Schema.parse(value));
		} catch (error) {
			if (error instanceof OperationsScopeErrorV2)
				throw new HttpProtocolError("FORBIDDEN", metadata.traceId);
			throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
		}
	});
	app.get("/api/v2/ops/resources", async (context) => {
		const metadata = requestMetadata(context.req.raw);
		const identity = await resolveIdentity(
			dependencies.identity,
			context.req.raw,
			metadata.traceId,
		);
		if (!identity.roles.includes("system_admin"))
			throw new HttpProtocolError("FORBIDDEN", metadata.traceId);
		const query = OperationsResourceQueryV2Schema.safeParse(
			context.req.query(),
		);
		if (!query.success)
			throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
		if (!dependencies.operations)
			throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
		try {
			const value = await dependencies.operations.read(
				query.data,
				AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(5000)]),
			);
			const result = OperationsResourcesV2Schema.safeParse(value);
			if (!result.success) throw new Error();
			return context.json(result.data);
		} catch (error) {
			if (error instanceof OperationsScopeErrorV2)
				throw new HttpProtocolError("FORBIDDEN", metadata.traceId);
			throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
		}
	});
}
