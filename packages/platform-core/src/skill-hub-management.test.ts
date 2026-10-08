import { describe, expect, it } from "vitest";
import { createSkillHubVersionV1 } from "./skill-hub.js";
import {
	parseSkillHubIdentitySnapshotV1,
	parseSkillHubRegistrationV1,
	parseSkillHubReviewV1,
	requireSkillHubRegistrationParentV1,
	requireSkillHubReviewerV1,
	requireSkillHubVersionAccessV1,
} from "./skill-hub-management.js";

const registration = {
	schemaVersion: 1,
	name: "summary",
	skillId: "skill-a",
	skillVersionId: "version-a",
	visibility: "PRIVATE",
	provider: "my_library",
	version: "1.0.0",
	packageObjectVersion: "object-a",
	packageDigest: "a".repeat(64),
	manifestDigest: "b".repeat(64),
	signatureDigest: "c".repeat(64),
} as const;
const actor = {
	schemaVersion: 1,
	userId: "owner-a",
	accountStatus: "active",
	organizationIds: ["org-a"],
	isAdministrator: false,
} as const;
const version = createSkillHubVersionV1({
	...registration,
	ownerId: actor.userId,
});

describe("Skill Hub management boundary", () => {
	it.each([
		"https://opaque.example/version",
		"  opaque/s3+version  ",
		"é".repeat(512),
	])("preserves an opaque S3 VersionId exactly", (packageObjectVersion) => {
		expect(
			parseSkillHubRegistrationV1({ ...registration, packageObjectVersion })
				.packageObjectVersion,
		).toBe(packageObjectVersion);
	});
	it.each(["", "null", "é".repeat(513), "\ud800"])(
		"rejects invalid S3 version bytes",
		(packageObjectVersion) => {
			expect(() =>
				parseSkillHubRegistrationV1({ ...registration, packageObjectVersion }),
			).toThrow();
		},
	);
	it("accepts opaque object versions but rejects null", () => {
		const opaque = {
			...registration,
			packageObjectVersion: "opaque/s3+version",
		};
		expect(parseSkillHubRegistrationV1(opaque).packageObjectVersion).toBe(
			"opaque/s3+version",
		);
		expect(() =>
			parseSkillHubRegistrationV1({
				...registration,
				packageObjectVersion: "null",
			}),
		).toThrowError();
	});
	it("receives the same immutable version reference without promoting package admission", () => {
		expect(parseSkillHubRegistrationV1(registration)).toEqual(registration);
		expect(Object.isFrozen(parseSkillHubRegistrationV1(registration))).toBe(
			true,
		);
	});
	it.each([
		"ownerId",
		"userId",
		"isAdministrator",
		"grant",
		"path",
		"url",
		"verified",
	])("rejects caller %s fields", (field) => {
		expect(() =>
			parseSkillHubRegistrationV1({
				...registration,
				[field]: "foreign-input",
			}),
		).toThrowError(expect.objectContaining({ code: "invalid_input" }));
	});
	it.each([
		{ signatureDigest: "not-a-digest" },
		{ name: "../escape" },
		{ version: "latest/remote" },
		{ provider: "unregistered" },
	])("rejects malformed publication references %j", (replacement) => {
		expect(() =>
			parseSkillHubRegistrationV1({ ...registration, ...replacement }),
		).toThrowError(expect.objectContaining({ code: "invalid_input" }));
	});
	it("does not invoke accessors while snapshotting package references", () => {
		let called = false;
		const input = { ...registration };
		Object.defineProperty(input, "packageDigest", {
			enumerable: true,
			get() {
				called = true;
				return registration.packageDigest;
			},
		});
		expect(() => parseSkillHubRegistrationV1(input)).toThrow();
		expect(called).toBe(false);
	});
	it("freezes the current actor separately from the supplied identity payload", () => {
		const source = {
			actor: { ...actor, organizationIds: ["org-a"] },
			authorizationRevision: "identity-1",
		};
		const snapshot = parseSkillHubIdentitySnapshotV1(source, actor.userId);
		source.actor.organizationIds.push("org-b");
		expect(snapshot.actor.organizationIds).toEqual(["org-a"]);
		expect(Object.isFrozen(snapshot.actor.organizationIds)).toBe(true);
	});
	it.each([
		{
			actor: { ...actor, userId: "foreign" },
			authorizationRevision: "identity-1",
		},
		{ actor, authorizationRevision: "" },
		{
			actor: { ...actor, role: "system_admin" },
			authorizationRevision: "identity-1",
		},
	])("rejects identity scope mismatch or shape drift", (source) => {
		expect(() =>
			parseSkillHubIdentitySnapshotV1(source, actor.userId),
		).toThrowError(expect.objectContaining({ code: "unavailable" }));
	});
	it("denies inactive identity, non-admin review and foreign metadata access", () => {
		expect(() =>
			parseSkillHubIdentitySnapshotV1(
				{
					actor: { ...actor, accountStatus: "disabled" },
					authorizationRevision: "identity-1",
				},
				actor.userId,
			),
		).toThrowError(expect.objectContaining({ code: "forbidden" }));
		expect(() => requireSkillHubReviewerV1(actor)).toThrowError(
			expect.objectContaining({ code: "forbidden" }),
		);
		expect(() =>
			requireSkillHubVersionAccessV1(version, {
				...actor,
				userId: "other-owner",
			}),
		).toThrowError(expect.objectContaining({ code: "not_found" }));
		expect(() => requireSkillHubVersionAccessV1(version, actor)).not.toThrow();
		expect(() =>
			requireSkillHubVersionAccessV1(version, {
				...actor,
				userId: "admin",
				isAdministrator: true,
			}),
		).not.toThrow();
	});
	it("keeps an existing aggregate bound to its owner, active state and name", () => {
		const command = parseSkillHubRegistrationV1(registration);
		const parent = { name: "summary", ownerId: actor.userId, status: "active" };
		expect(() =>
			requireSkillHubRegistrationParentV1(parent, command, actor.userId),
		).not.toThrow();
		expect(() =>
			requireSkillHubRegistrationParentV1(
				{ ...parent, ownerId: "other" },
				command,
				actor.userId,
			),
		).toThrowError(expect.objectContaining({ code: "not_found" }));
		expect(() =>
			requireSkillHubRegistrationParentV1(
				{ ...parent, status: "disabled" },
				command,
				actor.userId,
			),
		).toThrowError(expect.objectContaining({ code: "forbidden" }));
		expect(() =>
			requireSkillHubRegistrationParentV1(
				{ ...parent, name: "replaced" },
				command,
				actor.userId,
			),
		).toThrowError(expect.objectContaining({ code: "version_conflict" }));
	});
	it("requires a bounded rejection reason without accepting caller reviewer identity", () => {
		expect(
			parseSkillHubReviewV1({ decision: "reject", reason: "Not approved" }),
		).toEqual({ decision: "reject", reason: "Not approved" });
		for (const input of [
			{ decision: "reject" },
			{ decision: "reject", reason: " " },
			{ decision: "approve", reviewerId: "owner-a" },
		]) {
			expect(() => parseSkillHubReviewV1(input)).toThrowError(
				expect.objectContaining({ code: "invalid_input" }),
			);
		}
	});
});
