import type {
	ExecutionGrantClaimsV1,
	ExecutionGrantCommandV1,
	ExecutionGrantV1,
	RuntimeCapabilitiesRequestV1,
	RuntimeGenerationCancelRequestV1,
	RuntimeReplayRequestV1,
	RuntimeStatusRequestV1,
	RuntimeStopRequestV1,
	RuntimeSubmitTurnRequestV1,
	RuntimeSupplementRequestV1,
	VerifiedExecutionGrantV1,
} from "@agent-infra/contracts/runtime";

import { RuntimeHost } from "./runtime-host.js";

export interface RuntimeGrantFixtureBinding {
	agentId: string;
	actorId: string;
	channelId: string;
	conversationId: string;
	executionId: string;
	turnId: string;
	sessionGeneration: number;
	traceId: string;
}

export function runtimeGrantRequestContext(
	binding: RuntimeGrantFixtureBinding,
) {
	return {
		actorId: binding.actorId,
		channelId: binding.channelId,
		traceId: binding.traceId,
	};
}

const verificationByToken = new Map<string, VerifiedExecutionGrantV1>();

export function runtimeGrantFixture(
	binding: RuntimeGrantFixtureBinding,
	allowedCommands: ExecutionGrantCommandV1[],
	options: {
		actionSetVersion?: string;
		attachments?: { attachmentId: string; operations: "read"[] }[];
		grantId?: string;
	} = {},
): ExecutionGrantV1 {
	const claims: ExecutionGrantClaimsV1 = {
		schemaVersion: 1 as const,
		issuer: "agent-platform",
		audience: ["runtime_host"],
		issuedAt: "2026-08-28T09:59:00Z",
		expiresAt: "2026-08-28T10:01:00Z",
		grantId:
			options.grantId ??
			`grant-${binding.executionId}-${allowedCommands.join("-")}`,
		agentId: binding.agentId,
		actorId: binding.actorId,
		channelId: binding.channelId,
		conversationId: binding.conversationId,
		turnId: binding.turnId,
		executionId: binding.executionId,
		sessionGeneration: binding.sessionGeneration,
		allowedCommands,
		attachments: options.attachments ?? [],
		actionSetVersion: options.actionSetVersion ?? "actions-runtime",
		actionIds: [],
		traceId: binding.traceId,
	};
	const token = `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
	const grant = {
		schemaVersion: 1 as const,
		format: "compact-jws" as const,
		token,
	};
	verificationByToken.set(token, { token, claims });
	return grant;
}

export function verificationForRuntimeGrant(grant: ExecutionGrantV1) {
	const verification = verificationByToken.get(grant.token);
	if (!verification) throw new Error("Missing Runtime Grant test verification");
	return verification;
}

export function ingressVerifiedRuntimeHost(host: RuntimeHost) {
	return {
		submitTurn(request: RuntimeSubmitTurnRequestV1) {
			return host.submitTurn(
				request,
				verificationForRuntimeGrant(request.grant),
			);
		},
		status(request: RuntimeStatusRequestV1) {
			return host.status(request, verificationForRuntimeGrant(request.grant));
		},
		capabilities(request: RuntimeCapabilitiesRequestV1) {
			return host.capabilities(
				request,
				verificationForRuntimeGrant(request.grant),
			);
		},
		replay(request: RuntimeReplayRequestV1) {
			return host.replay(request, verificationForRuntimeGrant(request.grant));
		},
		streamEvents(request: RuntimeReplayRequestV1, signal?: AbortSignal) {
			return host.streamEvents(
				request,
				verificationForRuntimeGrant(request.grant),
				signal,
			);
		},
		supplement(request: RuntimeSupplementRequestV1) {
			return host.supplement(
				request,
				verificationForRuntimeGrant(request.grant),
			);
		},
		stop(request: RuntimeStopRequestV1) {
			return host.stop(request, verificationForRuntimeGrant(request.grant));
		},
		cancelGeneration(request: RuntimeGenerationCancelRequestV1) {
			return host.cancelGeneration(
				request,
				verificationForRuntimeGrant(request.grant),
			);
		},
	};
}

export function openIngressVerifiedRuntimeHost(
	options: Parameters<typeof RuntimeHost.open>[0],
) {
	return RuntimeHost.open(options).then(ingressVerifiedRuntimeHost);
}
