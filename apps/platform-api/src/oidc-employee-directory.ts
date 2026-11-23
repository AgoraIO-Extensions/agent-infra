import { createHash } from "node:crypto";
import {
	type DirectorySnapshotLoaderV1,
	requireCurrentSnapshot,
	resolveActiveMemberByEmail,
} from "@agent-infra/enterprise-directory";
import {
	directoryEmployeeKey,
	type LdapAccount,
	resolveDirectoryEmployeeAccount,
} from "@agent-infra/identity";
import type { PostgresOidcIdentityStore } from "@agent-infra/platform-store";
import type { OidcBrowserIdentity } from "./oidc-browser-flow.js";

export interface EmployeeOidcConfiguration {
	issuer: string;
	clientId: string;
	clientSecret: string;
	allowEmailLink: boolean;
	administratorUserIds?: readonly string[];
}

export function createOidcEmployeeDirectory(
	config: EmployeeOidcConfiguration,
	store: Pick<
		PostgresOidcIdentityStore,
		"findBySubject" | "findByUserId" | "bind"
	>,
	directory: DirectorySnapshotLoaderV1,
) {
	const admins = config.administratorUserIds ?? [];
	if (
		!Array.isArray(admins) ||
		admins.some(
			(id) =>
				typeof id !== "string" ||
				!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(id),
		) ||
		typeof config.allowEmailLink !== "boolean"
	)
		throw new Error("OIDC_EMPLOYEE_CONFIGURATION_INVALID");
	const administrators = new Set(admins);
	const prefix =
		"oidc:" + createHash("sha256").update(config.issuer).digest("hex") + ":";
	async function currentByUserId(userId: string): Promise<LdapAccount | null> {
		const record = await store.findByUserId(userId);
		if (!record) throw new Error("OIDC_EMPLOYEE_BINDING_UNAVAILABLE");
		return resolveDirectoryEmployeeAccount({
			userId,
			uid: prefix + userId,
			record,
			snapshot: requireCurrentSnapshot(await directory.loadCurrent()),
			isAdministrator: administrators.has(userId),
		});
	}
	async function userIdForUid(uid: string) {
		if (!uid.startsWith(prefix)) return null;
		const userId = uid.slice(prefix.length);
		const record = await store.findByUserId(userId);
		if (record?.issuer !== config.issuer || !record.subject) return null;
		return userId;
	}
	async function verifiedAccount(identity: OidcBrowserIdentity) {
		if (identity.issuer !== config.issuer) return null;
		let record = await store.findBySubject(identity.issuer, identity.subject);
		if (!record) {
			if (!config.allowEmailLink || !identity.emailVerified || !identity.email)
				return null;
			const snapshot = requireCurrentSnapshot(
				await directory.loadCurrent(),
				Date.now(),
			);
			const member = resolveActiveMemberByEmail(snapshot, identity.email);
			if (!member) return null;
			await store.bind({
				issuer: identity.issuer,
				subject: identity.subject,
				email: member.email,
				employeeId: directoryEmployeeKey(snapshot.source, member.userId),
			});
			record = await store.findBySubject(identity.issuer, identity.subject);
		}
		return record ? currentByUserId(record.userId) : null;
	}
	return {
		currentByUserId,
		userIdForUid,
		current: async (uid: string) => {
			const id = await userIdForUid(uid);
			return id ? currentByUserId(id) : null;
		},
		verifiedAccount,
		authenticate: async () => null,
	};
}
