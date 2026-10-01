import { Buffer } from "node:buffer";
import {
	type AgentManagementStateV1,
	isAgentAccessAllowedV1,
} from "./agent-management.js";
import { parseAgentManagementPortState } from "./agent-management-input.js";
import {
	type CurrentTaskUserV1,
	parseCurrentTaskUserV1,
} from "./task-authorization.js";
import { isPlatformConversationChannelCurrentV1 } from "./task-runtime-authorization.js";

export interface RecentPersonalConversationProjectionV1 {
	readonly conversationId: string;
	readonly agentId: string;
	readonly status: "ready" | "active" | "unavailable";
	readonly selectedModelOptionId: string | null;
	readonly selectedReasoningLevel: string | null;
	readonly lastConversationCursor: string | null;
	readonly createdAt: Date;
	readonly updatedAt: Date;
}

export interface RecentPersonalConversationPositionV1 {
	/** Exact UTC PostgreSQL timestamp, including all six fractional digits. */
	readonly updatedAt: string;
	readonly conversationId: string;
}

export interface RecentPersonalConversationsQueryV1 {
	readonly user: CurrentTaskUserV1;
	readonly limit: number;
	readonly after?: RecentPersonalConversationPositionV1;
}

export interface RecentPersonalConversationRecordV1 {
	readonly projection: RecentPersonalConversationProjectionV1;
	readonly actorId: string;
	readonly channelId: string;
	readonly position: RecentPersonalConversationPositionV1;
	readonly agent: AgentManagementStateV1;
	readonly channel: Parameters<
		typeof isPlatformConversationChannelCurrentV1
	>[0];
}

export interface RecentPersonalConversationsQueryPortV1 {
	/** Current grants and channel eligibility must precede the global limit. */
	readRecentPersonalConversations(
		query: RecentPersonalConversationsQueryV1,
	): Promise<readonly RecentPersonalConversationRecordV1[]>;
}

export interface RecentPersonalConversationsPageV1 {
	readonly items: readonly RecentPersonalConversationProjectionV1[];
	readonly nextCursor: string | null;
}

export interface RecentPersonalConversationsUseCaseV1 {
	list(
		actorId: string,
		page: { readonly limit?: number; readonly cursor?: string },
	): Promise<RecentPersonalConversationsPageV1>;
}

export class RecentPersonalConversationsError extends Error {
	constructor(readonly code: "invalid_request" | "revoked" | "unavailable") {
		super("Recent personal conversations are unavailable");
		this.name = "RecentPersonalConversationsError";
	}
}

const queryVersion = "personal-web-recent-v1";
const queryOrder = "updated_at.desc,id.desc";
const historyStatuses = new Set([
	"creating",
	"available",
	"stopped",
	"creation_failed",
	"disabled",
]);

function fail(code: RecentPersonalConversationsError["code"]): never {
	throw new RecentPersonalConversationsError(code);
}

function text(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!value.includes("\0") &&
		value.isWellFormed() &&
		Buffer.byteLength(value, "utf8") <= 1024
	);
}

function exactTimestamp(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		value.startsWith("0000-") ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)
	)
		return false;
	const date = new Date(value);
	return (
		Number.isFinite(date.getTime()) &&
		date.toISOString() === `${value.slice(0, 23)}Z`
	);
}

function decodeCursor(
	value: string,
	actorId: string,
): RecentPersonalConversationPositionV1 {
	try {
		if (value.length > 4096 || !/^recent\.v1\.[A-Za-z0-9_-]+$/.test(value))
			return fail("invalid_request");
		const encoded = value.slice("recent.v1.".length);
		const bytes = Buffer.from(encoded, "base64url");
		if (bytes.toString("base64url") !== encoded) return fail("invalid_request");
		const cursor: unknown = JSON.parse(bytes.toString("utf8"));
		if (
			!Array.isArray(cursor) ||
			cursor.length !== 6 ||
			cursor[0] !== queryVersion ||
			cursor[1] !== actorId ||
			cursor[2] !== "web" ||
			cursor[3] !== queryOrder ||
			!exactTimestamp(cursor[4]) ||
			!text(cursor[5])
		)
			return fail("invalid_request");
		return { updatedAt: cursor[4], conversationId: cursor[5] };
	} catch {
		return fail("invalid_request");
	}
}

