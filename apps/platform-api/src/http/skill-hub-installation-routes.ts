import {
	parseSkillHubIdV1,
	parseSkillHubInstallationCommandV1,
	type SkillHubInstallationV1,
	type SkillHubRequestV1,
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

type InstallationResult = Readonly<{
	replayed: boolean;
	installation: SkillHubInstallationV1;
}>;

export interface SkillHubInstallationRoutesDependenciesV1 {
	readonly identity: IdentityAdapter;
	readonly install: (
		request: Request,
		trusted: SkillHubRequestV1,
		key: string,
		input: unknown,
	) => Promise<InstallationResult>;
	readonly uninstall: (
		request: Request,
		trusted: SkillHubRequestV1,
		installationId: string,
		key: string,
	) => Promise<InstallationResult>;
}

const installationCommandParser = {
	safeParse(input: unknown) {
		try {
			return {
				success: true as const,
				data: parseSkillHubInstallationCommandV1(input),
			};
		} catch {
			return { success: false as const, error: new Error() };
		}
	},
};

function publicInstallation(result: unknown): InstallationResult {
	if (
		typeof result !== "object" ||
		result === null ||
		!Object.hasOwn(result, "replayed") ||
		typeof (result as Record<string, unknown>).replayed !== "boolean" ||
		typeof (result as Record<string, unknown>).installation !== "object" ||
		(result as Record<string, unknown>).installation === null
	)
		throw new Error();
	const value = result as Record<string, unknown>;
	const installation = value.installation as Record<string, unknown>;
	if (
		installation.schemaVersion !== 1 ||
		!Object.values(installation).every((value) => value !== undefined) ||
		typeof installation.installationId !== "string" ||
		!installation.installationId ||
		(installation.principalType !== "user" &&
			installation.principalType !== "organization") ||
		typeof installation.principalId !== "string" ||
		typeof installation.skillVersionId !== "string" ||
		(installation.state !== "installed" &&
			installation.state !== "uninstalled" &&
			installation.state !== "failed") ||
		typeof installation.needUpgrade !== "boolean" ||
		typeof installation.installedAt !== "string" ||
		typeof installation.updatedAt !== "string"
	)
		throw new Error();
	return {
		replayed: value.replayed as boolean,
		installation: {
			schemaVersion: 1,
			installationId: installation.installationId,
			principalType: installation.principalType,
			principalId: installation.principalId,
			skillVersionId: installation.skillVersionId,
			state: installation.state,
			needUpgrade: installation.needUpgrade,
			installedAt: installation.installedAt,
			updatedAt: installation.updatedAt,
		} as SkillHubInstallationV1,
	};
}

export function registerSkillHubInstallationRoutesV1(
	app: Hono,
	dependencies: SkillHubInstallationRoutesDependenciesV1,
) {
	async function handle(
		context: Context,
		action: "install" | "uninstall",
	): Promise<Response> {
		const request = context.req.raw;
		const metadata = requestMetadata(request);
		context.header("Cache-Control", "no-store");
		context.header("Referrer-Policy", "no-referrer");
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
			const trusted = { ...metadata, userId: identity.userId };
			const key = parseIdempotencyKey(request, metadata.traceId);
			let result: InstallationResult;
			if (action === "install") {
				const { value } = await parseJson(
					request,
					installationCommandParser,
					metadata.traceId,
				);
				result = publicInstallation(
					await dependencies.install(request, trusted, key, value),
				);
				return context.json(result, result.replayed ? 200 : 201);
			}
			const installationId = parseSkillHubIdV1(
				context.req.param("installationId"),
			);
			if (
				Number(request.headers.get("Content-Length") ?? 0) > 0 ||
				request.headers.has("Transfer-Encoding")
			)
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			result = publicInstallation(
				await dependencies.uninstall(request, trusted, installationId, key),
			);
			return context.json(result, 200);
		} catch (error) {
			const protocol = mapCoreError(error, metadata.traceId);
			return context.json(protocol.body, protocol.status);
		}
	}
	app.post("/api/v2/skills/installations", (context) =>
		handle(context, "install"),
	);
	app.delete("/api/v2/skills/installations/:installationId", (context) =>
		handle(context, "uninstall"),
	);
}
