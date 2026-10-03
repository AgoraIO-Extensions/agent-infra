import { createHash } from "node:crypto";
import type {
	AgentConfigurationAuthorityContextV1,
	CurrentTaskUserV1,
} from "../../../packages/platform-core/src/index.ts";

type Role = "employee" | "system_admin";
export interface AuthentikDirectoryConfiguration {
	readonly origin: string;
	readonly issuer: string;
	readonly instanceNamespace: string;
	readonly apiToken: string;
	readonly roleGroups: Readonly<Record<Role, readonly string[]>>;
	readonly organizationGroups: readonly {
		readonly groupId: string;
		readonly organizationId: string;
	}[];
	readonly timeoutMs?: number;
}

interface DirectoryUser {
	pk: number;
	uid: string;
	name: string;
	active: boolean;
	groups: string[];
}

function unavailable(): never {
	throw new Error("AUTHENTIK_DIRECTORY_UNAVAILABLE");
}
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		unavailable();
	return value as Record<string, unknown>;
}
function text(value: unknown): string {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value.length > 1024 ||
		!value.isWellFormed() ||
		Array.from(value).some(
			(character) =>
				character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
		)
	)
		unavailable();
	return value;
}
function uuid(value: unknown): string {
	const result = text(value);
	if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(result))
		unavailable();
	return result;
}
function integer(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		unavailable();
	return value;
}
function pageLink(
	value: unknown,
	origin: string,
	resource: "users" | "groups",
): number {
	if (value === null) return 0;
	if (typeof value === "number") return integer(value);
	const link = new URL(text(value));
	const configured = new URL(origin);
	if (
		link.origin !== configured.origin ||
		link.pathname !== `/api/v3/core/${resource}/` ||
		link.username ||
		link.password ||
		link.hash
	)
		unavailable();
	const page = link.searchParams.get("page");
	if (!page || !/^[1-9][0-9]*$/u.test(page)) unavailable();
	return integer(Number(page));
}
function unique(values: string[]): string[] {
	if (new Set(values).size !== values.length) unavailable();
	return values.sort();
}
function hash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function parseUser(value: unknown): DirectoryUser {
	const user = record(value);
	if (typeof user.is_active !== "boolean" || !Array.isArray(user.groups))
		unavailable();
	const pk = integer(user.pk);
	if (pk === 0) unavailable();
	return {
		pk,
		uid: text(user.uid),
		name: text(user.name || user.username),
		active: user.is_active,
		groups: unique(user.groups.map(uuid)),
	};
}

/** Deployment-only REST directory, not a login verifier or a second user database.
 * Authentik UserSerializer exposes numeric pk, opaque uid, and direct group UUIDs.
 * Explicit mappings use direct membership; inherited/superuser privileges never grant Platform roles.
 * See https://github.com/goauthentik/authentik/blob/main/authentik/core/api/users.py
 * and https://github.com/goauthentik/authentik/blob/main/authentik/api/pagination.py.
 */