function encodeCursor(
	actorId: string,
	position: RecentPersonalConversationPositionV1,
): string {
	return `recent.v1.${Buffer.from(
		JSON.stringify([
			queryVersion,
			actorId,
			"web",
			queryOrder,
			position.updatedAt,
			position.conversationId,
		]),
	).toString("base64url")}`;
}

export function createRecentPersonalConversationsUseCaseV1(options: {
	resolveCurrentUser(actorId: string): Promise<CurrentTaskUserV1 | null>;
	readonly query: RecentPersonalConversationsQueryPortV1;
}): RecentPersonalConversationsUseCaseV1 {
	return {
		async list(actorId, page) {
			if (
				!text(actorId) ||
				!page ||
				typeof page !== "object" ||
				Array.isArray(page) ||
				Object.keys(page).some((key) => key !== "limit" && key !== "cursor")
			)
				return fail("invalid_request");
			const limit = page.limit === undefined ? 50 : page.limit;
			if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
				return fail("invalid_request");
			const after =
				page.cursor === undefined
					? undefined
					: decodeCursor(page.cursor, actorId);
			try {
				const resolved = await options.resolveCurrentUser(actorId);
				if (!resolved) return fail("unavailable");
				const user = parseCurrentTaskUserV1(resolved);
				if (user.userId !== actorId) return fail("unavailable");
				if (user.accountStatus !== "active") return fail("revoked");
				const records = await options.query.readRecentPersonalConversations({
					user,
					limit: limit + 1,
					...(after === undefined ? {} : { after }),
				});
				if (!Array.isArray(records) || records.length > limit + 1)
					return fail("unavailable");
				const ids = new Set<string>();
				for (const record of records) {
					const agent = parseAgentManagementPortState(record.agent);
					if (
						record.actorId !== actorId ||
						record.channelId !== "web" ||
						!historyStatuses.has(agent.status) ||
						agent.agentId !== record.projection.agentId ||
						record.channel.boundary.agentId !== agent.agentId ||
						record.channel.boundary.channelId !== "web" ||
						!text(record.projection.conversationId) ||
						ids.has(record.projection.conversationId) ||
						record.position.conversationId !==
							record.projection.conversationId ||
						!exactTimestamp(record.position.updatedAt) ||
						!(record.projection.updatedAt instanceof Date) ||
						record.projection.updatedAt.getTime() !==
							new Date(record.position.updatedAt).getTime() ||
						!isAgentAccessAllowedV1(
							agent,
							{
								schemaVersion: 1,
								userId: user.userId,
								accountStatus: user.accountStatus,
								organizationIds: user.organizationIds,
								isAdministrator: false,
							},
							"use",
						) ||
						!isPlatformConversationChannelCurrentV1(record.channel)
					)
						return fail("unavailable");
					ids.add(record.projection.conversationId);
				}
				const items = records.slice(0, limit).map(({ projection }) => ({
					conversationId: projection.conversationId,
					agentId: projection.agentId,
					status: projection.status,
					selectedModelOptionId: projection.selectedModelOptionId,
					selectedReasoningLevel: projection.selectedReasoningLevel,
					lastConversationCursor: projection.lastConversationCursor,
					createdAt: projection.createdAt,
					updatedAt: projection.updatedAt,
				}));
				const last = records[limit - 1];
				return {
					items,
					nextCursor:
						records.length > limit && last
							? encodeCursor(actorId, last.position)
							: null,
				};
			} catch (error) {
				if (error instanceof RecentPersonalConversationsError) throw error;
				return fail("unavailable");
			}
		},
	};
}
