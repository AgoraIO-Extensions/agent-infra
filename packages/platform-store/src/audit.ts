import { Buffer } from "node:buffer";
import { parseTaskApiAuditInputV1 } from "@agent-infra/platform-core";

import { desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { auditEvents } from "./schema.js";

const wecomDeliveryAuditMetadata = {
	actorKind: "system",
	subjectKind: "agent",
	details: "wecom_delivery",
} as const;

const platformAuditActionMetadata = {
	"task.api.access": {
		actorKind: "user",
		subjectKind: "unknown",
		details: "task_api",
	},
	"task.api.subscription.started": {
		actorKind: "user",
		subjectKind: "unknown",
		details: "task_api",
	},
	"task.api.subscription.ended": {
		actorKind: "user",
		subjectKind: "unknown",
		details: "task_api",
	},
	"api.agent.state.read": {
		actorKind: "user",
		subjectKind: "agent",
		details: "api_management",
	},
	"api.agent.manager.granted": {
		actorKind: "user",
		subjectKind: "agent",
		details: "api_management",
	},
	"api.agent.manager.revoked": {
		actorKind: "user",
		subjectKind: "agent",
		details: "api_management",
	},
	"api.agent.manager.replayed": {
		actorKind: "user",
		subjectKind: "agent",
		details: "api_management",
	},
	"api.agent.lifecycle.refused": {
		actorKind: "user",
		subjectKind: "agent",
		details: "api_management",
	},
	"api.agent.manager.refused": {
		actorKind: "user",
		subjectKind: "agent",
		details: "api_management",
	},
	"api.agent.state.refused": {
		actorKind: "user",
		subjectKind: "agent",
		details: "api_management",
	},

	"api.agent.use.granted": {
		actorKind: "user",
		subjectKind: "agent",
		details: "api_management",
	},
	"api.agent.use.revoked": {
		actorKind: "user",
		subjectKind: "agent",
		details: "api_management",
	},
	"api.agent.use.replayed": {
		actorKind: "user",
		subjectKind: "agent",
		details: "api_management",
	},
	"api.agent.use.refused": {
		actorKind: "user",
		subjectKind: "agent",
		details: "api_management",
	},

	"audit.query.completed": {
		actorKind: "user",
		subjectKind: "unknown",
		details: false,
	},
	"audit.query.failed": {
		actorKind: "user",
		subjectKind: "unknown",
		details: false,
	},
	"agent.application.submitted": {
		actorKind: "user",
		subjectKind: "agent_application",
		details: false,
	},
	"agent.application.updated": {
		actorKind: "user",
		subjectKind: "agent_application",
		details: false,
	},
	"agent.application.resubmitted": {
		actorKind: "user",
		subjectKind: "agent_application",
		details: false,
	},
	"agent.application.withdrawn": {
		actorKind: "user",
		subjectKind: "agent_application",
		details: false,
	},
	"agent.application.approved": {
		actorKind: "user",
		subjectKind: "agent_application",
		details: false,
	},
	"agent.application.rejected": {
		actorKind: "user",
		subjectKind: "agent_application",
		details: false,
	},
	"agent.lifecycle.stopped": {
		actorKind: "user",
		subjectKind: "agent",
		details: false,
	},
	"agent.lifecycle.restarted": {
		actorKind: "user",
		subjectKind: "agent",
		details: false,
	},
	"agent.lifecycle.creation_retried": {
		actorKind: "user",
		subjectKind: "agent",
		details: false,
	},
	"agent.lifecycle.disabled": {
		actorKind: "user",
		subjectKind: "agent",
		details: false,
	},
	"agent.workload.creation_succeeded": {
		actorKind: "system",
		subjectKind: "agent",
		details: false,
	},
	"agent.workload.creation_failed": {
		actorKind: "system",
		subjectKind: "agent",
		details: false,
	},
	"agent.workload.service_starting": {
		actorKind: "system",
		subjectKind: "agent",
		details: false,
	},
	"agent.workload.service_ready": {
		actorKind: "system",
		subjectKind: "agent",
		details: false,
	},
	"agent.workload.service_updating": {
		actorKind: "system",
		subjectKind: "agent",
		details: false,
	},
	"agent.workload.service_unavailable": {
		actorKind: "system",
		subjectKind: "agent",
		details: false,
	},
	"agent.configuration.revised": {
		actorKind: "user",
		subjectKind: "agent",
		details: true,
	},
	"agent.access.updated": {
		actorKind: "user",
		subjectKind: "agent",
		details: true,
	},
	"secret.decrypt": {
		actorKind: "system",
		subjectKind: "secret",
		details: "secret",
	},
	"secret.activate": {
		actorKind: "system",
		subjectKind: "secret",
		details: "secret",
	},
	"secret.rewrap": {
		actorKind: "system",
		subjectKind: "secret",
		details: "secret",
	},
	"secret.retire-key": {
		actorKind: "system",
		subjectKind: "secret_key",
		details: "secret",
	},
	"wecom.setup_started": {
		actorKind: "user",
		subjectKind: "agent",
		details: false,
	},
	"wecom.credentials_submitted": {
		actorKind: "user",
		subjectKind: "agent",
		details: false,
	},
	"wecom.setup_cancelled": {
		actorKind: "user",
		subjectKind: "agent",
		details: false,
	},
	"wecom.setup_expired": {
		actorKind: "system",
		subjectKind: "agent",
		details: false,
	},
	"wecom.setup_failed": {
		actorKind: "system",
		subjectKind: "agent",
		details: false,
	},
	"wecom.callback_verified": {
		actorKind: "system",
		subjectKind: "agent",
		details: false,
	},
	"wecom.setup_activated": {
		actorKind: "system",
		subjectKind: "agent",
		details: false,
	},
	"wecom.connection_verifying": {
		actorKind: "system",
		subjectKind: "agent",
		details: false,
	},
	"wecom.connection_connected": {
		actorKind: "system",
		subjectKind: "agent",
		details: false,
	},
	"wecom.connection_disconnected": {
		actorKind: "system",
		subjectKind: "agent",
		details: false,
	},
	"wecom.connection_auth_failed": {
		actorKind: "system",
		subjectKind: "agent",
		details: false,
	},
	"wecom.denied": wecomDeliveryAuditMetadata,
	"wecom.unavailable": wecomDeliveryAuditMetadata,
	"wecom.conflict": wecomDeliveryAuditMetadata,
	"wecom.accepted": wecomDeliveryAuditMetadata,
	"wecom.unknown": wecomDeliveryAuditMetadata,
	"wecom.sending": wecomDeliveryAuditMetadata,
	"wecom.sent": wecomDeliveryAuditMetadata,
	"wecom.failed": wecomDeliveryAuditMetadata,
	"wecom.cancelled": wecomDeliveryAuditMetadata,
	"wecom.expired": wecomDeliveryAuditMetadata,
	"wecom.abandoned": wecomDeliveryAuditMetadata,
} as const;

const configurationChangedFields = [
	"source",
	"environment",
	"modelConfiguration",
	"secrets",
	"actions",
	"channels",
	"owners",
	"availability",
] as const;

export type PlatformAuditActionV1 = keyof typeof platformAuditActionMetadata;
export type PlatformAuditChangedFieldV1 =
	(typeof configurationChangedFields)[number];

export interface PlatformAuditAdministratorScopeV1 {
	readonly schemaVersion: 1;
	readonly kind: "administrator";
	readonly administratorId: string;
}

export interface PlatformAuditPageInputV1 {
	readonly schemaVersion: 1;
	readonly limit: number;
	readonly cursor?: string;
}

export interface PlatformAuditProjectionV1 {
	readonly schemaVersion: 1;
	readonly auditId: string;
	readonly actor: {
		readonly kind: "user" | "application" | "system" | "unknown";
		readonly actorId: string;
	};
	readonly action: PlatformAuditActionV1;
	readonly subject: {
		readonly kind:
			| "agent_application"
			| "agent"
			| "secret"
			| "secret_key"
			| "grant"
			| "unknown"
			| "conversation"
			| "execution"
			| "configuration";
		readonly subjectId: string;
	};
	readonly result: "succeeded" | "failed";
	readonly summary: string;
	readonly occurredAt: Date;
	readonly traceId: string;
}

export interface PlatformAuditPageV1 {
	readonly items: readonly PlatformAuditProjectionV1[];
	readonly nextCursor: string | null;
}

export interface PostgresPlatformAuditOptionsV1 {
	readonly databaseUrl: string;
}

export class PlatformAuditQueryError extends Error {
	readonly code: "access_denied" | "invalid_request" | "unavailable";

	constructor(code: "access_denied" | "invalid_request" | "unavailable") {
		super(
			code === "access_denied"
				? "Platform audit is unavailable"
				: code === "invalid_request"
					? "Invalid Platform audit request"
					: "Platform audit persistence is unavailable",
		);
		this.name = "PlatformAuditQueryError";
		this.code = code;
	}
}

const changedFieldSet = new Set<string>(configurationChangedFields);
const accessChangedFieldSet = new Set<string>(["availability", "owners"]);

function validText(input: unknown): input is string {
	return (
		typeof input === "string" &&
		input.length > 0 &&
		!input.includes("\0") &&
		String.prototype.isWellFormed.call(input) &&
		Buffer.byteLength(input, "utf8") <= 1024
	);
}

function exactObject(input: unknown, keys: readonly string[]): boolean {
	return (
		typeof input === "object" &&
		input !== null &&
		!Array.isArray(input) &&
		Object.keys(input).length === keys.length &&
		keys.every((key) => Object.hasOwn(input, key))
	);
}

function requireScope(scope: PlatformAuditAdministratorScopeV1): void {
	try {
		if (
			!exactObject(scope, ["schemaVersion", "kind", "administratorId"]) ||
			scope.schemaVersion !== 1 ||
			scope.kind !== "administrator" ||
			!validText(scope.administratorId)
		) {
			throw new PlatformAuditQueryError("access_denied");
		}
	} catch (error) {
		if (error instanceof PlatformAuditQueryError) throw error;
		throw new PlatformAuditQueryError("access_denied");
	}
}

function requirePage(page: PlatformAuditPageInputV1): void {
	try {
		const keys =
			page.cursor === undefined
				? ["schemaVersion", "limit"]
				: ["schemaVersion", "limit", "cursor"];
		if (
			!exactObject(page, keys) ||
			page.schemaVersion !== 1 ||
			!Number.isInteger(page.limit) ||
			page.limit < 1 ||
			page.limit > 100 ||
			(page.cursor !== undefined && !validText(page.cursor))
		) {
			throw new PlatformAuditQueryError("invalid_request");
		}
	} catch (error) {
		if (error instanceof PlatformAuditQueryError) throw error;
		throw new PlatformAuditQueryError("invalid_request");
	}
}

function validDate(input: unknown): input is Date {
	try {
		return Number.isFinite(Date.prototype.getTime.call(input));
	} catch {
		return false;
	}
}

function changedFields(
	action: PlatformAuditActionV1,
	details: unknown,
): readonly PlatformAuditChangedFieldV1[] {
	if (action === "audit.query.completed" || action === "audit.query.failed") {
		if (
			typeof details !== "object" ||
			details === null ||
			Array.isArray(details) ||
			(details as Record<string, unknown>).schemaVersion !== 1 ||
			(details as Record<string, unknown>).result !==
				(action === "audit.query.completed" ? "succeeded" : "failed")
		)
			throw new PlatformAuditQueryError("unavailable");
		return [];
	}
	const detailKind = platformAuditActionMetadata[action].details;
	if (detailKind === "api_management") {
		if (action === "api.agent.state.read") {
			if (details !== null) throw new PlatformAuditQueryError("unavailable");
			return [];
		}
		if (action.endsWith(".refused")) {
			const value = details as Record<string, unknown> | null;
			const keys =
				value && Object.hasOwn(value, "command")
					? ["reason", "command"]
					: ["reason"];
			const commands =
				action === "api.agent.lifecycle.refused"
					? ["start", "stop", "restart"]
					: action === "api.agent.manager.refused"
						? ["grant_manager", "revoke_manager"]
						: action === "api.agent.use.refused"
							? ["grant_use", "revoke_use"]
							: ["read_state"];
			if (
				!exactObject(details, keys) ||
				!value ||
				![
					"invalid_input",
					"authentication_required",
					"forbidden",
					"not_found",
					"unavailable",
					"idempotency_conflict",
					"conflict",
					"denied",
				].includes(value.reason as string) ||
				(Object.hasOwn(value, "command") &&
					!commands.includes(value.command as string))
			)
				throw new PlatformAuditQueryError("unavailable");
			return [];
		}
		if (
			!exactObject(details, [
				"applicationId",
				"grantType",
				"granted",
				"authorizationRevision",
			])
		)
			throw new PlatformAuditQueryError("unavailable");
		const value = details as Record<string, unknown>;
		if (
			!validText(value.applicationId) ||
			value.grantType !==
				(action.startsWith("api.agent.use.") ? "use" : "manage") ||
			typeof value.granted !== "boolean" ||
			(value.authorizationRevision !== null &&
				!validText(value.authorizationRevision)) ||
			(value.granted && value.authorizationRevision === null) ||
			(action.endsWith(".granted") && value.granted !== true) ||
			(action.endsWith(".revoked") && value.granted !== false)
		)
			throw new PlatformAuditQueryError("unavailable");
		return [];
	}
	if (detailKind === false) {
		if (details !== null) throw new PlatformAuditQueryError("unavailable");
		return [];
	}
	if (detailKind === "secret") {
		if (!exactObject(details, ["wrappingKeyVersion", "operation", "result"])) {
			throw new PlatformAuditQueryError("unavailable");
		}
		const value = details as Record<string, unknown>;
		const expectedOperation = {
			"secret.decrypt": "decrypt",
			"secret.activate": "activate",
			"secret.rewrap": "rewrap",
			"secret.retire-key": "retire-key",
		}[
			action as
				| "secret.decrypt"
				| "secret.activate"
				| "secret.rewrap"
				| "secret.retire-key"
		];
		if (
			!validText(value.wrappingKeyVersion) ||
			value.operation !== expectedOperation ||
			(value.result !== "succeeded" &&
				value.result !== "rejected" &&
				value.result !== "failed")
		) {
			throw new PlatformAuditQueryError("unavailable");
		}
		return [];
	}
	if (detailKind === "wecom_delivery") {
		if (
			!exactObject(details, [
				"originalPrincipal",
				"component",
				"receiptId",
				"status",
			])
		)
			throw new PlatformAuditQueryError("unavailable");
		const value = details as {
			readonly originalPrincipal: unknown;
			readonly component: unknown;
			readonly receiptId: unknown;
			readonly status: unknown;
		};
		if (!exactObject(value.originalPrincipal, ["kind", "id"]))
			throw new PlatformAuditQueryError("unavailable");
		const originalPrincipal = value.originalPrincipal as {
			readonly kind: unknown;
			readonly id: unknown;
		};
		if (
			(originalPrincipal.kind !== "user" &&
				originalPrincipal.kind !== "unknown") ||
			!validText(originalPrincipal.id) ||
			(originalPrincipal.kind === "unknown" &&
				originalPrincipal.id !== "unknown")
		)
			throw new PlatformAuditQueryError("unavailable");
		if (
			(value.component !== "platform-api" &&
				value.component !== "platform-worker") ||
			!validText(value.receiptId) ||
			value.status !== action.slice("wecom.".length)
		)
			throw new PlatformAuditQueryError("unavailable");
		return [];
	}
	if (!exactObject(details, ["changedFields"])) {
		throw new PlatformAuditQueryError("unavailable");
	}
	const fields = (details as { readonly changedFields: unknown }).changedFields;
	const allowedFields =
		action === "agent.access.updated" ? accessChangedFieldSet : changedFieldSet;
	if (
		!Array.isArray(fields) ||
		fields.length === 0 ||
		fields.some(
			(field) => typeof field !== "string" || !allowedFields.has(field),
		) ||
		fields.some(
			(field, index) => index > 0 && (fields[index - 1] as string) >= field,
		)
	) {
		throw new PlatformAuditQueryError("unavailable");
	}
	return fields as PlatformAuditChangedFieldV1[];
}

export interface AuditRow {
	readonly auditId: string;
	readonly traceId: string;
	readonly requestId?: string | null;
	readonly actorType: string;
	readonly actorId: string;
	readonly action: string;
	readonly targetType: string;
	readonly targetId: string;
	readonly outcome: "succeeded" | "rejected" | "failed";
	readonly occurredAt: Date;
	readonly details: unknown;
}

export function decodePlatformAuditRowV1(
	row: AuditRow,
): PlatformAuditProjectionV1 {
	if (
		[
			"task.api.access",
			"task.api.subscription.started",
			"task.api.subscription.ended",
		].includes(row.action)
	) {
		try {
			const value = row.details as Record<string, unknown>;
			const keys =
				value && Object.hasOwn(value, "subscriptionId")
					? [
							"schemaVersion",
							"operation",
							"phase",
							"reason",
							"target",
							"subscriptionId",
						]
					: ["schemaVersion", "operation", "phase", "reason", "target"];
			if (
				!exactObject(value, keys) ||
				!["user", "application", "unknown"].includes(row.actorType) ||
				(row.actorType === "unknown" && row.actorId !== "unknown")
			)
				throw new Error();
			const parsed = parseTaskApiAuditInputV1({
				...value,
				auditId: row.auditId,
				principal:
					row.actorType === "unknown"
						? { kind: "unknown" }
						: { kind: row.actorType, id: row.actorId },
				result: row.outcome,
				requestId: row.requestId,
				traceId: row.traceId,
				occurredAt: row.occurredAt,
			});
			const target = parsed.target;
			const targetId =
				target.kind === "unknown"
					? "unknown"
					: target.kind === "agent"
						? target.agentId
						: target.kind === "conversation"
							? target.conversationId
							: target.executionId;
			const action =
				parsed.phase === "access"
					? "task.api.access"
					: `task.api.${parsed.phase}`;
			if (
				action !== row.action ||
				target.kind !== row.targetType ||
				targetId !== row.targetId
			)
				throw new Error();
			return {
				schemaVersion: 1,
				auditId: row.auditId,
				actor: {
					kind: row.actorType as "user" | "application" | "unknown",
					actorId: row.actorId,
				},
				action: row.action as PlatformAuditActionV1,
				subject: {
					kind: row.targetType as
						| "unknown"
						| "agent"
						| "conversation"
						| "execution",
					subjectId: row.targetId,
				},
				result: row.outcome === "succeeded" ? "succeeded" : "failed",
				summary: `operation=${parsed.operation}; phase=${parsed.phase}; reason=${parsed.reason}`,
				occurredAt: new Date(row.occurredAt),
				traceId: row.traceId,
			};
		} catch {
			throw new PlatformAuditQueryError("unavailable");
		}
	}
	if (
		!validText(row.auditId) ||
		!validText(row.traceId) ||
		!validText(row.actorId) ||
		!Object.hasOwn(platformAuditActionMetadata, row.action) ||
		!validText(row.targetId) ||
		!validDate(row.occurredAt)
	) {
		throw new PlatformAuditQueryError("unavailable");
	}
	const action = row.action as PlatformAuditActionV1;
	const metadata = platformAuditActionMetadata[action];
	const api = metadata.details === "api_management";
	const refusal = api && action.endsWith(".refused");
	const applicationLifecycle =
		row.actorType === "application" &&
		(action === "agent.lifecycle.stopped" ||
			action === "agent.lifecycle.restarted");
	const expectedActorType: PlatformAuditProjectionV1["actor"]["kind"] = api
		? (row.actorType as PlatformAuditProjectionV1["actor"]["kind"])
		: applicationLifecycle
			? "application"
			: metadata.actorKind;
	const expectedTargetType: PlatformAuditProjectionV1["subject"]["kind"] =
		refusal ? (row.targetType as "agent" | "unknown") : metadata.subjectKind;
	if (
		api &&
		(refusal
			? !["user", "application", "unknown"].includes(row.actorType) ||
				!["agent", "unknown"].includes(row.targetType) ||
				(row.actorType === "unknown" && row.actorId !== "unknown") ||
				(row.targetType === "unknown" && row.targetId !== "unknown") ||
				!["rejected", "failed"].includes(row.outcome)
			: row.outcome !== "succeeded" ||
				!(action === "api.agent.state.read"
					? ["user", "application"].includes(row.actorType)
					: row.actorType === "user"))
	)
		throw new PlatformAuditQueryError("unavailable");
	const subjectKind: PlatformAuditProjectionV1["subject"]["kind"] =
		action === "agent.configuration.revised" &&
		row.targetType === "configuration"
			? "configuration"
			: expectedTargetType;
	if (
		row.actorType !== expectedActorType ||
		(row.targetType !== expectedTargetType &&
			!(
				action === "agent.configuration.revised" &&
				row.targetType === "configuration"
			)) ||
		(row.outcome !== "succeeded" &&
			row.outcome !== "rejected" &&
			row.outcome !== "failed")
	) {
		throw new PlatformAuditQueryError("unavailable");
	}
	const fields = changedFields(action, row.details);
	return {
		schemaVersion: 1,
		auditId: row.auditId,
		actor: { kind: expectedActorType, actorId: row.actorId },
		action,
		subject: {
			kind: subjectKind,
			subjectId: subjectKind === "secret_key" ? "secret-key" : row.targetId,
		},
		result: row.outcome === "succeeded" ? "succeeded" : "failed",
		summary: fields.length === 0 ? action : `${action}: ${fields.join(", ")}`,
		occurredAt: new Date(Date.prototype.getTime.call(row.occurredAt)),
		traceId: row.traceId,
	};
}

const auditSelection = {
	auditId: auditEvents.id,
	traceId: auditEvents.traceId,
	requestId: auditEvents.requestId,
	actorType: auditEvents.actorType,
	actorId: auditEvents.actorId,
	action: auditEvents.action,
	targetType: auditEvents.targetType,
	targetId: auditEvents.targetId,
	outcome: auditEvents.outcome,
	occurredAt: auditEvents.occurredAt,
	details: auditEvents.details,
};

export class PostgresPlatformAuditQueryV1 {
	readonly #client;
	readonly #database;

	constructor(options: PostgresPlatformAuditOptionsV1) {
		this.#client = postgres(options.databaseUrl, {
			connect_timeout: 1,
			max: 1,
		});
		this.#database = drizzle(this.#client);
	}

	async listAudit(
		scope: PlatformAuditAdministratorScopeV1,
		page: PlatformAuditPageInputV1,
	): Promise<PlatformAuditPageV1> {
		requireScope(scope);
		requirePage(page);
		try {
			let rows: AuditRow[];
			if (page.cursor) {
				const cursor = this.#database.$with("audit_cursor").as(
					this.#database
						.select({
							auditId: auditEvents.id,
							occurredAt: auditEvents.occurredAt,
						})
						.from(auditEvents)
						.where(eq(auditEvents.id, page.cursor)),
				);
				const auditPage = this.#database.$with("audit_page").as(
					this.#database
						.select(auditSelection)
						.from(auditEvents)
						.innerJoin(cursor, sql`true`)
						.where(
							sql<boolean>`(${auditEvents.occurredAt}, ${auditEvents.id}) < (${cursor.occurredAt}, ${cursor.auditId}) AND ${auditEvents.action} NOT LIKE 'audit.query.%'`,
						)
						.orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
						.limit(page.limit + 1),
				);
				const result = await this.#database
					.with(cursor, auditPage)
					.select({
						cursorId: cursor.auditId,
						auditId: auditPage.auditId,
						traceId: auditPage.traceId,
						actorType: auditPage.actorType,
						actorId: auditPage.actorId,
						action: auditPage.action,
						targetType: auditPage.targetType,
						targetId: auditPage.targetId,
						outcome: auditPage.outcome,
						occurredAt: auditPage.occurredAt,
						details: auditPage.details,
					})
					.from(cursor)
					.leftJoin(auditPage, sql`true`)
					.orderBy(desc(auditPage.occurredAt), desc(auditPage.auditId));
				if (result.length === 0) {
					throw new PlatformAuditQueryError("invalid_request");
				}
				rows = result.flatMap(({ cursorId: _cursorId, ...row }) =>
					row.auditId === null ? [] : [row as unknown as AuditRow],
				);
			} else {
				rows = await this.#database
					.select(auditSelection)
					.from(auditEvents)
					.where(sql<boolean>`${auditEvents.action} NOT LIKE 'audit.query.%'`)
					.orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
					.limit(page.limit + 1);
			}
			const hasNext = rows.length > page.limit;
			const items = rows.slice(0, page.limit).map(decodePlatformAuditRowV1);
			return {
				items,
				nextCursor: hasNext ? (items.at(-1)?.auditId ?? null) : null,
			};
		} catch (error) {
			if (error instanceof PlatformAuditQueryError) throw error;
			throw new PlatformAuditQueryError("unavailable");
		}
	}

	async close(): Promise<void> {
		try {
			await this.#client.end();
		} catch {
			throw new PlatformAuditQueryError("unavailable");
		}
	}
}