export function createAuthentikDirectory(
	configuration: AuthentikDirectoryConfiguration,
	fetchImpl: typeof fetch = fetch,
) {
	// Copy trusted configuration so later caller mutation cannot change authority.
	let config: AuthentikDirectoryConfiguration;
	try {
		config = structuredClone(configuration);
		const origin = new URL(config.origin);
		const issuer = new URL(config.issuer);
		if (
			origin.protocol !== "https:" ||
			origin.origin !== config.origin ||
			issuer.origin !== origin.origin ||
			issuer.username ||
			issuer.password ||
			issuer.search ||
			issuer.hash
		)
			unavailable();
		text(config.instanceNamespace);
		if (
			!/^[A-Za-z0-9._~-]+$/u.test(config.apiToken) ||
			config.apiToken.length < 16
		)
			unavailable();
		for (const role of ["employee", "system_admin"] as const)
			unique(config.roleGroups[role].map(uuid));
		unique(
			config.organizationGroups.map((mapping) => text(mapping.organizationId)),
		);
		unique(config.organizationGroups.map((mapping) => uuid(mapping.groupId)));
		const timeout = config.timeoutMs ?? 5000;
		if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30000)
			unavailable();
	} catch {
		unavailable();
	}
	const roleGroups = config.roleGroups;
	const mappings = config.organizationGroups;
	const requiredGroups = new Set([
		...roleGroups.employee,
		...roleGroups.system_admin,
		...mappings.map((item) => item.groupId),
	]);
	const userId = (user: DirectoryUser) =>
		`authentik_${hash([config.instanceNamespace, config.origin, user.pk, user.uid])}`;

	async function list(resource: "users" | "groups", signal: AbortSignal) {
		const results: Record<string, unknown>[] = [];
		let expectedCount: number | undefined;
		let expectedPages: number | undefined;
		for (let page = 1; page <= 100; page++) {
			const url = new URL(`/api/v3/core/${resource}/`, config.origin);
			url.searchParams.set("page", String(page));
			url.searchParams.set("page_size", "100");
			url.searchParams.set(
				"ordering",
				resource === "users" ? "username" : "name",
			);
			const response = await fetchImpl(url, {
				method: "GET",
				headers: {
					authorization: `Bearer ${config.apiToken}`,
					accept: "application/json",
				},
				redirect: "error",
				signal,
			});
			if (
				!response.ok ||
				response.redirected ||
				(response.url && response.url !== url.href)
			)
				unavailable();
			if (!response.body) unavailable();
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let size = 0;
			try {
				for (;;) {
					const chunk = await reader.read();
					if (chunk.done) break;
					size += chunk.value.byteLength;
					if (size > 2 * 1024 * 1024) {
						await reader.cancel();
						unavailable();
					}
					chunks.push(chunk.value);
				}
			} finally {
				reader.releaseLock();
			}
			const body = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			const pagination = record(body.pagination);
			const count = integer(pagination.count);
			const pages = integer(pagination.total_pages);
			if (
				count > 10000 ||
				pages < 1 ||
				pages > 100 ||
				integer(pagination.current) !== page ||
				pageLink(pagination.previous, config.origin, resource) !==
					(page === 1 ? 0 : page - 1) ||
				pageLink(pagination.next, config.origin, resource) !==
					(page === pages ? 0 : page + 1) ||
				(expectedCount !== undefined && count !== expectedCount) ||
				(expectedPages !== undefined && pages !== expectedPages) ||
				!Array.isArray(body.results) ||
				body.results.length > 100 ||
				(body.results.length === 0 && count !== 0)
			)
				unavailable();
			expectedCount = count;
			expectedPages = pages;
			results.push(...body.results.map(record));
			if (
				integer(pagination.start_index) !==
					(count === 0 ? 0 : results.length - body.results.length + 1) ||
				integer(pagination.end_index) !== results.length
			)
				unavailable();
			if (page === pages) {
				if (results.length !== count) unavailable();
				return results;
			}
		}
		return unavailable();
	}
	async function snapshot() {
		try {
			const signal = AbortSignal.timeout(config.timeoutMs ?? 5000);
			const groups = unique(
				(await list("groups", signal)).map((item) => uuid(item.pk)),
			);
			if ([...requiredGroups].some((id) => !groups.includes(id))) unavailable();
			const users = (await list("users", signal)).map(parseUser);
			unique(users.map((user) => String(user.pk)));
			unique(users.map((user) => user.uid));
			if (users.some((user) => user.groups.some((id) => !groups.includes(id))))
				unavailable();
			return users;
		} catch {
			return unavailable();
		}
	}
	function facts(user: DirectoryUser) {
		const roles = (["employee", "system_admin"] as const).filter(
			(role) =>
				user.active && roleGroups[role].some((id) => user.groups.includes(id)),
		);
		const organizationIds = mappings
			.filter((item) => user.active && user.groups.includes(item.groupId))
			.map((item) => item.organizationId)
			.sort();
		const accountStatus =
			user.active && roles.length > 0
				? ("active" as const)
				: ("disabled" as const);
		const current: CurrentTaskUserV1 = {
			schemaVersion: 1,
			userId: userId(user),
			accountStatus,
			organizationIds,
			authorizationRevision: hash([
				userId(user),
				user.active,
				user.groups,
				roles,
				organizationIds,
			]),
		};
		return { current, displayName: user.name, roles };
	}
	function identity(user: DirectoryUser | undefined) {
		if (!user) return null;
		const value = facts(user);
		if (value.current.accountStatus !== "active") return null;
		return {
			...value.current,
			accountStatus: "active" as const,
			displayName: value.displayName,
			roles: value.roles,
		};
	}
	return {
		async resolveUser(id: string): Promise<CurrentTaskUserV1 | null> {
			text(id);
			const user = (await snapshot()).find((item) => userId(item) === id);
			return user ? facts(user).current : null;
		},
		async resolveIdentity(id: string) {
			text(id);
			return identity((await snapshot()).find((user) => userId(user) === id));
		},
		/** Only call after validating the ID token, including issuer/audience/nonce.
		 * The provider must use sub_mode=hashed_user_id (the user's uid, not REST pk).
		 */
		async resolveVerifiedSubject(subject: { issuer: string; subject: string }) {
			if (subject.issuer !== config.issuer) return null;
			text(subject.subject);
			return identity(
				(await snapshot()).find((user) => user.uid === subject.subject),
			);
		},
		async hydrateUsers(ids: readonly string[]) {
			if (ids.length > 256) unavailable();
			unique(ids.map(text));
			if (ids.length === 0) return [];
			const users = await snapshot();
			return ids.map((id) => {
				const user = users.find((item) => userId(item) === id);
				if (!user) unavailable();
				const value = facts(user);
				return {
					userId: id,
					displayName: value.displayName,
					roles: value.roles,
				};
			});
		},
		async loadAuthorityContext(): Promise<AgentConfigurationAuthorityContextV1> {
			const users = await snapshot();
			return {
				schemaVersion: 1,
				users: users.map((user) => {
					const current = facts(user).current;
					return {
						userId: current.userId,
						accountStatus: current.accountStatus,
					};
				}),
				organizationIds: mappings
					.map((mapping) => mapping.organizationId)
					.sort(),
			};
		},
	};
}
