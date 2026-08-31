import { Buffer } from "node:buffer";
import { types } from "node:util";

import type {
	AgentFailureCodeV1,
	AgentManagementActorContextV1,
	AgentManagementStateV1,
	AgentManagementStatusV1,
	AgentServiceAvailabilityV1,
} from "./agent-management.js";

export class AgentManagementError extends Error {
	readonly code: "invalid_input" | "unavailable";

	constructor(code: "invalid_input" | "unavailable") {
		super(
			code === "invalid_input"
				? "Invalid Agent management input"
				: "Agent management is temporarily unavailable",
		);
		this.name = "AgentManagementError";
		this.code = code;
	}
}

export function invalidAgentManagementInput(): never {
	throw new AgentManagementError("invalid_input");
}

export function snapshotAgentManagementDataObject(
	input: unknown,
): Record<string, unknown> {
	try {
		if (
			typeof input !== "object" ||
			input === null ||
			Array.isArray(input) ||
			types.isProxy(input)
		) {
			invalidAgentManagementInput();
		}
		const descriptors = Object.getOwnPropertyDescriptors(input);
		const values: Record<string, unknown> = {};
		for (const key of Reflect.ownKeys(descriptors)) {
			if (typeof key !== "string") invalidAgentManagementInput();
			const descriptor = descriptors[key];
			if (
				descriptor?.enumerable !== true ||
				!Object.hasOwn(descriptor, "value") ||
				Object.hasOwn(descriptor, "get") ||
				Object.hasOwn(descriptor, "set")
			) {
				invalidAgentManagementInput();
			}
			values[key] = descriptor.value;
		}
		return values;
	} catch (error) {
		if (error instanceof AgentManagementError) throw error;
		invalidAgentManagementInput();
	}
}

export function requireAgentManagementExactKeys(
	values: Record<string, unknown>,
	expectedKeys: readonly string[],
): void {
	const keys = Object.keys(values);
	const expected = new Set(expectedKeys);
	if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
		invalidAgentManagementInput();
	}
}

export function isAgentManagementText(
	value: unknown,
	maxBytes = 1024,
): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!value.includes("\0") &&
		String.prototype.isWellFormed.call(value) &&
		Buffer.byteLength(value, "utf8") <= maxBytes
	);
}

export function isAgentManagementNonNegativeInteger(
	value: unknown,
): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function snapshotAgentManagementDenseArray(
	input: unknown,
	maxItems = 4096,
): readonly unknown[] {
	try {
		if (
			!Array.isArray(input) ||
			types.isProxy(input) ||
			Object.getPrototypeOf(input) !== Array.prototype ||
			input.length > maxItems ||
			Reflect.ownKeys(input).length !== input.length + 1
		) {
			invalidAgentManagementInput();
		}
		const values: unknown[] = [];
		for (let index = 0; index < input.length; index += 1) {
			const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
			if (
				descriptor?.enumerable !== true ||
				!Object.hasOwn(descriptor, "value")
			) {
				invalidAgentManagementInput();
			}
			values.push(descriptor.value);
		}
		return values;
	} catch (error) {
		if (error instanceof AgentManagementError) throw error;
		invalidAgentManagementInput();
	}
}

export function parseAgentManagementStringArray(
	input: unknown,
	unique: boolean,
): readonly string[] {
	const values = snapshotAgentManagementDenseArray(input).map((value) => {
		if (!isAgentManagementText(value)) invalidAgentManagementInput();
		return value;
	});
	if (unique && new Set(values).size !== values.length) {
		invalidAgentManagementInput();
	}
	return values;
}

export function parseAgentManagementActorContext(
	input: unknown,
): AgentManagementActorContextV1 {
	const values = snapshotAgentManagementDataObject(input);
	requireAgentManagementExactKeys(values, [
		"schemaVersion",
		"userId",
		"accountStatus",
		"organizationIds",
		"isAdministrator",
	]);
	if (
		values.schemaVersion !== 1 ||
		!isAgentManagementText(values.userId) ||
		(values.accountStatus !== "active" &&
			values.accountStatus !== "disabled") ||
		typeof values.isAdministrator !== "boolean"
	) {
		invalidAgentManagementInput();
	}
	return {
		schemaVersion: 1,
		userId: values.userId,
		accountStatus: values.accountStatus,
		organizationIds: parseAgentManagementStringArray(
			values.organizationIds,
			true,
		),
		isAdministrator: values.isAdministrator,
	};
}

type AgentAccessTargetV1 = AgentManagementStateV1["availability"][number];

export function agentAccessTargetKey(target: AgentAccessTargetV1): string {
	return target.kind === "user"
		? `user:${target.userId}`
		: `organization:${target.organizationId}`;
}

export function parseAgentAccessTargets(
	input: unknown,
): readonly AgentAccessTargetV1[] {
	return snapshotAgentManagementDenseArray(input).map((targetInput) => {
		const target = snapshotAgentManagementDataObject(targetInput);
		if (target.kind === "user") {
			requireAgentManagementExactKeys(target, ["kind", "userId"]);
			if (!isAgentManagementText(target.userId)) invalidAgentManagementInput();
			return { kind: "user", userId: target.userId };
		}
		if (target.kind === "organization") {
			requireAgentManagementExactKeys(target, ["kind", "organizationId"]);
			if (!isAgentManagementText(target.organizationId)) {
				invalidAgentManagementInput();
			}
			return { kind: "organization", organizationId: target.organizationId };
		}
		return invalidAgentManagementInput();
	});
}

