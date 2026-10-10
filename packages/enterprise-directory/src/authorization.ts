import { DirectorySnapshotBindingV1Schema } from "@agent-infra/contracts/enterprise-directory";
import {
	type DirectoryDepartment,
	type DirectorySnapshot,
	DirectoryUnavailableError,
	requireCurrentSnapshot,
	resolveActiveMemberByEmail,
} from "./snapshot.js";

export interface DirectorySnapshotLoaderV1 {
	loadCurrent(now?: number): Promise<DirectorySnapshot>;
}

export interface DirectoryOrganizationAuthorityV1 {
	readonly schemaVersion: 1;
	readonly binding: {
		readonly schemaVersion: 1;
		readonly source: string;
		readonly revision: string;
		readonly fetchedAt: number;
		readonly validUntil: number;
	};
	readonly organizationIds: readonly string[];
}

export interface DirectoryOrganizationResolverOptionsV1 {
	readonly snapshot: DirectorySnapshotLoaderV1;
	/** Deployment-owned mapping; returning null rejects the whole authorization. */
	readonly organizationIdForDepartment: (
		department: DirectoryDepartment,
	) => string | null;
	readonly now?: () => number;
}

function validText(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 1024 &&
		!value.includes("\0") &&
		String.prototype.isWellFormed.call(value)
	);
}

/**
 * Resolve current Platform organization facts from one complete directory
 * snapshot. The snapshot is loaded for every call so an expired or unavailable
 * directory cannot silently extend an earlier authorization decision.
 */
export function createDirectoryOrganizationResolverV1(
	options: DirectoryOrganizationResolverOptionsV1,
) {
	if (
		!options.snapshot ||
		typeof options.snapshot.loadCurrent !== "function" ||
		typeof options.organizationIdForDepartment !== "function"
	)
		throw new DirectoryUnavailableError();
	const now = options.now ?? Date.now;
	return {
		async resolve(input: { readonly email: string }) {
			try {
				if (!validText(input?.email)) throw new DirectoryUnavailableError();
				const current = await options.snapshot.loadCurrent(now());
				const snapshot = requireCurrentSnapshot(current, now());
				const member = resolveActiveMemberByEmail(snapshot, input.email, now());
				if (!member) throw new DirectoryUnavailableError();
				const departments = new Map(
					snapshot.departments.map((department) => [department.id, department]),
				);
				const organizationIds = member.departmentIds.map((departmentId) => {
					const department = departments.get(departmentId);
					if (!department) throw new DirectoryUnavailableError();
					const organizationId =
						options.organizationIdForDepartment(department);
					if (!validText(organizationId)) throw new DirectoryUnavailableError();
					return organizationId;
				});
				if (
					organizationIds.length === 0 ||
					new Set(organizationIds).size !== organizationIds.length
				)
					throw new DirectoryUnavailableError();
				const binding = DirectorySnapshotBindingV1Schema.parse({
					schemaVersion: 1,
					source: snapshot.source,
					revision: snapshot.revision,
					fetchedAt: snapshot.fetchedAt,
					validUntil: snapshot.validUntil,
				});
				return {
					schemaVersion: 1 as const,
					binding,
					organizationIds: organizationIds.toSorted(),
				};
			} catch {
				throw new DirectoryUnavailableError();
			}
		},
	};
}
