import { EnterpriseDirectorySnapshotV1Schema } from "@agent-infra/contracts/enterprise-directory";
import { type DirectorySnapshot, validateSnapshot } from "./snapshot.js";

export function fromDirectorySnapshotV1(value: unknown): DirectorySnapshot {
	const dto = EnterpriseDirectorySnapshotV1Schema.parse(value);
	return validateSnapshot({
		schemaVersion: dto.schemaVersion,
		revision: dto.revision,
		source: dto.source,
		rootDepartmentId: dto.rootDepartmentId,
		fetchedAt: dto.fetchedAt,
		validUntil: dto.validUntil,
		complete: dto.complete,
		departments: dto.departments.map(({ id, name, parentId }) => ({
			id,
			name,
			parentId,
		})),
		members: dto.members.map(({ userId, email, active, departmentIds }) => ({
			userId,
			email,
			active,
			departmentIds: [...departmentIds],
		})),
	});
}

export function toDirectorySnapshotV1(value: DirectorySnapshot) {
	const snapshot = validateSnapshot(value);
	return EnterpriseDirectorySnapshotV1Schema.parse({
		schemaVersion: snapshot.schemaVersion,
		revision: snapshot.revision,
		source: snapshot.source,
		rootDepartmentId: snapshot.rootDepartmentId,
		fetchedAt: snapshot.fetchedAt,
		validUntil: snapshot.validUntil,
		complete: snapshot.complete,
		departments: snapshot.departments.map(({ id, name, parentId }) => ({
			id,
			name,
			parentId,
		})),
		members: snapshot.members.map(
			({ userId, email, active, departmentIds }) => ({
				userId,
				email,
				active,
				departmentIds: [...departmentIds],
			}),
		),
	});
}
