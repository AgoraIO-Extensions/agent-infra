import { Buffer } from "node:buffer";
import { types } from "node:util";

import {
	type AgentManagementActorContextV1,
	AgentManagementError,
	type AgentManagementStateV1,
} from "./agent-management.js";

type AccessTargetV1 = AgentManagementStateV1["availability"][number];

export interface AgentAccessUpdatePolicyCommandV1 {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly expectedRevision: number;
	readonly desiredOwnerIds: readonly string[];
	readonly desiredAvailability: readonly AccessTargetV1[];
	readonly requestId: string;
	readonly traceId: string;
}

export interface AgentAccessAuthorityContextV1 {
	readonly schemaVersion: 1;
	readonly users: readonly {
		readonly userId: string;
		readonly accountStatus: "active" | "disabled" | "revoked";
	}[];
	readonly organizationIds: readonly string[];
}

export interface AgentAccessUpdatePlanFragmentV1 {
	readonly schemaVersion: 1;
	readonly fragmentType: "agent_access";
	readonly agentId: string;
	readonly expectedRevision: number;
	readonly ownerIds: readonly string[];
	readonly availability: readonly AccessTargetV1[];
	readonly auditEvent: {
		readonly action: "agent.access.updated";
		readonly actorId: string;
		readonly subjectType: "agent";
		readonly subjectId: string;
		readonly traceId: string;
		readonly requestId: string;
	};
}

export type AgentAccessUpdatePolicyDecisionV1 =
	| {
			readonly outcome: "accepted";
			readonly planFragment: AgentAccessUpdatePlanFragmentV1;
	  }
	| { readonly outcome: "denied"; readonly planFragment: null }
	| {
			readonly outcome: "conflict";
			readonly reason:
				| "admin_rescue_owner_only"
				| "invalid_access_update"
				| "invalid_target"
				| "last_valid_owner_required"
				| "no_change"
				| "stale_revision";
			readonly planFragment: null;
	  };

function invalidInput(): never {
	throw new AgentManagementError("invalid_input");
}

function snapshotDataObject(input: unknown): Record<string, unknown> {
	try {
		if (
			typeof input !== "object" ||
			input === null ||
			Array.isArray(input) ||
			types.isProxy(input)
		) {
			invalidInput();
		}
		const descriptors = Object.getOwnPropertyDescriptors(input);
		const values: Record<string, unknown> = {};
		for (const key of Reflect.ownKeys(descriptors)) {
			if (typeof key !== "string") invalidInput();
			const descriptor = descriptors[key];
			if (
				descriptor?.enumerable !== true ||
				!Object.hasOwn(descriptor, "value")
			) {
				invalidInput();
			}
			values[key] = descriptor.value;
		}
		return values;
	} catch (error) {
		if (error instanceof AgentManagementError) throw error;
		invalidInput();
	}
}

function dataArray(input: unknown): readonly unknown[] {
	try {
		if (
			!Array.isArray(input) ||
			types.isProxy(input) ||
			Object.getPrototypeOf(input) !== Array.prototype ||
			input.length > 4096 ||
			Reflect.ownKeys(input).length !== input.length + 1
		) {
			invalidInput();
		}
		return Array.from({ length: input.length }, (_, index) => {
			const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
			if (
				descriptor?.enumerable !== true ||
				!Object.hasOwn(descriptor, "value")
			) {
				invalidInput();
			}
			return descriptor.value;
		});
	} catch (error) {
		if (error instanceof AgentManagementError) throw error;
		invalidInput();
	}
}

function exact(values: Record<string, unknown>, keys: readonly string[]): void {
	const expected = new Set(keys);
	if (
		Object.keys(values).length !== expected.size ||
		Object.keys(values).some((key) => !expected.has(key))
	) {
		invalidInput();
	}
}

function text(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!value.includes("\0") &&
		String.prototype.isWellFormed.call(value) &&
		Buffer.byteLength(value, "utf8") <= 4096
	);
}

function textArray(input: unknown, unique: boolean): readonly string[] {
	const values = dataArray(input).map((value) => {
		if (!text(value)) invalidInput();
		return value;
	});
	if (unique && new Set(values).size !== values.length) invalidInput();
	return values;
}

