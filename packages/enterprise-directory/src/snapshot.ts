import { randomUUID } from "node:crypto";
import { z } from "zod";

export const MAX_SNAPSHOT_AGE_MS = 24 * 60 * 60 * 1_000;

export interface DirectoryDepartment {
	id: number;
	name: string;
	parentId: number;
}

export interface DirectoryMember {
	userId: string;
	email: string;
	active: boolean;
	departmentIds: number[];
}

export interface DirectorySnapshot {
	schemaVersion: 1;
	revision: string;
	source: "wecom";
	rootDepartmentId: number;
	fetchedAt: number;
	validUntil: number;
	complete: true;
	departments: DirectoryDepartment[];
	members: DirectoryMember[];
}

export class DirectoryUnavailableError extends Error {
	constructor() {
		super("Enterprise directory snapshot is unavailable");
	}
}

function normalizeEmail(email: string) {
	return email.trim().toLowerCase();
}

export function validateSnapshot(
	snapshot: DirectorySnapshot,
): DirectorySnapshot {
	if (
		snapshot.schemaVersion !== 1 ||
		snapshot.source !== "wecom" ||
		snapshot.complete !== true ||
		!Number.isSafeInteger(snapshot.rootDepartmentId) ||
		snapshot.rootDepartmentId < 1 ||
		!Number.isSafeInteger(snapshot.fetchedAt) ||
		snapshot.fetchedAt < 0 ||
		!Number.isSafeInteger(snapshot.validUntil) ||
		snapshot.validUntil <= snapshot.fetchedAt ||
		snapshot.validUntil > snapshot.fetchedAt + MAX_SNAPSHOT_AGE_MS ||
		snapshot.departments.length === 0
	) {
		throw new DirectoryUnavailableError();
	}
	const departments = new Map(
		snapshot.departments.map((item) => [item.id, item]),
	);
	if (
		departments.size !== snapshot.departments.length ||
		!departments.has(snapshot.rootDepartmentId)
	) {
		throw new DirectoryUnavailableError();
	}
	for (const department of snapshot.departments) {
		if (
			!Number.isSafeInteger(department.id) ||
			department.id < 1 ||
			!Number.isSafeInteger(department.parentId) ||
			department.parentId < 0 ||
			!department.name.trim() ||
			(department.id === snapshot.rootDepartmentId
				? department.parentId !== 0
				: !departments.has(department.parentId))
		) {
			throw new DirectoryUnavailableError();
		}
		const visited = new Set<number>([department.id]);
		let current = department;
		while (current.id !== snapshot.rootDepartmentId) {
			if (visited.has(current.parentId)) throw new DirectoryUnavailableError();
			visited.add(current.parentId);
			const parent = departments.get(current.parentId);
			if (!parent) throw new DirectoryUnavailableError();
			current = parent;
		}
	}
	const memberIds = new Set<string>();
	for (const member of snapshot.members) {
		if (
			!member.userId.trim() ||
			typeof member.email !== "string" ||
			typeof member.active !== "boolean" ||
			member.departmentIds.length === 0 ||
			member.departmentIds.some((id) => !Number.isSafeInteger(id) || id < 1)
		)
			throw new DirectoryUnavailableError();
		if (memberIds.has(member.userId)) throw new DirectoryUnavailableError();
		memberIds.add(member.userId);
		if (
			new Set(member.departmentIds).size !== member.departmentIds.length ||
			member.departmentIds.some((id) => !departments.has(id))
		) {
			throw new DirectoryUnavailableError();
		}
	}
	return snapshot;
}

export function createSnapshot(input: {
	rootDepartmentId: number;
	departments: DirectoryDepartment[];
	members: DirectoryMember[];
	startedAt: number;
	completedAt: number;
}): DirectorySnapshot {
	return validateSnapshot({
		schemaVersion: 1,
		revision: randomUUID(),
		source: "wecom",
		rootDepartmentId: input.rootDepartmentId,
		fetchedAt: input.completedAt,
		validUntil: input.startedAt + MAX_SNAPSHOT_AGE_MS,
		complete: true,
		departments: input.departments,
		members: input.members,
	});
}

export function requireCurrentSnapshot(
	value: DirectorySnapshot | null,
	now = Date.now(),
): DirectorySnapshot {
	try {
		if (!value) throw new DirectoryUnavailableError();
		const snapshot = validateSnapshot(value);
		if (snapshot.fetchedAt > now || snapshot.validUntil <= now) {
			throw new DirectoryUnavailableError();
		}
		return snapshot;
	} catch {
		throw new DirectoryUnavailableError();
	}
}

export function resolveActiveMemberByEmail(
	snapshot: DirectorySnapshot,
	trustedLdapEmail: string,
	now = Date.now(),
): DirectoryMember | null {
	requireCurrentSnapshot(snapshot, now);
	const email = normalizeEmail(trustedLdapEmail);
	if (!email || !z.email().safeParse(email).success) return null;
	const matches = snapshot.members.filter(
		(member) => normalizeEmail(member.email) === email,
	);
	return matches.length === 1 && matches[0]?.active ? matches[0] : null;
}
