import type { SkillHubSyncBindingV1 } from "@agent-infra/contracts";
import {
	SkillHubAgentBindingCommandV1Schema,
	SkillHubAgentBindingStatusResponseV1Schema,
} from "@agent-infra/contracts/pilot";
import type { SkillHubAgentBindingResultV1 } from "@agent-infra/platform-core";
import type { Hono } from "hono";
import {
	HttpProtocolError,
	parseIdempotencyKey,
	parseJson,
	requestMetadata,
} from "./common.js";
import { mapCoreError } from "./core-errors.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";

export interface SkillHubAgentBindingRoutesDependenciesV1 {
	readonly identity: IdentityAdapter;
	readonly bind: (input: {
		readonly agentId: string;
		readonly agentVersion: string;
		readonly expectedConfigurationRevision: number;
		readonly bindings: unknown;
		readonly idempotencyKey: string;
		readonly requestId: string;
		readonly traceId: string;
		readonly actorId: string;
		readonly rawRequestDigest: string;
	}) => Promise<SkillHubAgentBindingResultV1>;
	readonly read: (input: {
		readonly agentId: string;
		readonly agentVersion: string;
		readonly actorId: string;
		readonly organizationIds: readonly string[];
		readonly isAdministrator: boolean;
		readonly requestId: string;
		readonly traceId: string;
	}) => Promise<{
		readonly configurationRevision: number;
		readonly agentId?: string;
		readonly agentVersion?: string;
		readonly bindings: readonly SkillHubSyncBindingV1[];
	}>;
}

function noBodyOrQuery(request: Request, traceId: string) {
	if (
		request.body !== null ||
		Number(request.headers.get("Content-Length") ?? 0) > 0 ||
		request.headers.has("Transfer-Encoding") ||
		new URL(request.url).search !== ""
	)
		throw new HttpProtocolError("INVALID_REQUEST", traceId);
}

function publicBindingStatus(input: {
	readonly agentId: string;
	readonly agentVersion: string;
	readonly configurationRevision: number;
	readonly bindings: readonly SkillHubSyncBindingV1[];
}) {
	const value = {
		schemaVersion: 1,
		agentId: input.agentId,
		agentVersion: input.agentVersion,
		configurationRevision: input.configurationRevision,
		bindings: input.bindings.map((binding) => ({
			schemaVersion: 1,
			agentId: binding.agentId,
			agentVersion: binding.agentVersion,
			skillName: binding.skillName,
			skillVersion: {
				schemaVersion: 1,
				skillId: binding.skillVersion.skillId,
				skillVersionId: binding.skillVersion.skillVersionId,
				provider: binding.skillVersion.provider,
				version: binding.skillVersion.version,
				packageDigest: binding.skillVersion.packageDigest,
				manifestDigest: binding.skillVersion.manifestDigest,
				signatureDigest: binding.skillVersion.signatureDigest,
			},
			grant: binding.grant,
			configurationRevision: binding.configurationRevision,
			syncRevision: binding.syncRevision,
			state: binding.state,
			failureReason: binding.failureReason,
			appliedReceipt: binding.appliedReceipt,
		})),
	};
	return SkillHubAgentBindingStatusResponseV1Schema.parse(value);
}

export function registerSkillHubAgentBindingRoutesV1(
	app: Hono,
	dependencies: SkillHubAgentBindingRoutesDependenciesV1,
) {
	app.put(
		"/api/v2/agents/:agentId/versions/:agentVersion/skills",
		async (context) => {
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
				const identity = await resolveIdentity(
					dependencies.identity,
					request,
					metadata.traceId,
				);
				const { value, rawRequestDigest } = await parseJson(
					request,
					SkillHubAgentBindingCommandV1Schema,
					metadata.traceId,
				);
				const result = await dependencies.bind({
					agentId: context.req.param("agentId"),
					agentVersion: context.req.param("agentVersion"),
					expectedConfigurationRevision: value.expectedConfigurationRevision,
					bindings: value.bindings,
					idempotencyKey: parseIdempotencyKey(request, metadata.traceId),
					requestId: metadata.requestId,
					traceId: metadata.traceId,
					actorId: identity.userId,
					rawRequestDigest,
				});
				return context.json(
					{
						schemaVersion: 1,
						agentId: result.agentId,
						agentVersion: context.req.param("agentVersion"),
						configurationRevision: result.revision,
						changedFields: ["skills"],
						replayed: result.replayed,
					},
					result.replayed ? 200 : 201,
				);
			} catch (error) {
				const protocol = mapCoreError(error, metadata.traceId);
				return context.json(protocol.body, protocol.status);
			}
		},
	);

	app.get(
		"/api/v2/agents/:agentId/versions/:agentVersion/skills",
		async (context) => {
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
				const identity = await resolveIdentity(
					dependencies.identity,
					request,
					metadata.traceId,
				);
				noBodyOrQuery(request, metadata.traceId);
				const result = await dependencies.read({
					agentId: context.req.param("agentId"),
					agentVersion: context.req.param("agentVersion"),
					actorId: identity.userId,
					organizationIds: identity.organizationIds,
					isAdministrator: identity.roles.includes("system_admin"),
					requestId: metadata.requestId,
					traceId: metadata.traceId,
				});
				return context.json(
					publicBindingStatus({
						...result,
						agentId: context.req.param("agentId"),
						agentVersion: context.req.param("agentVersion"),
					}),
				);
			} catch (error) {
				const protocol = mapCoreError(error, metadata.traceId);
				return context.json(protocol.body, protocol.status);
			}
		},
	);
}