export function agentAccessTargetKey(target: AccessTargetV1): string {
	return target.kind === "user"
		? `user:${target.userId}`
		: `organization:${target.organizationId}`;
}

export function parseAgentAccessTargets(
	input: unknown,
): readonly AccessTargetV1[] {
	return dataArray(input).map((targetInput) => {
		const target = snapshotDataObject(targetInput);
		if (target.kind === "user") {
			exact(target, ["kind", "userId"]);
			if (!text(target.userId)) invalidInput();
			return { kind: "user", userId: target.userId };
		}
		if (target.kind === "organization") {
			exact(target, ["kind", "organizationId"]);
			if (!text(target.organizationId)) invalidInput();
			return { kind: "organization", organizationId: target.organizationId };
		}
		return invalidInput();
	});
}

function parseCommand(input: unknown): AgentAccessUpdatePolicyCommandV1 {
	const values = snapshotDataObject(input);
	exact(values, [
		"schemaVersion",
		"agentId",
		"expectedRevision",
		"desiredOwnerIds",
		"desiredAvailability",
		"requestId",
		"traceId",
	]);
	if (
		values.schemaVersion !== 1 ||
		!text(values.agentId) ||
		!Number.isSafeInteger(values.expectedRevision) ||
		(values.expectedRevision as number) < 0 ||
		!text(values.requestId) ||
		!text(values.traceId)
	) {
		invalidInput();
	}
	return {
		schemaVersion: 1,
		agentId: values.agentId,
		expectedRevision: values.expectedRevision as number,
		desiredOwnerIds: textArray(values.desiredOwnerIds, false),
		desiredAvailability: parseAgentAccessTargets(values.desiredAvailability),
		requestId: values.requestId,
		traceId: values.traceId,
	};
}

function parseActor(input: unknown): AgentManagementActorContextV1 {
	const values = snapshotDataObject(input);
	exact(values, [
		"schemaVersion",
		"userId",
		"accountStatus",
		"organizationIds",
		"isAdministrator",
	]);
	if (
		values.schemaVersion !== 1 ||
		!text(values.userId) ||
		(values.accountStatus !== "active" &&
			values.accountStatus !== "disabled") ||
		typeof values.isAdministrator !== "boolean"
	) {
		invalidInput();
	}
	return {
		schemaVersion: 1,
		userId: values.userId,
		accountStatus: values.accountStatus,
		organizationIds: textArray(values.organizationIds, true),
		isAdministrator: values.isAdministrator,
	};
}

function parseAuthority(input: unknown): AgentAccessAuthorityContextV1 {
	try {
		const values = snapshotDataObject(input);
		exact(values, ["schemaVersion", "users", "organizationIds"]);
		if (values.schemaVersion !== 1) invalidInput();
		const users = dataArray(values.users).map((userInput) => {
			const user = snapshotDataObject(userInput);
			exact(user, ["userId", "accountStatus"]);
			if (
				!text(user.userId) ||
				(user.accountStatus !== "active" &&
					user.accountStatus !== "disabled" &&
					user.accountStatus !== "revoked")
			) {
				invalidInput();
			}
			return {
				userId: user.userId,
				accountStatus:
					user.accountStatus as AgentAccessAuthorityContextV1["users"][number]["accountStatus"],
			};
		});
		if (new Set(users.map(({ userId }) => userId)).size !== users.length) {
			invalidInput();
		}
		return {
			schemaVersion: 1,
			users,
			organizationIds: textArray(values.organizationIds, true),
		};
	} catch {
		throw new AgentManagementError("unavailable");
	}
}

function policyState(input: AgentManagementStateV1): {
	readonly agentId: string;
	readonly applicantId: string;
	readonly status: AgentManagementStateV1["status"];
	readonly revision: number;
	readonly ownerIds: readonly string[];
	readonly availability: readonly AccessTargetV1[];
} {
	try {
		if (
			!text(input.agentId) ||
			!text(input.applicantId) ||
			!Number.isSafeInteger(input.revision) ||
			input.revision < 0
		) {
			invalidInput();
		}
		const ownerIds = textArray(input.ownerIds, true);
		const availability = parseAgentAccessTargets(input.availability);
		if (
			ownerIds.length === 0 ||
			new Set(availability.map(agentAccessTargetKey)).size !==
				availability.length
		) {
			invalidInput();
		}
		return {
			agentId: input.agentId,
			applicantId: input.applicantId,
			status: input.status,
			revision: input.revision,
			ownerIds,
			availability,
		};
	} catch {
		throw new AgentManagementError("unavailable");
	}
}

