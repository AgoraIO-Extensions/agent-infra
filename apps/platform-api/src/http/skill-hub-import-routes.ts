import {
	SkillHubProviderImportRequestV1Schema,
	SkillHubProviderImportResponseV1Schema,
} from "@agent-infra/contracts/pilot";
import type {
	SkillHubRequestV1,
	SkillHubVersionV1,
	SkillProviderImportPortV1,
} from "@agent-infra/platform-core";
import type { Context, Hono } from "hono";
import {
	HttpProtocolError,
	parseIdempotencyKey,
	parseJson,
	requestMetadata,
} from "./common.js";
import { mapCoreError } from "./core-errors.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";

export interface SkillHubImportRoutesDependenciesV1 {
	readonly identity: IdentityAdapter;
	readonly importer: SkillProviderImportPortV1;
}

function publicResponse(result: {
	replayed: boolean;
	version: SkillHubVersionV1;
}) {
	const {
		packageObjectVersion: _location,
		ownerId: _owner,
		...version
	} = result.version;
	const parsed = SkillHubProviderImportResponseV1Schema.safeParse({
		replayed: result.replayed,
		version,
	});
	if (!parsed.success) throw new Error("Invalid Skill Hub import projection");
	return parsed.data;
}

export function registerSkillHubImportRoutesV1(
	app: Hono,
	dependencies: SkillHubImportRoutesDependenciesV1,
) {
	app.post("/api/v2/skills/imports", async (context: Context) => {
		const request = context.req.raw;
		const metadata = requestMetadata(request);
		try {
			if (request.headers.has("Authorization"))
				throw new HttpProtocolError(
					"AUTHENTICATION_REQUIRED",
					metadata.traceId,
				);
			if (new URL(request.url).search !== "")
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			const identity = await resolveIdentity(
				dependencies.identity,
				request,
				metadata.traceId,
			);
			const trusted: SkillHubRequestV1 = {
				...metadata,
				userId: identity.userId,
			};
			const key = parseIdempotencyKey(request, metadata.traceId);
			const { value } = await parseJson(
				request,
				SkillHubProviderImportRequestV1Schema,
				metadata.traceId,
			);
			const result = publicResponse(
				await dependencies.importer.importVersion(trusted, key, value),
			);
			return context.json(result, result.replayed ? 200 : 201);
		} catch (error) {
			const protocol = mapCoreError(error, metadata.traceId);
			return context.json(protocol.body, protocol.status);
		}
	});
}
