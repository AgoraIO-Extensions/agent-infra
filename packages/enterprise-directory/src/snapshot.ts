import { randomUUID } from "node:crypto";
import { DirectorySourceIdSchema } from "@agent-infra/contracts/enterprise-directory";
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
	source: string;
	rootDepartmentId: number;
	fetchedAt: number;
	validUntil: number;
	complete: true;
	departments: DirectoryDepartment[];
	members: DirectoryMember[];
}

export interface DirectorySnapshotSummary {
	baselineRevision: string | null;
	departmentCount: number;
	memberCount: number;
	addedMembers: number | null;
	removedMembers: number | null;
	membershipChangedMembers: number | null;
	inactiveMembers: number;
	missingEmailMembers: number;
	invalidEmailMembers: number;
	duplicateEmailMembers: number;
	unmappableMembers: number;
}

export class DirectoryUnavailableError extends Error {
	constructor() {
		super("Enterprise directory snapshot is unavailable");
	}
}

function normalizeEmail(email: string) {
	return email.trim().toLowerCase();
}

export function summarizeSnapshotChange(
	snapshot: DirectorySnapshot,
	previous: DirectorySnapshot | null,
): DirectorySnapshotSummary {
	const previousMembers = previous
		? new Map(previous.members.map((member) => [member.userId, member]))
		: null;
	const currentIds = new Set(snapshot.members.map((member) => member.userId));
	const emailCounts = new Map<string, number>();
	for (const member of snapshot.members) {
		const email = normalizeEmail(member.email);
		if (email) emailCounts.set(email, (emailCounts.get(email) ?? 0) + 1);
	}
	let addedMembers = 0;
	let membershipChangedMembers = 0;
	let inactiveMembers = 0;
	let missingEmailMembers = 0;
	let invalidEmailMembers = 0;
	let duplicateEmailMembers = 0;
	let unmappableMembers = 0;
	for (const member of snapshot.members) {
		const old = previousMembers?.get(member.userId);
		if (previousMembers && !old) addedMembers += 1;
		if (
			old &&
			(old.departmentIds.length !== member.departmentIds.length ||
				member.departmentIds.some((id) => !old.departmentIds.includes(id)))
		)
			membershipChangedMembers += 1;
		const email = normalizeEmail(member.email);
		const missing = !email;
		const invalid = !missing && !z.email().safeParse(email).success;
		const duplicate = !missing && (emailCounts.get(email) ?? 0) > 1;
		if (!member.active) inactiveMembers += 1;
		if (missing) missingEmailMembers += 1;
		if (invalid) invalidEmailMembers += 1;
		if (duplicate) duplicateEmailMembers += 1;
		if (!member.active || missing || invalid || duplicate)
			unmappableMembers += 1;
	}
	return {
		baselineRevision: previous?.revision ?? null,
		departmentCount: snapshot.departments.length,
		memberCount: snapshot.members.length,
		addedMembers: previousMembers ? addedMembers : null,
		removedMembers: previousMembers
			? [...previousMembers.keys()].filter((id) => !currentIds.has(id)).length
			: null,
		membershipChangedMembers: previousMembers ? membershipChangedMembers : null,
		inactiveMembers,
		missingEmailMembers,
		invalidEmailMembers,
		duplicateEmailMembers,
		unmappableMembers,
	};
}

export function validateSnapshot(
	snapshot: DirectorySnapshot,
): DirectorySnapshot {
	if (
		snapshot.schemaVersion !== 1 ||
		!DirectorySourceIdSchema.safeParse(snapshot.source).success ||
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
	/** Defaults to the legacy source for existing callers. */
	source?: string;
	rootDepartmentId: number;
	departments: DirectoryDepartment[];
	members: DirectoryMember[];
	startedAt: number;
	completedAt: number;
}): DirectorySnapshot {
	return validateSnapshot({
		schemaVersion: 1,
		revision: randomUUID(),
		source: input.source ?? "wecom",
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
