import { randomUUID } from "node:crypto";
import { z } from "zod";

export const MAX_SNAPSHOT_AGE_MS = 24 * 60 * 60 * 1_000;

const departmentSchema = z.strictObject({
	id: z.number().int().positive(),
	name: z.string().trim().min(1),
	parentId: z.number().int().nonnegative(),
});

const memberSchema = z.strictObject({
	userId: z.string().trim().min(1),
	email: z.string(),
	active: z.boolean(),
	departmentIds: z.array(z.number().int().positive()).min(1),
});

const snapshotSchema = z.strictObject({
	schemaVersion: z.literal(1),
	revision: z.uuid(),
	source: z.literal("wecom"),
	rootDepartmentId: z.number().int().positive(),
	fetchedAt: z.number().int().nonnegative(),
	validUntil: z.number().int().positive(),
	complete: z.literal(true),
	departments: z.array(departmentSchema).min(1),
	members: z.array(memberSchema),
});

export type DirectorySnapshot = z.infer<typeof snapshotSchema>;
export type DirectoryDepartment = DirectorySnapshot["departments"][number];
export type DirectoryMember = DirectorySnapshot["members"][number];

export class DirectoryUnavailableError extends Error {
	constructor() {
		super("Enterprise directory snapshot is unavailable");
	}
}

function normalizeEmail(email: string) {
	return email.trim().toLowerCase();
}

export function validateSnapshot(value: unknown): DirectorySnapshot {
	const snapshot = snapshotSchema.parse(value);
	if (
		snapshot.validUntil <= snapshot.fetchedAt ||
		snapshot.validUntil > snapshot.fetchedAt + MAX_SNAPSHOT_AGE_MS
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
			department.id === snapshot.rootDepartmentId
				? department.parentId !== 0
				: !departments.has(department.parentId)
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
	value: unknown,
	now = Date.now(),
): DirectorySnapshot {
	try {
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
