import { createHash } from "node:crypto";
import {
	type DirectorySnapshot,
	displayNameForDirectoryMember,
	resolveActiveMemberByEmail,
} from "@agent-infra/enterprise-directory";
import type { EmployeeAccount } from "./employee-identity.js";
export function resolveDirectoryEmployeeAccount(input: {
	userId: string;
	uid: string;
	record: { issuer: string | null; subject: string | null; employeeId: string };
	snapshot: DirectorySnapshot;
	isAdministrator: boolean;
}): EmployeeAccount | null {
	const { userId, uid, record, snapshot, isAdministrator } = input;
	const [source, employeeId] = JSON.parse(record.employeeId) as [
		string,
		string,
	];
	if (snapshot.source !== source)
		throw new Error("OIDC_DIRECTORY_SOURCE_MISMATCH");
	const member = snapshot.members.find((value) => value.userId === employeeId);
	if (!member) return null;
	if (
		member.active &&
		resolveActiveMemberByEmail(snapshot, member.email)?.userId !== employeeId
	)
		throw new Error("OIDC_EMPLOYEE_EMAIL_AMBIGUOUS");
	const roles = isAdministrator
		? (["employee", "system_admin"] as const)
		: (["employee"] as const);
	return {
		uid,
		userId,
		email: member.email,
		displayName: displayNameForDirectoryMember(member),
		accountStatus: member.active ? "active" : "disabled",
		roles,
		authorizationRevision: createHash("sha256")
			.update(
				JSON.stringify([
					record.issuer,
					record.subject,
					record.employeeId,
					member.email,
					member.active,
					roles,
				]),
			)
			.digest("hex"),
	};
}

/** Both the OIDC callback and the authenticated channel derive this key from the directory. */
export function directoryEmployeeKey(source: string, employeeId: string) {
	return JSON.stringify([source, employeeId]);
}
