import { type KeyObject, verify } from "node:crypto";
import { TextDecoder } from "node:util";

import {
	ExecutionGrantClaimsV1Schema,
	type RuntimeGrantOperationV1,
	type SignedExecutionGrantV1,
} from "@agent-infra/contracts/runtime";

import { RuntimeHostError } from "./errors.js";

interface GrantBoundRequest {
	agentId: string;
	conversationId: string;
	executionId: string;
	turnId: string;
	sessionGeneration: number;
	grant: SignedExecutionGrantV1;
	input?: { attachments: string[] };
}

export interface ExecutionGrantVerifierOptions {
	expectedIssuer: string;
	expectedAudience: string;
	publicKeys: ReadonlyMap<string, KeyObject>;
	now?: () => Date;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
const rfc3339Instant =
	/^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|([+-])(\d{2}):(\d{2}))$/;

interface ComparableInstant {
	epochSecond: number;
	fraction: string;
}

function authorizationDenied(): never {
	throw new RuntimeHostError(
		"RUNTIME_GRANT_INVALID",
		"Execution Grant is invalid or does not authorize this request",
		403,
	);
}

function parseInstant(value: string): ComparableInstant | undefined {
	const match = rfc3339Instant.exec(value);
	if (!match) return undefined;
	const [
		,
		yearValue,
		monthValue,
		dayValue,
		hourValue,
		minuteValue,
		secondValue,
		fraction = "",
		zone,
		sign,
		offsetHourValue,
		offsetMinuteValue,
	] = match;
	const year = Number(yearValue);
	const month = Number(monthValue);
	const day = Number(dayValue);
	const hour = Number(hourValue);
	const minute = Number(minuteValue);
	const second = Number(secondValue);
	const date = new Date(0);
	date.setUTCFullYear(year, month - 1, day);
	date.setUTCHours(hour, minute, Math.min(second, 59), 0);
	const baseMilliseconds = date.getTime();
	if (!Number.isFinite(baseMilliseconds)) return undefined;
	const offsetSeconds =
		zone === "Z" || zone === "z"
			? 0
			: (sign === "+" ? 1 : -1) *
				(Number(offsetHourValue) * 60 + Number(offsetMinuteValue)) *
				60;
	return {
		epochSecond:
			baseMilliseconds / 1_000 + (second === 60 ? 1 : 0) - offsetSeconds,
		fraction,
	};
}

function instantFromDate(value: Date): ComparableInstant | undefined {
	const milliseconds = value.getTime();
	if (!Number.isFinite(milliseconds)) return undefined;
	const epochSecond = Math.floor(milliseconds / 1_000);
	const fractionMilliseconds = milliseconds - epochSecond * 1_000;
	return {
		epochSecond,
		fraction:
			fractionMilliseconds === 0
				? ""
				: String(fractionMilliseconds).padStart(3, "0"),
	};
}

function compareInstants(left: ComparableInstant, right: ComparableInstant) {
	if (left.epochSecond !== right.epochSecond) {
		return left.epochSecond < right.epochSecond ? -1 : 1;
	}
	const width = Math.max(left.fraction.length, right.fraction.length);
	const leftFraction = left.fraction.padEnd(width, "0");
	const rightFraction = right.fraction.padEnd(width, "0");
	return leftFraction < rightFraction
		? -1
		: leftFraction > rightFraction
			? 1
			: 0;
}

export function verifyExecutionGrant(
	request: GrantBoundRequest,
	requiredOperation: RuntimeGrantOperationV1,
	options: ExecutionGrantVerifierOptions,
) {
	const key = options.publicKeys.get(request.grant.keyId);
	if (!key) authorizationDenied();

	let payload: Buffer;
	let claimsValue: unknown;
	try {
		payload = Buffer.from(request.grant.payload, "base64url");
		const signature = Buffer.from(request.grant.signature, "base64url");
		if (!verify(null, payload, key, signature)) authorizationDenied();
		claimsValue = JSON.parse(utf8.decode(payload));
	} catch (error) {
		if (error instanceof RuntimeHostError) throw error;
		authorizationDenied();
	}

	const parsed = ExecutionGrantClaimsV1Schema.safeParse(claimsValue);
	if (!parsed.success) authorizationDenied();
	const claims = parsed.data;
	const now = instantFromDate((options.now ?? (() => new Date()))());
	const issuedAt = parseInstant(claims.issuedAt);
	const expiresAt = parseInstant(claims.expiresAt);
	const attachments = request.input?.attachments ?? [];
	const allowedAttachments = new Set(
		claims.attachments
			.filter(({ operations }) => operations.includes("read"))
			.map(({ attachmentId }) => attachmentId),
	);

	if (
		!now ||
		!issuedAt ||
		!expiresAt ||
		claims.issuer !== options.expectedIssuer ||
		!claims.audience.includes(options.expectedAudience) ||
		compareInstants(issuedAt, now) > 0 ||
		compareInstants(expiresAt, now) <= 0 ||
		compareInstants(issuedAt, expiresAt) >= 0 ||
		claims.agentId !== request.agentId ||
		claims.conversationId !== request.conversationId ||
		claims.executionId !== request.executionId ||
		claims.turnId !== request.turnId ||
		claims.sessionGeneration !== request.sessionGeneration ||
		!claims.operations.includes(requiredOperation) ||
		attachments.some((attachmentId) => !allowedAttachments.has(attachmentId))
	) {
		authorizationDenied();
	}

	return claims;
}
