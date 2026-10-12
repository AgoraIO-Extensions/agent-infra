import { randomUUID } from "node:crypto";
import type { BrowserCapabilityAvailableV1 } from "@agent-infra/contracts/runtime";

export type BrowserHandoffReasonV1 =
	| "login"
	| "mfa"
	| "captcha"
	| "human_judgment";

export type BrowserHandoffBindingV1 = Readonly<{
	subjectId: string;
	agentId: string;
	conversationId: string;
	executionId: string;
	sessionGeneration: number;
	resourceFence: number;
	capabilityVersion: number;
	pageRevision: number;
}>;

export type BrowserHandoffRuntimeSnapshotV1 = Readonly<{
	browserAlive: boolean;
	authorized: boolean;
	subjectId: string;
	agentId: string;
	conversationId: string;
	executionId: string;
	sessionGeneration: number;
	resourceFence: number;
	capabilityVersion: number;
	pageRevision: number;
}>;

export type BrowserHandoffStatusV1 =
	| "requested"
	| "active"
	| "returning"
	| "completed"
	| "revoked"
	| "expired"
	| "crashed"
	| "unknown";

export type BrowserHandoffRecordV1 = Readonly<{
	handoffId: string;
	status: BrowserHandoffStatusV1;
	reason: BrowserHandoffReasonV1;
	requestedAt: string;
	expiresAt: string;
	operatorId?: string;
	terminalReason?: string;
}>;

export interface BrowserHandoffControllerV1 {
	readonly binding: BrowserHandoffBindingV1;
	snapshot(): BrowserHandoffRecordV1 | undefined;
	request(
		reason: BrowserHandoffReasonV1,
		runtime: BrowserHandoffRuntimeSnapshotV1,
	): BrowserHandoffRecordV1;
	takeOver(input: {
		readonly handoffId: string;
		readonly operatorId: string;
		readonly subjectId: string;
		readonly runtime: BrowserHandoffRuntimeSnapshotV1;
	}): BrowserHandoffRecordV1;
	returnToAgent(input: {
		readonly handoffId: string;
		readonly operatorId: string;
		readonly runtime: BrowserHandoffRuntimeSnapshotV1;
	}): BrowserHandoffRecordV1;
	revoke(
		reason?:
			| "BROWSER_HANDOFF_REVOKED"
			| "BROWSER_HANDOFF_AUTHORIZATION_REVOKED"
			| "BROWSER_HANDOFF_OPERATOR_CHANGED",
	): BrowserHandoffRecordV1 | undefined;
	markBrowserCrashed(): BrowserHandoffRecordV1 | undefined;
	isAgentPaused(): boolean;
	assertAgentAccess(): void;
	agentObservation():
		| { readonly status: "available" }
		| {
				readonly status: "paused";
				readonly reasonCode: "BROWSER_HANDOFF_AGENT_OBSERVATION_PAUSED";
		  }
		| { readonly status: "blocked"; readonly reasonCode: string };
}

export type BrowserHandoffOperationV1 =
	| { readonly kind: "request"; readonly reason: BrowserHandoffReasonV1 }
	| {
			readonly kind: "take_over";
			readonly handoffId: string;
			readonly operatorId: string;
			readonly subjectId: string;
	  }
	| {
			readonly kind: "return_to_agent";
			readonly handoffId: string;
			readonly operatorId: string;
	  }
	| {
			readonly kind: "revoke";
			readonly reason?:
				| "BROWSER_HANDOFF_REVOKED"
				| "BROWSER_HANDOFF_AUTHORIZATION_REVOKED"
				| "BROWSER_HANDOFF_OPERATOR_CHANGED";
	  }
	| { readonly kind: "browser_crashed" };

type Capability = Pick<
	BrowserCapabilityAvailableV1,
	"capabilityVersion" | "operations" | "policy"
>;

const terminalStatuses = new Set<BrowserHandoffStatusV1>([
	"completed",
	"revoked",
	"expired",
	"crashed",
	"unknown",
]);

function assertBinding(binding: BrowserHandoffBindingV1): void {
	if (
		!binding ||
		!["subjectId", "agentId", "conversationId", "executionId"].every(
			(key) =>
				typeof binding[key as keyof BrowserHandoffBindingV1] === "string" &&
				(binding[key as keyof BrowserHandoffBindingV1] as string).length > 0,
		) ||
		![
			"sessionGeneration",
			"resourceFence",
			"capabilityVersion",
			"pageRevision",
		].every((key) => {
			const value = binding[key as keyof BrowserHandoffBindingV1];
			return Number.isSafeInteger(value) && (value as number) >= 1;
		})
	)
		throw new Error("BROWSER_HANDOFF_BINDING_INVALID");
}