function sameTargets(
	left: readonly AccessTargetV1[],
	right: readonly AccessTargetV1[],
): boolean {
	return (
		JSON.stringify(left.map(agentAccessTargetKey).sort()) ===
		JSON.stringify(right.map(agentAccessTargetKey).sort())
	);
}

export function decideAgentAccessUpdatePolicy(
	commandInput: AgentAccessUpdatePolicyCommandV1,
	stateInput: AgentManagementStateV1 | undefined,
	actorInput: AgentManagementActorContextV1,
	authorityInput: AgentAccessAuthorityContextV1,
): AgentAccessUpdatePolicyDecisionV1 {
	const command = parseCommand(commandInput);
	const actor = parseActor(actorInput);
	const authority = parseAuthority(authorityInput);
	const state = stateInput && policyState(stateInput);
	const users = new Map(
		authority.users.map(({ userId, accountStatus }) => [userId, accountStatus]),
	);
	if (users.get(actor.userId) !== actor.accountStatus) {
		throw new AgentManagementError("unavailable");
	}
	if (!state || state.agentId !== command.agentId) {
		return { outcome: "denied", planFragment: null };
	}
	if (state.ownerIds.some((ownerId) => !users.has(ownerId))) {
		throw new AgentManagementError("unavailable");
	}
	if (actor.accountStatus !== "active") {
		return { outcome: "denied", planFragment: null };
	}
	const activeCurrentOwner = state.ownerIds.some(
		(ownerId) => users.get(ownerId) === "active",
	);
	const owner = state.ownerIds.includes(actor.userId);
	const applicant =
		state.applicantId === actor.userId &&
		(state.status === "pending_approval" || state.status === "rejected");
	const administratorRescue = actor.isAdministrator && !activeCurrentOwner;
	if (!owner && !applicant && !administratorRescue) {
		return { outcome: "denied", planFragment: null };
	}
	if (state.revision !== command.expectedRevision) {
		return {
			outcome: "conflict",
			reason: "stale_revision",
			planFragment: null,
		};
	}
	const ownerIds = [...command.desiredOwnerIds].sort();
	if (new Set(ownerIds).size !== ownerIds.length) {
		return {
			outcome: "conflict",
			reason: "invalid_access_update",
			planFragment: null,
		};
	}
	const availability = [...command.desiredAvailability];
	if (
		new Set(availability.map(agentAccessTargetKey)).size !== availability.length
	) {
		return {
			outcome: "conflict",
			reason: "invalid_access_update",
			planFragment: null,
		};
	}
	if (administratorRescue && !sameTargets(availability, state.availability)) {
		return {
			outcome: "conflict",
			reason: "admin_rescue_owner_only",
			planFragment: null,
		};
	}
	if (
		ownerIds.some(
			(ownerId) => !users.has(ownerId) || users.get(ownerId) === "revoked",
		) ||
		availability.some((target) =>
			target.kind === "user"
				? users.get(target.userId) !== "active"
				: !authority.organizationIds.includes(target.organizationId),
		)
	) {
		return {
			outcome: "conflict",
			reason: "invalid_target",
			planFragment: null,
		};
	}
	if (!ownerIds.some((ownerId) => users.get(ownerId) === "active")) {
		return {
			outcome: "conflict",
			reason: "last_valid_owner_required",
			planFragment: null,
		};
	}
	if (
		JSON.stringify([...state.ownerIds].sort()) === JSON.stringify(ownerIds) &&
		sameTargets(availability, state.availability)
	) {
		return { outcome: "conflict", reason: "no_change", planFragment: null };
	}
	return {
		outcome: "accepted",
		planFragment: {
			schemaVersion: 1,
			fragmentType: "agent_access",
			agentId: state.agentId,
			expectedRevision: command.expectedRevision,
			ownerIds,
			availability,
			auditEvent: {
				action: "agent.access.updated",
				actorId: actor.userId,
				subjectType: "agent",
				subjectId: state.agentId,
				traceId: command.traceId,
				requestId: command.requestId,
			},
		},
	};
}
