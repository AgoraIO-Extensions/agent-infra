import {
	type RuntimeExecutionGrantClaimsV2,
	type RuntimePrincipalV1,
	RuntimePrincipalV1Schema,
} from "@agent-infra/contracts/runtime";

import { RuntimeHostError } from "./errors.js";

const storedAuthorityTextPattern = /^[A-Za-z0-9._:-]{1,1024}$/;

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
	/** The latest operation fence that installed a control authority. */
	controlDeliveryFence?: number;
	authorizationRecordId?: string;
	issuedAt: number;
	expiresAt: number;
	/** A read-only query authority has no business lease or expiry. */
	queryOnly?: true;
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
	const isRecord =
		!!authority && typeof authority === "object" && !Array.isArray(authority);
	const migrationId = isRecord ? authority.migrationId : undefined;
	const keys = isRecord ? Object.keys(authority).sort().join(",") : "";
	const expectedKeys = [
		"principal",
		"channelId",
		...(migrationId === undefined ? [] : ["migrationId"]),
	]
		.sort()
		.join(",");
	return (
		isRecord &&
		keys === expectedKeys &&
		RuntimePrincipalV1Schema.safeParse(authority.principal).success &&
		typeof authority.channelId === "string" &&
		storedAuthorityTextPattern.test(authority.channelId) &&
		(migrationId === undefined ||
			(typeof migrationId === "string" &&
				storedAuthorityTextPattern.test(migrationId)))
	);
}

export function validStoredExecutionAuthority(
	authority: RuntimeExecutionAuthority,
) {
	const keys =
		authority && typeof authority === "object" && !Array.isArray(authority)
			? Object.keys(authority).sort().join(",")
			: "";
	const expectedKeys = [
		"workerId",
		"executionDeliveryFence",
		"issuedAt",
		"expiresAt",
		"deliveredCursors",
		...(authority?.controlDeliveryFence === undefined
			? []
			: ["controlDeliveryFence"]),
		...(authority?.authorizationRecordId === undefined
			? []
			: ["authorizationRecordId"]),
		...(authority?.queryOnly === undefined ? [] : ["queryOnly"]),
		...(authority?.control === undefined ? [] : ["control"]),
		...(authority?.stopped === undefined ? [] : ["stopped"]),
		...(authority?.confirmedCursor === undefined ? [] : ["confirmedCursor"]),
		...(authority?.acknowledgedCursors === undefined
			? []
			: ["acknowledgedCursors"]),
		...(authority?.evidenceQuery === undefined ? [] : ["evidenceQuery"]),
	]
		.sort()
		.join(",");
	return (
		!!authority &&
		typeof authority === "object" &&
		!Array.isArray(authority) &&
		keys === expectedKeys &&
		typeof authority.workerId === "string" &&
		authority.workerId.length > 0 &&
		Number.isSafeInteger(authority.executionDeliveryFence) &&
		authority.executionDeliveryFence > 0 &&
		(authority.controlDeliveryFence === undefined ||
			(Number.isSafeInteger(authority.controlDeliveryFence) &&
				authority.controlDeliveryFence > 0)) &&
		Number.isSafeInteger(authority.issuedAt) &&
		authority.issuedAt >= 0 &&
		Number.isSafeInteger(authority.expiresAt) &&
		authority.expiresAt >= 0 &&
		(authority.expiresAt === 0
			? authority.stopped === true ||
				authority.control?.reason === "recovery" ||
				(authority.queryOnly === true && authority.issuedAt === 0)
			: authority.expiresAt > authority.issuedAt) &&
		(authority.queryOnly === undefined || authority.queryOnly === true) &&
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
	now = Date.now(),
) {
	if (
		!Number.isSafeInteger(now) ||
		claims.issuedAt > now ||
		claims.expiresAt <= now
	)
		runtimeAuthorizationDenied();
	const current = authorities[claims.executionId];
	if (
		current &&
		(current.workerId !== claims.workerId ||
			claims.operation.executionDeliveryFence <
				current.executionDeliveryFence ||
			(claims.purpose === "control" &&
				current.control !== undefined &&
				claims.operation.executionDeliveryFence ===
					current.executionDeliveryFence &&
				claims.operation.deliveryFence <=
					(current.controlDeliveryFence ?? current.executionDeliveryFence) &&
				current.control.controlRecordId !== claims.controlRecordId))
	)
		runtimeAuthorizationDenied();
	if (claims.purpose === "business") {
		if (
			(current?.stopped && claims.allowedCommands[0] !== "turn.stop") ||
			(current?.control &&
				(current.control.reason !== "recovery" ||
					(current.authorizationRecordId === claims.authorizationRecordId &&
						mode !== "renew")))
		)
			runtimeAuthorizationDenied();
		if (
			current?.authorizationRecordId &&
			current.authorizationRecordId !== claims.authorizationRecordId &&
			current.control?.reason !== "recovery"
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
		...(mode === "query" ? { queryOnly: true as const } : {}),
		deliveredCursors: [],
	};
	if (claims.purpose === "control") {
		delete authority.queryOnly;
		if (
			authority.control?.controlRecordId === claims.controlRecordId &&
			authority.control.reason !== claims.reason
		)
			runtimeAuthorizationDenied();
		authority.control = {
			controlRecordId: claims.controlRecordId,
			reason: claims.reason,
		};
		authority.controlDeliveryFence = claims.operation.deliveryFence;
		if (
			claims.reason === "recovery" &&
			claims.allowedCommands[0] !== "turn.stop"
		) {
			delete authority.stopped;
		} else {
			authority.stopped = true;
			authority.expiresAt = 0;
		}
	} else {
		if (
			current?.control?.reason === "recovery" &&
			(current.authorizationRecordId !== claims.authorizationRecordId ||
				mode === "renew")
		) {
			delete authority.control;
			delete authority.controlDeliveryFence;
		}
		authority.authorizationRecordId ??= claims.authorizationRecordId;
		if (claims.allowedCommands[0] === "turn.stop") authority.stopped = true;
		if (mode !== "query") {
			delete authority.queryOnly;
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
