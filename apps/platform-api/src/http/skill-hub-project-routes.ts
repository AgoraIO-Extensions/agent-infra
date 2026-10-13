import {
	SkillHubProjectCreateV1Schema,
	SkillHubProjectPageV1Schema,
	SkillHubProjectUpdateV1Schema,
	SkillHubProjectV1Schema,
} from "@agent-infra/contracts/pilot";
import type {
	SkillHubProjectV1,
	SkillHubRequestV1,
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

export type SkillHubProjectMutationResultV1 = Readonly<{
	replayed: boolean;
	project: SkillHubProjectV1;
}>;
export interface SkillHubProjectRoutesDependenciesV1 {
	readonly identity: IdentityAdapter;
	readonly list: (
		request: Request,
		trusted: SkillHubRequestV1,
	) => Promise<readonly SkillHubProjectV1[]>;
	readonly read: (
		request: Request,
		trusted: SkillHubRequestV1,
		projectId: string,
	) => Promise<SkillHubProjectV1>;
	readonly create: (
		request: Request,
		trusted: SkillHubRequestV1,
		key: string,
		input: unknown,
	) => Promise<SkillHubProjectMutationResultV1>;
	readonly update: (
		request: Request,
		trusted: SkillHubRequestV1,
		projectId: string,
		key: string,
		input: unknown,
	) => Promise<SkillHubProjectMutationResultV1>;
}

function publicProject(value: unknown) {
	const parsed = SkillHubProjectV1Schema.safeParse(value);
	if (!parsed.success)
		throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", "invalid-project");
	return parsed.data;
}
function publicResult(value: unknown): SkillHubProjectMutationResultV1 {
	if (
		typeof value !== "object" ||
		value === null ||
		typeof (value as Record<string, unknown>).replayed !== "boolean"
	)
		throw new Error();
	const project = publicProject((value as Record<string, unknown>).project);
	return {
		replayed: (value as Record<string, unknown>).replayed as boolean,
		project,
	};
}

export function registerSkillHubProjectRoutesV1(
	app: Hono,
	dependencies: SkillHubProjectRoutesDependenciesV1,
) {
	async function handle(
		context: Context,
		action: "list" | "read" | "create" | "update",
	) {
		const request = context.req.raw;
		const metadata = requestMetadata(request);
		context.header("Cache-Control", "no-store");
		context.header("Referrer-Policy", "no-referrer");
		try {
			const identity = await resolveIdentity(
				dependencies.identity,
				request,
				metadata.traceId,
			);
			const trusted = { ...metadata, userId: identity.userId };
			const url = new URL(request.url);
			if (action === "list") {
				if (url.search !== "" || request.body !== null)
					throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
				const items = (await dependencies.list(request, trusted)).map(
					publicProject,
				);
				const page = SkillHubProjectPageV1Schema.safeParse({
					items,
					nextCursor: null,
				});
				if (!page.success)
					throw new HttpProtocolError(
						"DEPENDENCY_UNAVAILABLE",
						metadata.traceId,
					);
				return context.json(page.data);
			}
			if (url.search !== "")
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			const projectId =
				action === "create" ? undefined : context.req.param("projectId");
			if (action !== "create" && !projectId)
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			if (action === "read") {
				if (request.body !== null)
					throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
				if (projectId === undefined)
					throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
				return context.json(
					publicProject(await dependencies.read(request, trusted, projectId)),
				);
			}
			const key = parseIdempotencyKey(request, metadata.traceId);
			if (action === "create") {
				const value = (
					await parseJson(
						request,
						SkillHubProjectCreateV1Schema,
						metadata.traceId,
					)
				).value;
				const result = publicResult(
					await dependencies.create(request, trusted, key, value),
				);
				return context.json(result.project, result.replayed ? 200 : 201);
			}
			if (projectId === undefined)
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			const value = (
				await parseJson(
					request,
					SkillHubProjectUpdateV1Schema,
					metadata.traceId,
				)
			).value;
			const result = publicResult(
				await dependencies.update(request, trusted, projectId, key, value),
			);
			return context.json(result.project, 200);
		} catch (error) {
			const protocol = mapCoreError(error, metadata.traceId);
			return context.json(protocol.body, protocol.status);
		}
	}
	app.get("/api/v2/skills/projects", (context) => handle(context, "list"));
	app.post("/api/v2/skills/projects", (context) => handle(context, "create"));
	app.get("/api/v2/skills/projects/:projectId", (context) =>
		handle(context, "read"),
	);
	app.patch("/api/v2/skills/projects/:projectId", (context) =>
		handle(context, "update"),
	);
}
