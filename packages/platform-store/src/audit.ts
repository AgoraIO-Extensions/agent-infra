import { Buffer } from "node:buffer";

import { desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { auditEvents } from "./schema.js";

const platformAuditActions = [
	"agent.application.submitted",
	"agent.application.updated",
	"agent.application.resubmitted",
	"agent.application.withdrawn",
	"agent.application.approved",
	"agent.application.rejected",
	"agent.lifecycle.stopped",
	"agent.lifecycle.restarted",
	"agent.lifecycle.creation_retried",
	"agent.lifecycle.disabled",
	"agent.workload.creation_succeeded",
	"agent.workload.creation_failed",
	"agent.workload.service_starting",
	"agent.workload.service_ready",
	"agent.workload.service_updating",
	"agent.workload.service_unavailable",
	"agent.configuration.revised",
	"agent.access.updated",
] as const;

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

export type PlatformAuditActionV1 = (typeof platformAuditActions)[number];
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
		readonly kind: "user" | "system";
		readonly actorId: string;
	};
	readonly action: PlatformAuditActionV1;
	readonly subject: {
		readonly kind: "agent_application" | "agent";
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

export interface PlatformAuditQueryV1 {
	listAudit(
		scope: PlatformAuditAdministratorScopeV1,
		page: PlatformAuditPageInputV1,
	): Promise<PlatformAuditPageV1>;
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

const actionSet = new Set<string>(platformAuditActions);
const changedFieldSet = new Set<string>(configurationChangedFields);
const applicationActions = new Set<string>([
	"agent.application.submitted",
	"agent.application.updated",
	"agent.application.resubmitted",
	"agent.application.withdrawn",
	"agent.application.approved",
	"agent.application.rejected",
]);
const systemActions = new Set<string>([
	"agent.workload.creation_succeeded",
	"agent.workload.creation_failed",
	"agent.workload.service_starting",
	"agent.workload.service_ready",
	"agent.workload.service_updating",
	"agent.workload.service_unavailable",
]);
const detailedActions = new Set<string>([
	"agent.configuration.revised",
	"agent.access.updated",
]);

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
	if (!detailedActions.has(action)) {
		if (details !== null) throw new PlatformAuditQueryError("unavailable");
		return [];
	}
	if (!exactObject(details, ["changedFields"])) {
		throw new PlatformAuditQueryError("unavailable");
	}
	const fields = (details as { readonly changedFields: unknown }).changedFields;
	if (
		!Array.isArray(fields) ||
		fields.length === 0 ||
		fields.some(
			(field) => typeof field !== "string" || !changedFieldSet.has(field),
		) ||
		fields.some(
			(field, index) => index > 0 && (fields[index - 1] as string) >= field,
		)
	) {
		throw new PlatformAuditQueryError("unavailable");
	}
	return fields as PlatformAuditChangedFieldV1[];
}

interface AuditRow {
	readonly auditId: string;
	readonly traceId: string;
	readonly actorType: string;
	readonly actorId: string;
	readonly action: string;
	readonly targetType: string;
	readonly targetId: string;
	readonly outcome: "succeeded" | "rejected" | "failed";
	readonly occurredAt: Date;
	readonly details: unknown;
}

function decodeRow(row: AuditRow): PlatformAuditProjectionV1 {
	if (
		!validText(row.auditId) ||
		!validText(row.traceId) ||
		!validText(row.actorId) ||
		!actionSet.has(row.action) ||
		!validText(row.targetId) ||
		!validDate(row.occurredAt)
	) {
		throw new PlatformAuditQueryError("unavailable");
	}
	const action = row.action as PlatformAuditActionV1;
	const expectedActorType = systemActions.has(action) ? "system" : "user";
	const expectedTargetType = applicationActions.has(action)
		? "agent_application"
		: "agent";
	if (
		row.actorType !== expectedActorType ||
		row.targetType !== expectedTargetType ||
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
		subject: { kind: expectedTargetType, subjectId: row.targetId },
		result: row.outcome === "succeeded" ? "succeeded" : "failed",
		summary: fields.length === 0 ? action : `${action}: ${fields.join(", ")}`,
		occurredAt: new Date(Date.prototype.getTime.call(row.occurredAt)),
		traceId: row.traceId,
	};
}

const auditSelection = {
	auditId: auditEvents.id,
	traceId: auditEvents.traceId,
	actorType: auditEvents.actorType,
	actorId: auditEvents.actorId,
	action: auditEvents.action,
	targetType: auditEvents.targetType,
	targetId: auditEvents.targetId,
	outcome: auditEvents.outcome,
	occurredAt: auditEvents.occurredAt,
	details: auditEvents.details,
};
const cursorAuditEvent = alias(auditEvents, "cursor_audit_event");

export class PostgresPlatformAuditQueryV1 implements PlatformAuditQueryV1 {
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
			const [anchor] = page.cursor
				? await this.#database
						.select({ auditId: auditEvents.id })
						.from(auditEvents)
						.where(eq(auditEvents.id, page.cursor))
						.limit(1)
				: [];
			if (page.cursor && !anchor) {
				throw new PlatformAuditQueryError("invalid_request");
			}
			const rows = await this.#database
				.select(auditSelection)
				.from(auditEvents)
				.where(
					page.cursor
						? sql<boolean>`
							(${auditEvents.occurredAt}, ${auditEvents.id}) < (
								select ${cursorAuditEvent.occurredAt}, ${cursorAuditEvent.id}
								from ${cursorAuditEvent}
								where ${cursorAuditEvent.id} = ${page.cursor}
							)
						`
						: undefined,
				)
				.orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
				.limit(page.limit + 1);
			const hasNext = rows.length > page.limit;
			const items = rows.slice(0, page.limit).map(decodeRow);
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
