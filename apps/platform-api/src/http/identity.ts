import { Buffer } from "node:buffer";
import { types } from "node:util";

import { BrowserUserProjectionV1Schema } from "@agent-infra/contracts/pilot";
import { resolveCurrentTaskUserV1 } from "@agent-infra/identity";
import type {
	ApiCredentialMetadataV1,
	ApiCredentialScopeV1,
	ApiPrincipalV1,
	CurrentApiPrincipalV1,
	CurrentTaskUserV1,
	TaskUserDirectoryV1,
} from "@agent-infra/platform-core";

import { HttpProtocolError } from "./common";

export interface IdentityContext {
	readonly schemaVersion: 1;
	readonly userId: string;
	readonly displayName: string;
	readonly accountStatus: "active";
	readonly organizationIds: readonly string[];
	readonly roles: readonly ("employee" | "system_admin")[];
	readonly authorizationRevision: string;
	/** Present when the request was authenticated with an API credential. */
	readonly principal?: ApiPrincipalV1;
}

export interface IdentityAdapter {
	resolve(request: Request): Promise<unknown | null>;
	hydrateUsers(userIds: readonly string[]): Promise<unknown>;
	/** Resolve a bearer credential and current subject facts without returning the secret. */
	resolveApiCredential?: (
		credential: string,
		request: Request,
	) => Promise<unknown | null>;
	/** Current task facts must come from the directory, never a saved browser Request. */
	resolveUser?: TaskUserDirectoryV1["resolveUser"];
}

export interface ApiIdentityContext extends CurrentApiPrincipalV1 {
	readonly ownerId: string;
	readonly credential: ApiCredentialMetadataV1;
}

function parseApiIdentity(value: unknown): ApiIdentityContext {
	const input = record(value, [
		"schemaVersion",
		"principal",
		"accountStatus",
		"organizationIds",
		"authorizationRevision",
		"ownerId",
		"credential",
	]);
	if (
		input.schemaVersion !== 1 ||
		(input.accountStatus !== "active" && input.accountStatus !== "disabled") ||
		!text(input.authorizationRevision) ||
		!text(input.ownerId)
	) {
		throw new Error();
	}
	const principalValue = record(input.principal, ["kind", "id"]);
	if (
		(principalValue.kind !== "user" && principalValue.kind !== "application") ||
		!text(principalValue.id)
	) {
		throw new Error();
	}
	if (principalValue.kind === "user" && principalValue.id !== input.ownerId) {
		throw new Error();
	}
	const organizationIds = stringArray(input.organizationIds);
	const credentialValue = record(input.credential, [
		"schemaVersion",
		"credentialId",
		"principal",
		"scopes",
		"expiresAt",
		"revokedAt",
		"createdAt",
	]);
	const date = (value: unknown): Date | null => {
		if (value === null) return null;
		try {
			const milliseconds = Date.prototype.getTime.call(value);
			if (!Number.isFinite(milliseconds)) throw new Error();
			return new Date(milliseconds);
		} catch {
			if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
				throw new Error();
			return new Date(value);
		}
	};
	const expiresAt = date(credentialValue.expiresAt);
	const revokedAt = date(credentialValue.revokedAt);
	const createdAt = date(credentialValue.createdAt);
	if (
		credentialValue.schemaVersion !== 1 ||
		!text(credentialValue.credentialId) ||
		!Array.isArray(credentialValue.scopes) ||
		credentialValue.scopes.length === 0 ||
		new Set(credentialValue.scopes).size !== credentialValue.scopes.length ||
		credentialValue.scopes.some(
			(scope) =>
				scope !== "agent:create" &&
				scope !== "agent:manage" &&
				scope !== "agent:use" &&
				scope !== "agent:read",
		) ||
		(expiresAt === null && credentialValue.expiresAt !== null) ||
		(revokedAt === null && credentialValue.revokedAt !== null) ||
		createdAt === null
	) {
		throw new Error();
	}
	const credentialPrincipal = record(credentialValue.principal, ["kind", "id"]);
	if (
		credentialPrincipal.kind !== principalValue.kind ||
		credentialPrincipal.id !== principalValue.id
	) {
		throw new Error();
	}
	const principal: ApiPrincipalV1 = {
		kind: principalValue.kind,
		id: principalValue.id,
	};
	const credential: ApiCredentialMetadataV1 = {
		schemaVersion: 1,
		credentialId: credentialValue.credentialId,
		principal,
		scopes: credentialValue.scopes as ApiCredentialScopeV1[],
		expiresAt,
		revokedAt,
		createdAt,
	};
	return {
		schemaVersion: 1,
		principal,
		accountStatus: input.accountStatus,
		organizationIds,
		authorizationRevision: input.authorizationRevision,
		ownerId: input.ownerId,
		credential,
	};
}

export async function resolveApiIdentity(
	adapter: IdentityAdapter | undefined,
	request: Request,
	traceId: string,
): Promise<ApiIdentityContext> {
	const authorization = request.headers.get("authorization");
	if (
		!adapter?.resolveApiCredential ||
		!authorization ||
		!/^Bearer [^\s]+$/.test(authorization)
	) {
		throw new HttpProtocolError("AUTHENTICATION_REQUIRED", traceId);
	}
	const credential = authorization.slice("Bearer ".length);
	let value: unknown | null;
	try {
		value = await adapter.resolveApiCredential(credential, request);
	} catch {
		throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
	}
	if (value === null)
		throw new HttpProtocolError("AUTHENTICATION_REQUIRED", traceId);
	let identity: ApiIdentityContext;
	try {
		identity = parseApiIdentity(value);
	} catch {
		throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
	}
	if (
		identity.accountStatus !== "active" ||
		identity.credential.revokedAt !== null ||
		(identity.credential.expiresAt !== null &&
			identity.credential.expiresAt.getTime() <= Date.now())
	) {
		throw new HttpProtocolError("AUTHORIZATION_REVOKED", traceId);
	}
	return identity;
}

export async function resolveCurrentTaskUser(
	adapter: IdentityAdapter | undefined,
	userId: string,
	traceId: string,
): Promise<CurrentTaskUserV1 | null> {
	try {
		const resolveUser = adapter?.resolveUser;
		return await resolveCurrentTaskUserV1(
			resolveUser
				? { resolveUser: (id) => resolveUser.call(adapter, id) }
				: undefined,
			userId,
		);
	} catch {
		throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
	}
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

function denseArray(value: unknown, maximum: number): unknown[] {
	if (!Array.isArray(value) || types.isProxy(value) || value.length > maximum) {
		throw new Error();
	}
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (
		Reflect.ownKeys(descriptors).length !== value.length + 1 ||
		Object.getOwnPropertyDescriptor(value, "length")?.value !== value.length
	) {
		throw new Error();
	}
	const values: unknown[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const descriptor = descriptors[String(index)];
		if (
			descriptor?.enumerable !== true ||
			!Object.hasOwn(descriptor, "value") ||
			Object.hasOwn(descriptor, "get") ||
			Object.hasOwn(descriptor, "set")
		) {
			throw new Error();
		}
		values.push(descriptor.value);
	}
	return values;
}

function stringArray(value: unknown): readonly string[] {
	const values = denseArray(value, 256).map((item) => {
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
	return {
		...identity,
		accountStatus: "active",
	};
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
	let items: unknown[];
	try {
		items = denseArray(value, 256);
	} catch {
		throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
	}
	const parsed = items.map((item) => {
		try {
			const user = record(item, ["userId", "displayName", "roles"]);
			return BrowserUserProjectionV1Schema.safeParse({
				...user,
				roles: stringArray(user.roles),
			});
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
