import { Buffer } from "node:buffer";
import { types } from "node:util";

import { BrowserUserProjectionV1Schema } from "@agent-infra/contracts/pilot";

import { HttpProtocolError } from "./common";

export interface IdentityContext {
	readonly schemaVersion: 1;
	readonly userId: string;
	readonly displayName: string;
	readonly accountStatus: "active";
	readonly organizationIds: readonly string[];
	readonly roles: readonly ("employee" | "system_admin")[];
	readonly authorizationRevision: string;
}

export interface IdentityAdapter {
	resolve(request: Request): Promise<unknown | null>;
	hydrateUsers(userIds: readonly string[]): Promise<unknown>;
}

export type BrowserUserProjection = ReturnType<
	typeof BrowserUserProjectionV1Schema.parse
>;
type ResolvedIdentity = Omit<IdentityContext, "accountStatus"> & {
	readonly accountStatus: "active" | "disabled";
};

function text(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!value.includes("\0") &&
		String.prototype.isWellFormed.call(value) &&
		Buffer.byteLength(value, "utf8") <= 1024
	);
}

function record(
	value: unknown,
	keys: readonly string[],
): Record<string, unknown> {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		types.isProxy(value)
	) {
		throw new Error();
	}
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (
		Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
		Object.keys(descriptors).length !== keys.length ||
		keys.some((key) => {
			const descriptor = descriptors[key];
			return (
				descriptor?.enumerable !== true ||
				!Object.hasOwn(descriptor, "value") ||
				Object.hasOwn(descriptor, "get") ||
				Object.hasOwn(descriptor, "set")
			);
		})
	) {
		throw new Error();
	}
	return Object.fromEntries(keys.map((key) => [key, descriptors[key]?.value]));
}

function stringArray(value: unknown): readonly string[] {
	if (
		!Array.isArray(value) ||
		types.isProxy(value) ||
		value.length > 256 ||
		Reflect.ownKeys(value).length !== value.length + 1
	) {
		throw new Error();
	}
	const values = value.map((item) => {
		if (!text(item)) throw new Error();
		return item;
	});
	if (new Set(values).size !== values.length) throw new Error();
	return values;
}

function parseIdentity(value: unknown): ResolvedIdentity {
	const identity = record(value, [
		"schemaVersion",
		"userId",
		"displayName",
		"accountStatus",
		"organizationIds",
		"roles",
		"authorizationRevision",
	]);
	if (
		identity.schemaVersion !== 1 ||
		!text(identity.userId) ||
		!text(identity.displayName) ||
		(identity.accountStatus !== "active" &&
			identity.accountStatus !== "disabled") ||
		!text(identity.authorizationRevision)
	) {
		throw new Error();
	}
	const roles = stringArray(identity.roles);
	if (
		roles.length === 0 ||
		roles.some((role) => role !== "employee" && role !== "system_admin")
	) {
		throw new Error();
	}
	return {
		schemaVersion: 1,
		userId: identity.userId,
		displayName: identity.displayName,
		accountStatus: identity.accountStatus,
		organizationIds: stringArray(identity.organizationIds),
		roles: roles as ("employee" | "system_admin")[],
		authorizationRevision: identity.authorizationRevision,
	};
}

export async function resolveIdentity(
	adapter: IdentityAdapter | undefined,
	request: Request,
	traceId: string,
): Promise<IdentityContext> {
	if (!adapter) throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
	let value: unknown | null;
	try {
		value = await adapter.resolve(request);
	} catch {
		throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
	}
	if (value === null) {
		throw new HttpProtocolError("AUTHENTICATION_REQUIRED", traceId);
	}
	let identity: ResolvedIdentity;
	try {
		identity = parseIdentity(value);
	} catch {
		throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
	}
	if (identity.accountStatus === "disabled") {
		throw new HttpProtocolError("AUTHORIZATION_REVOKED", traceId);
	}
	return { ...identity, accountStatus: "active" };
}

export async function hydrateBrowserUsers(
	adapter: IdentityAdapter,
	userIds: readonly string[],
	traceId: string,
): Promise<readonly BrowserUserProjection[]> {
	if (
		userIds.some((userId) => !text(userId)) ||
		new Set(userIds).size !== userIds.length
	) {
		throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
	}
	if (userIds.length === 0) return [];

	let value: unknown;
	try {
		value = await adapter.hydrateUsers(userIds);
	} catch {
		throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
	}
	if (
		!Array.isArray(value) ||
		types.isProxy(value) ||
		Reflect.ownKeys(value).length !== value.length + 1
	) {
		throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
	}
	const parsed = value.map((item) => {
		try {
			return BrowserUserProjectionV1Schema.safeParse(
				record(item, ["userId", "displayName", "roles"]),
			);
		} catch {
			return { success: false as const };
		}
	});
	if (parsed.some((item) => !item.success)) {
		throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
	}
	const users = parsed.map((item) => {
		if (!item.success) throw new Error();
		return item.data;
	});
	const byId = new Map(users.map((user) => [user.userId, user]));
	if (byId.size !== users.length || byId.size !== userIds.length) {
		throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
	}
	const ordered = userIds.map((userId) => byId.get(userId));
	if (ordered.some((user) => user === undefined)) {
		throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
	}
	return ordered as BrowserUserProjection[];
}