function assertReason(reason: BrowserHandoffReasonV1): void {
	if (!["login", "mfa", "captcha", "human_judgment"].includes(reason))
		throw new Error("BROWSER_HANDOFF_REASON_INVALID");
}

function cloneRecord(record: BrowserHandoffRecordV1): BrowserHandoffRecordV1 {
	return { ...record };
}

export function createBrowserHandoffControllerV1(input: {
	readonly binding: BrowserHandoffBindingV1;
	readonly capability: Capability | (() => Capability);
	readonly now?: () => number;
	readonly timeoutMs?: number;
}): BrowserHandoffControllerV1 {
	assertBinding(input.binding);
	const binding: BrowserHandoffBindingV1 = Object.freeze({
		...input.binding,
	});
	const now = input.now ?? Date.now;
	const timeoutMs = input.timeoutMs ?? 5 * 60_000;
	if (
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 1_000 ||
		timeoutMs > 86_400_000
	)
		throw new Error("BROWSER_HANDOFF_TIMEOUT_INVALID");
	let record: BrowserHandoffRecordV1 | undefined;

	function readCapability(): Capability {
		return typeof input.capability === "function"
			? input.capability()
			: input.capability;
	}

	function requireCapability(): Capability {
		const capability = readCapability();
		if (!capability.operations.includes("handoff"))
			throw new Error("BROWSER_HANDOFF_UNAVAILABLE");
		if (capability.capabilityVersion !== binding.capabilityVersion)
			throw new Error("BROWSER_HANDOFF_CAPABILITY_STALE");
		return capability;
	}

	function requireCurrent(snapshot: BrowserHandoffRuntimeSnapshotV1): void {
		if (!snapshot.authorized)
			throw new Error("BROWSER_HANDOFF_AUTHORIZATION_REVOKED");
		if (!snapshot.browserAlive)
			throw new Error("BROWSER_HANDOFF_BROWSER_UNAVAILABLE");
		if (
			snapshot.subjectId !== binding.subjectId ||
			snapshot.agentId !== binding.agentId ||
			snapshot.conversationId !== binding.conversationId ||
			snapshot.executionId !== binding.executionId
		)
			throw new Error("BROWSER_HANDOFF_IDENTITY_BINDING_STALE");
		if (
			snapshot.sessionGeneration !== binding.sessionGeneration ||
			snapshot.resourceFence !== binding.resourceFence
		)
			throw new Error("BROWSER_HANDOFF_SESSION_BINDING_STALE");
		if (snapshot.capabilityVersion !== binding.capabilityVersion)
			throw new Error("BROWSER_HANDOFF_CAPABILITY_STALE");
		if (snapshot.pageRevision !== binding.pageRevision)
			throw new Error("BROWSER_HANDOFF_PAGE_REVISION_STALE");
	}

	function expireIfNeeded(): void {
		if (
			record &&
			(record.status === "requested" || record.status === "active") &&
			now() >= Date.parse(record.expiresAt)
		) {
			record = {
				...record,
				status: "expired",
				terminalReason: "BROWSER_HANDOFF_EXPIRED",
			};
		}
	}

	function snapshot(): BrowserHandoffRecordV1 | undefined {
		expireIfNeeded();
		return record ? cloneRecord(record) : undefined;
	}

	function request(
		reason: BrowserHandoffReasonV1,
		runtime: BrowserHandoffRuntimeSnapshotV1,
	): BrowserHandoffRecordV1 {
		assertReason(reason);
		requireCapability();
		requireCurrent(runtime);
		expireIfNeeded();
		if (record && !terminalStatuses.has(record.status)) {
			if (record.reason === reason) return cloneRecord(record);
			throw new Error("BROWSER_HANDOFF_ALREADY_ACTIVE");
		}
		const requestedAt = now();
		record = {
			handoffId: `handoff-${randomUUID()}`,
			status: "requested",
			reason,
			requestedAt: new Date(requestedAt).toISOString(),
			expiresAt: new Date(requestedAt + timeoutMs).toISOString(),
		};
		return cloneRecord(record);
	}

	function takeOver(input_: {
		readonly handoffId: string;
		readonly operatorId: string;
		readonly subjectId: string;
		readonly runtime: BrowserHandoffRuntimeSnapshotV1;
	}): BrowserHandoffRecordV1 {
		requireCapability();
		expireIfNeeded();
		if (!record || record.handoffId !== input_.handoffId)
			throw new Error("BROWSER_HANDOFF_NOT_FOUND");
		if (record.status !== "requested")
			throw new Error("BROWSER_HANDOFF_NOT_REQUESTED");
		if (
			typeof input_.operatorId !== "string" ||
			input_.operatorId.length === 0 ||
			input_.subjectId !== binding.subjectId ||
			input_.operatorId !== binding.subjectId
		)
			throw new Error("BROWSER_HANDOFF_OPERATOR_DENIED");
		requireCurrent(input_.runtime);
		record = {
			...record,
			status: "active",
			operatorId: input_.operatorId,
		};
		return cloneRecord(record);
	}

	function returnToAgent(input_: {
		readonly handoffId: string;
		readonly operatorId: string;
		readonly runtime: BrowserHandoffRuntimeSnapshotV1;
	}): BrowserHandoffRecordV1 {
		requireCapability();
		expireIfNeeded();
		if (!record || record.handoffId !== input_.handoffId)
			throw new Error("BROWSER_HANDOFF_NOT_FOUND");
		if (record.status !== "active")
			throw new Error("BROWSER_HANDOFF_NOT_ACTIVE");
		if (record.operatorId !== input_.operatorId)
			throw new Error("BROWSER_HANDOFF_OPERATOR_DENIED");
		record = { ...record, status: "returning" };
		try {
			requireCurrent(input_.runtime);
			record = {
				...record,
				status: "completed",
				terminalReason: "BROWSER_HANDOFF_RETURNED",
			};
			return cloneRecord(record);
		} catch (error) {
			record = {
				...record,
				status: "unknown",
				terminalReason:
					error instanceof Error
						? error.message
						: "BROWSER_HANDOFF_RETURN_UNCONFIRMED",
			};
			throw error;
		}
	}

	function revoke(
		reason:
			| "BROWSER_HANDOFF_REVOKED"
			| "BROWSER_HANDOFF_AUTHORIZATION_REVOKED"
			| "BROWSER_HANDOFF_OPERATOR_CHANGED" = "BROWSER_HANDOFF_REVOKED",
	): BrowserHandoffRecordV1 | undefined {
		expireIfNeeded();
		if (!record || terminalStatuses.has(record.status)) return snapshot();
		record = { ...record, status: "revoked", terminalReason: reason };
		return cloneRecord(record);
	}

	function markBrowserCrashed(): BrowserHandoffRecordV1 | undefined {
		expireIfNeeded();
		if (!record || terminalStatuses.has(record.status)) return snapshot();
		record = {
			...record,
			status: "crashed",
			terminalReason: "BROWSER_HANDOFF_BROWSER_CRASHED",
		};
		return cloneRecord(record);
	}

	function isAgentPaused(): boolean {
		expireIfNeeded();
		return (
			record?.status === "requested" ||
			record?.status === "active" ||
			record?.status === "returning"
		);
	}

	function assertAgentAccess(): void {
		if (isAgentPaused()) throw new Error("BROWSER_HANDOFF_AGENT_PAUSED");
		if (
			record &&
			["revoked", "expired", "crashed", "unknown"].includes(record.status)
		)
			throw new Error(record.terminalReason ?? "BROWSER_HANDOFF_UNAVAILABLE");
	}

	function agentObservation():
		| { status: "available" }
		| {
				status: "paused";
				reasonCode: "BROWSER_HANDOFF_AGENT_OBSERVATION_PAUSED";
		  }
		| { status: "blocked"; reasonCode: string } {
		if (isAgentPaused())
			return {
				status: "paused",
				reasonCode: "BROWSER_HANDOFF_AGENT_OBSERVATION_PAUSED",
			};
		if (
			record &&
			["revoked", "expired", "crashed", "unknown"].includes(record.status)
		)
			return {
				status: "blocked",
				reasonCode: record.terminalReason ?? "BROWSER_HANDOFF_UNAVAILABLE",
			};
		return { status: "available" };
	}

	return {
		binding,
		snapshot,
		request,
		takeOver,
		returnToAgent,
		revoke,
		markBrowserCrashed,
		isAgentPaused,
		assertAgentAccess,
		agentObservation,
	};
}

/** Execute one request-local handoff operation against the existing controller. */
export function executeBrowserHandoffOperationV1(
	controller: BrowserHandoffControllerV1,
	operation: BrowserHandoffOperationV1,
	runtime: BrowserHandoffRuntimeSnapshotV1,
): BrowserHandoffRecordV1 | undefined {
	switch (operation.kind) {
		case "request":
			return controller.request(operation.reason, runtime);
		case "take_over":
			return controller.takeOver({ ...operation, runtime });
		case "return_to_agent":
			return controller.returnToAgent({ ...operation, runtime });
		case "revoke":
			return controller.revoke(operation.reason);
		case "browser_crashed":
			return controller.markBrowserCrashed();
	}
}
