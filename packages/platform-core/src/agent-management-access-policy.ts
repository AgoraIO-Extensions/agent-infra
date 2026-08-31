import type {
	AgentManagementActorContextV1,
	AgentManagementStateV1,
} from "./agent-management.js";
import {
	AgentManagementError,
	agentAccessTargetKey,
	snapshotAgentManagementDenseArray as dataArray,
	requireAgentManagementExactKeys as exact,
	invalidAgentManagementInput as invalidInput,
	parseAgentManagementActorContext as parseActor,
	parseAgentAccessTargets,
	parseAgentManagementPortState,
	snapshotAgentManagementDataObject as snapshotDataObject,
	isAgentManagementText as text,
	parseAgentManagementStringArray as textArray,
} from "./agent-management-input.js";

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
	const state = stateInput && parseAgentManagementPortState(stateInput);
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
		(!administratorRescue &&
			availability.some((target) =>
				target.kind === "user"
					? users.get(target.userId) !== "active"
					: !authority.organizationIds.includes(target.organizationId),
			))
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
