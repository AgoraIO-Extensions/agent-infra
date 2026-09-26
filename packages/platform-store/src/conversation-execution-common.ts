import { Buffer } from "node:buffer";
import {
	ConversationExecutionError,
	type ConversationExecutionTransactionPortV1,
} from "@agent-infra/platform-core";
import type postgres from "postgres";

export const idempotencyKeyPattern = /^[A-Za-z0-9._~-]{1,128}$/;

export const requestDigestPattern = /^[a-f0-9]{64}$/;

export const activeExecutionStatuses = new Set([
	"submitted",
	"processing",
	"unknown",
]);

export type Transaction = postgres.TransactionSql;

export type JsonValue = Parameters<ReturnType<typeof postgres>["json"]>[0];

export type CreateRequest = Parameters<
	ConversationExecutionTransactionPortV1["createConversation"]
>[0];

export type CreateDecide = Parameters<
	ConversationExecutionTransactionPortV1["createConversation"]
>[1];

export type ConversationQueryRequest = Parameters<
	ConversationExecutionTransactionPortV1["readConversation"]
>[0];

export type ConversationQueryProject = Parameters<
	ConversationExecutionTransactionPortV1["readConversation"]
>[1];

export type MessageRequest = Parameters<
	ConversationExecutionTransactionPortV1["executeMessage"]
>[0];

export type MessageDecide = Parameters<
	ConversationExecutionTransactionPortV1["executeMessage"]
>[1];

export type ModelSelectionRequest = Parameters<
	ConversationExecutionTransactionPortV1["executeModelSelection"]
>[0];

export type ModelSelectionDecide = Parameters<
	ConversationExecutionTransactionPortV1["executeModelSelection"]
>[1];

export type RegenerationRequest = Parameters<
	ConversationExecutionTransactionPortV1["executeRegeneration"]
>[0];

export type RegenerationDecide = Parameters<
	ConversationExecutionTransactionPortV1["executeRegeneration"]
>[1];

export type StopRequest = Parameters<
	ConversationExecutionTransactionPortV1["executeStop"]
>[0];

export type StopDecide = Parameters<
	ConversationExecutionTransactionPortV1["executeStop"]
>[1];

export interface IdempotencyRow {
	readonly request_digest: string;
	readonly status: "reserved" | "completed";
	readonly result: unknown;
}

export interface ConversationRow {
	readonly id: string;
	readonly agent_id: string;
	readonly actor_id: string;
	readonly channel_id: string;
	readonly status: string;
	readonly session_generation: string | number;
	readonly host_session_ref: string | null;
	readonly authorization_revision: string;
	readonly last_conversation_cursor: string | number;
	readonly selected_model_option_id: string | null;
	readonly selected_reasoning_level: string | null;
	readonly created_at: Date;
	readonly updated_at: Date;
}

export interface ExecutionRow {
	readonly execution_id: string;
	readonly conversation_id: string;
	readonly actor_id: string;
	readonly turn_id: string;
	readonly session_generation: string | number;
	readonly model_configuration_revision: string | number | null;
	readonly model_option_id: string | null;
	readonly reasoning_level: string | null;
	readonly last_event_sequence: string | number;
	readonly status: string;
}

export interface AgentConfigurationRow {
	readonly current_configuration_revision: string | number;
	readonly authorization_revision: string | null;
	readonly configuration: unknown;
}

export interface StopRow {
	readonly execution_id: string;
	readonly stop_request_id: string;
	readonly status: string;
}

export function unavailable(): never {
	throw new ConversationExecutionError("unavailable");
}

export function exactRecord(
	value: unknown,
	keys: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	try {
		const actualKeys =
			value && typeof value === "object"
				? [...keys, ...optional.filter((key) => Object.hasOwn(value, key))]
				: keys;
		if (
			typeof value !== "object" ||
			value === null ||
			Array.isArray(value) ||
			Reflect.ownKeys(value).length !== actualKeys.length ||
			actualKeys.some((key) => !Object.hasOwn(value, key))
		) {
			return unavailable();
		}
		const result: Record<string, unknown> = {};
		for (const key of actualKeys) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (
				descriptor?.enumerable !== true ||
				!Object.hasOwn(descriptor, "value") ||
				Object.hasOwn(descriptor, "get") ||
				Object.hasOwn(descriptor, "set")
			) {
				return unavailable();
			}
			result[key] = descriptor.value;
		}
		return result;
	} catch {
		return unavailable();
	}
}

export function text(value: unknown, maximum = 1024): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.includes("\0") ||
		!String.prototype.isWellFormed.call(value) ||
		Buffer.byteLength(value, "utf8") > maximum
	) {
		return unavailable();
	}
	return value;
}

export function safeInteger(value: unknown, minimum: number): number {
	const number = typeof value === "string" ? Number(value) : value;
	if (
		typeof number !== "number" ||
		!Number.isSafeInteger(number) ||
		number < minimum
	) {
		return unavailable();
	}
	return number;
}

export function date(value: unknown): Date {
	try {
		if (!Number.isFinite(Date.prototype.getTime.call(value))) unavailable();
		return new Date(Date.prototype.getTime.call(value));
	} catch {
		return unavailable();
	}
}

export function sameDate(left: Date, right: Date): boolean {
	return left.getTime() === right.getTime();
}

export function timestamp(value: unknown): string {
	if (typeof value !== "string") unavailable();
	const milliseconds = Date.parse(value);
	if (!Number.isFinite(milliseconds)) unavailable();
	return new Date(milliseconds).toISOString();
}
