import { describe, expect, it } from "vitest";
import {
	createSnapshot,
	fromDirectorySnapshotV1,
	requireCurrentSnapshot,
	resolveActiveMemberByEmail,
	toDirectorySnapshotV1,
} from "./index.js";

const now = Date.UTC(2026, 8, 28, 0, 0, 0);
const snapshot = () =>
	createSnapshot({
		rootDepartmentId: 1,
		startedAt: now,
		completedAt: now,
		departments: [
			{ id: 1, name: "Company", parentId: 0 },
			{ id: 2, name: "Engineering", parentId: 1 },
		],
		members: [
			{
				userId: "wecom-a",
				email: "A@example.test",
				active: true,
				departmentIds: [2],
			},
			{
				userId: "wecom-b",
				email: "b@example.test",
				active: false,
				departmentIds: [2],
			},
		],
	});

describe("directory snapshot", () => {
	it("maps wire data into an independent domain snapshot", () => {
		const original = snapshot();
		const mapped = fromDirectorySnapshotV1(toDirectorySnapshotV1(original));
		expect(mapped).toEqual(original);
		const mappedMember = mapped.members[0];
		const originalMember = original.members[0];
		if (!mappedMember || !originalMember) throw new Error("member missing");
		mappedMember.email = "changed@example.test";
		expect(originalMember.email).toBe("A@example.test");
		expect(() =>
			createSnapshot({
				rootDepartmentId: 1,
				startedAt: now,
				completedAt: now,
				departments: [{ id: 1, name: "   ", parentId: 0 }],
				members: [],
			}),
		).toThrow();
	});

	it("resolves only one active member with a trusted email", () => {
		const current = requireCurrentSnapshot(snapshot(), now);
		expect(
			resolveActiveMemberByEmail(current, "a@EXAMPLE.test", now)?.userId,
		).toBe("wecom-a");
		expect(
			resolveActiveMemberByEmail(current, "b@example.test", now),
		).toBeNull();
		expect(
			resolveActiveMemberByEmail(current, "missing@example.test", now),
		).toBeNull();
		expect(resolveActiveMemberByEmail(current, "", now)).toBeNull();
		current.members.push({
			userId: "wecom-c",
			email: "a@example.test",
			active: true,
			departmentIds: [2],
		});
		expect(
			resolveActiveMemberByEmail(current, "a@example.test", now),
		).toBeNull();
	});

	it("rejects expired, future, incomplete and overlong snapshots", () => {
		const value = snapshot();
		const slow = createSnapshot({
			rootDepartmentId: 1,
			startedAt: now,
			completedAt: now + 60 * 60_000,
			departments: value.departments,
			members: value.members,
		});
		expect(slow.validUntil).toBe(now + 24 * 60 * 60_000);
		expect(() =>
			createSnapshot({
				rootDepartmentId: 1,
				startedAt: now,
				completedAt: now + 24 * 60 * 60_000,
				departments: value.departments,
				members: value.members,
			}),
		).toThrow();
		expect(() => requireCurrentSnapshot(value, value.validUntil)).toThrow();
		expect(() =>
			resolveActiveMemberByEmail(value, "a@example.test", value.validUntil),
		).toThrow();
		expect(() => requireCurrentSnapshot(value, now - 1)).toThrow();
		expect(() =>
			fromDirectorySnapshotV1({ ...value, complete: false }),
		).toThrow();
		expect(() =>
			fromDirectorySnapshotV1({
				...value,
				validUntil: value.validUntil + 1,
			}),
		).toThrow();
	});

	it("rejects missing and cyclic departments, duplicate members and unknown membership", () => {
		const value = snapshot();
		expect(() =>
			fromDirectorySnapshotV1({
				...value,
				departments: value.departments.slice(1),
			}),
		).toThrow();
		expect(() =>
			fromDirectorySnapshotV1({
				...value,
				departments: [
					value.departments[0],
					{ id: 2, name: "Engineering", parentId: 2 },
				],
			}),
		).toThrow();
		expect(() =>
			fromDirectorySnapshotV1({
				...value,
				members: [...value.members, value.members[0]],
			}),
		).toThrow();
		expect(() =>
			fromDirectorySnapshotV1({
				...value,
				members: [{ ...value.members[0], departmentIds: [3] }],
			}),
		).toThrow();
	});
});