const agentFailureCodes: readonly AgentFailureCodeV1[] = [
	"creation_not_ready",
	"health_check_failed",
	"workload_unavailable",
	"reconciliation_failed",
];

export function isAgentManagementFailureCode(
	value: unknown,
): value is AgentFailureCodeV1 {
	return agentFailureCodes.includes(value as AgentFailureCodeV1);
}

export function parseAgentManagementPortState(
	input: AgentManagementStateV1,
): AgentManagementStateV1 {
	try {
		const values = snapshotAgentManagementDataObject(input);
		requireAgentManagementExactKeys(values, [
			"schemaVersion",
			"applicationId",
			"agentId",
			"applicantId",
			"status",
			"revision",
			"approvalRevision",
			"decisionReason",
			"serviceAvailability",
			"desiredState",
			"workloadRevision",
			"fence",
			"ownerIds",
			"availability",
			"failureCode",
		]);
		const statuses: readonly AgentManagementStatusV1[] = [
			"pending_approval",
			"withdrawn",
			"rejected",
			"creating",
			"available",
			"stopped",
			"creation_failed",
			"disabled",
		];
		const serviceAvailabilities: readonly AgentServiceAvailabilityV1[] = [
			"ready",
			"starting",
			"updating",
			"unavailable",
		];
		if (
			values.schemaVersion !== 1 ||
			!isAgentManagementText(values.applicationId) ||
			!isAgentManagementText(values.agentId) ||
			!isAgentManagementText(values.applicantId) ||
			!statuses.includes(values.status as AgentManagementStatusV1) ||
			!isAgentManagementNonNegativeInteger(values.revision) ||
			(values.approvalRevision !== null &&
				(!Number.isSafeInteger(values.approvalRevision) ||
					(values.approvalRevision as number) < 1)) ||
			(values.decisionReason !== null &&
				!isAgentManagementText(values.decisionReason, 4096)) ||
			(values.serviceAvailability !== null &&
				!serviceAvailabilities.includes(
					values.serviceAvailability as AgentServiceAvailabilityV1,
				)) ||
			(values.desiredState !== "running" &&
				values.desiredState !== "stopped") ||
			!isAgentManagementNonNegativeInteger(values.workloadRevision) ||
			!isAgentManagementNonNegativeInteger(values.fence) ||
			(values.failureCode !== null &&
				!isAgentManagementFailureCode(values.failureCode))
		) {
			invalidAgentManagementInput();
		}
		const status = values.status as AgentManagementStatusV1;
		const serviceAvailability =
			values.serviceAvailability as AgentServiceAvailabilityV1 | null;
		const preApproval =
			status === "pending_approval" ||
			status === "rejected" ||
			status === "withdrawn";
		if (
			(preApproval &&
				(values.desiredState !== "stopped" ||
					serviceAvailability !== null ||
					values.approvalRevision !== null ||
					values.workloadRevision !== 0 ||
					values.fence !== 0 ||
					values.failureCode !== null)) ||
			(!preApproval &&
				(values.approvalRevision === null ||
					(values.approvalRevision as number) > (values.revision as number) ||
					(values.workloadRevision as number) < 1 ||
					(values.fence as number) < 1)) ||
			((status === "creating" || status === "creation_failed") &&
				(values.desiredState !== "running" || serviceAvailability !== null)) ||
			(status === "available" &&
				(values.desiredState !== "running" || serviceAvailability === null)) ||
			((status === "stopped" || status === "disabled") &&
				(values.desiredState !== "stopped" || serviceAvailability !== null)) ||
			(status === "rejected" && values.decisionReason === null) ||
			(status !== "rejected" && values.decisionReason !== null) ||
			(status === "creation_failed" && values.failureCode === null) ||
			(status === "available" &&
				serviceAvailability === "unavailable" &&
				values.failureCode === null) ||
			(status === "available" &&
				serviceAvailability === "ready" &&
				values.failureCode !== null)
		) {
			invalidAgentManagementInput();
		}
		const ownerIds = parseAgentManagementStringArray(values.ownerIds, true);
		if (ownerIds.length === 0) invalidAgentManagementInput();
		const availability = parseAgentAccessTargets(values.availability);
		if (
			new Set(availability.map(agentAccessTargetKey)).size !==
			availability.length
		) {
			invalidAgentManagementInput();
		}
		return {
			schemaVersion: 1,
			applicationId: values.applicationId,
			agentId: values.agentId,
			applicantId: values.applicantId,
			status,
			revision: values.revision,
			approvalRevision: values.approvalRevision as number | null,
			decisionReason: values.decisionReason as string | null,
			serviceAvailability,
			desiredState: values.desiredState,
			workloadRevision: values.workloadRevision,
			fence: values.fence,
			ownerIds,
			availability,
			failureCode: values.failureCode as AgentFailureCodeV1 | null,
		};
	} catch {
		throw new AgentManagementError("unavailable");
	}
}
