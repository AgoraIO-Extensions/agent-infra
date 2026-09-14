import {
	type RuntimeExecutionGrantClaimsV2,
	type RuntimePrincipalV1,
	RuntimePrincipalV1Schema,
} from "@agent-infra/contracts/runtime";

import { RuntimeHostError } from "./errors.js";

export interface RuntimeSessionAuthority {
	principal: RuntimePrincipalV1;
	channelId: string;
	migrationId?: string;
}

/** Deployment-only lookup constraints supplied by the original native socket owner. */
export interface RuntimeOriginalExecutionRef {
	agentId: string;
	conversationId: string;
	sessionGeneration: number;
	executionId: string;
	nativeSessionRef?: string;
}

export interface RuntimeExecutionAuthority {
	workerId: string;
	executionDeliveryFence: number;
	authorizationRecordId?: string;
	issuedAt: number;
	expiresAt: number;
	stopped?: true;
	control?: {
		controlRecordId: string;
		reason:
			| "stop"
			| "authorization_revoked"
			| "recovery"
			| "generation_isolation";
	};
	confirmedCursor?: string;
	deliveredCursors: string[];
	acknowledgedCursors?: string[];
	evidenceQuery?: { requestId: string; issuedAt: number };
}

export function runtimeAuthorizationDenied(): never {
	throw new RuntimeHostError(
		"RUNTIME_GRANT_INVALID",
		"Runtime authorization is unavailable or does not authorize this operation",
		403,
	);
}

export function assertSessionAuthority(
	authority: RuntimeSessionAuthority | undefined,
	binding: { principal?: RuntimePrincipalV1; channelId?: string },
) {
	if (
		!authority ||
		!binding.principal ||
		authority.principal.kind !== binding.principal.kind ||
		authority.principal.id !== binding.principal.id ||
		authority.channelId !== binding.channelId
	)
		runtimeAuthorizationDenied();
}

export function validStoredAuthority(authority: RuntimeSessionAuthority) {
	return (
		!!authority &&
		typeof authority === "object" &&
		!Array.isArray(authority) &&
		Object.keys(authority).every((key) =>
			["principal", "channelId", "migrationId"].includes(key),
		) &&
		RuntimePrincipalV1Schema.safeParse(authority.principal).success &&
		typeof authority.channelId === "string" &&
		authority.channelId.length > 0 &&
		(authority.migrationId === undefined ||
			(typeof authority.migrationId === "string" &&
				authority.migrationId.length > 0))
	);
}

export function validStoredExecutionAuthority(
	authority: RuntimeExecutionAuthority,
) {
	return (
		!!authority &&
		typeof authority === "object" &&
		!Array.isArray(authority) &&
		Object.keys(authority).every((key) =>
			[
				"workerId",
				"executionDeliveryFence",
				"authorizationRecordId",
				"issuedAt",
				"expiresAt",
				"control",
				"stopped",
				"confirmedCursor",
				"deliveredCursors",
				"acknowledgedCursors",
				"evidenceQuery",
			].includes(key),
		) &&
		typeof authority.workerId === "string" &&
		authority.workerId.length > 0 &&
		Number.isSafeInteger(authority.executionDeliveryFence) &&
		authority.executionDeliveryFence > 0 &&
		Number.isSafeInteger(authority.issuedAt) &&
		authority.issuedAt >= 0 &&
		Number.isSafeInteger(authority.expiresAt) &&
		authority.expiresAt >= 0 &&
		(authority.authorizationRecordId === undefined ||
			(typeof authority.authorizationRecordId === "string" &&
				authority.authorizationRecordId.length > 0)) &&
		(authority.stopped === undefined || authority.stopped === true) &&
		(authority.confirmedCursor === undefined ||
			(typeof authority.confirmedCursor === "string" &&
				authority.confirmedCursor.length > 0)) &&
		Array.isArray(authority.deliveredCursors) &&
		authority.deliveredCursors.every(
			(cursor) => typeof cursor === "string" && cursor.length > 0,
		) &&
		(authority.acknowledgedCursors === undefined ||
			(Array.isArray(authority.acknowledgedCursors) &&
				authority.acknowledgedCursors.every(
					(cursor) => typeof cursor === "string" && cursor.length > 0,
				))) &&
		(authority.evidenceQuery === undefined ||
			(!!authority.evidenceQuery &&
				typeof authority.evidenceQuery === "object" &&
				Object.keys(authority.evidenceQuery).sort().join(",") ===
					"issuedAt,requestId" &&
				typeof authority.evidenceQuery.requestId === "string" &&
				authority.evidenceQuery.requestId.length > 0 &&
				Number.isSafeInteger(authority.evidenceQuery.issuedAt) &&
				authority.evidenceQuery.issuedAt >= 0)) &&
		(authority.control === undefined ||
			(!!authority.control &&
				typeof authority.control === "object" &&
				Object.keys(authority.control).sort().join(",") ===
					"controlRecordId,reason" &&
				typeof authority.control.controlRecordId === "string" &&
				authority.control.controlRecordId.length > 0 &&
				[
					"stop",
					"authorization_revoked",
					"recovery",
					"generation_isolation",
				].includes(authority.control.reason)))
	);
}

export function applyRuntimeAuthority(
	authorities: Record<string, RuntimeExecutionAuthority>,
	claims: RuntimeExecutionGrantClaimsV2,
	mode: "prepare" | "query" | "renew",
) {
	const current = authorities[claims.executionId];
	if (
		current &&
		(current.workerId !== claims.workerId ||
			claims.operation.executionDeliveryFence < current.executionDeliveryFence)
	)
		runtimeAuthorizationDenied();
	if (claims.purpose === "business") {
		if (
			(current?.stopped && claims.allowedCommands[0] !== "turn.stop") ||
			(current?.control && current.control.reason !== "recovery")
		)
			runtimeAuthorizationDenied();
		if (
			current?.authorizationRecordId &&
			current.authorizationRecordId !== claims.authorizationRecordId
		)
			runtimeAuthorizationDenied();
		if (
			mode === "renew" &&
			(!current?.authorizationRecordId ||
				claims.operation.executionDeliveryFence !==
					current.executionDeliveryFence)
		)
			runtimeAuthorizationDenied();
	}
	const authority: RuntimeExecutionAuthority = current ?? {
		workerId: claims.workerId,
		executionDeliveryFence: claims.operation.executionDeliveryFence,
		issuedAt: 0,
		expiresAt: 0,
		deliveredCursors: [],
	};
	if (claims.purpose === "control") {
		if (
			authority.control?.controlRecordId === claims.controlRecordId &&
			authority.control.reason !== claims.reason
		)
			runtimeAuthorizationDenied();
		authority.control = {
			controlRecordId: claims.controlRecordId,
			reason: claims.reason,
		};
		if (
			claims.allowedCommands[0] === "turn.stop" ||
			claims.reason !== "recovery"
		)
			authority.stopped = true;
		if (claims.reason !== "recovery") authority.expiresAt = 0;
	} else {
		authority.authorizationRecordId ??= claims.authorizationRecordId;
		if (claims.allowedCommands[0] === "turn.stop") authority.stopped = true;
		if (mode !== "query") {
			if (claims.issuedAt < authority.issuedAt) runtimeAuthorizationDenied();
			authority.authorizationRecordId = claims.authorizationRecordId;
			authority.issuedAt = claims.issuedAt;
			authority.expiresAt = claims.expiresAt;
		}
	}
	authority.executionDeliveryFence = claims.operation.executionDeliveryFence;
	authorities[claims.executionId] = authority;
	return authority;
}
