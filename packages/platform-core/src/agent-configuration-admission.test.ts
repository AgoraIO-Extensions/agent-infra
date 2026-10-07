import { describe, expect, it } from "vitest";

import { parseAuthorizationDecision } from "./agent-configuration-admission.ts";
import {
	parseAvailability,
	parseOwnerIds,
} from "./agent-configuration-input.ts";

const authorityUser = (index: number) => ({
	userId: `directory-user-${index}`,
	accountStatus: "active" as const,
});

describe("agent configuration authority admission", () => {
	it("accepts a complete directory larger than the selected-target limit", () => {
		const users = Array.from({ length: 257 }, (_, index) =>
			authorityUser(index),
		);

		expect(
			parseAuthorizationDecision({
				schemaVersion: 1,
				status: "admitted",
				agentId: "agent-01",
				actorId: "directory-user-0",
				authorizationRevision: "directory-01",
				authorityContext: {
					schemaVersion: 1,
					users,
					organizationIds: [],
				},
			}),
		).toMatchObject({
			status: "admitted",
			authorityContext: { users },
		});
	});

	it.each([
		[
			"duplicate users",
			(users: ReturnType<typeof authorityUser>[]) => [users[0], users[0]],
		],
		[
			"invalid account status",
			() => [{ userId: "directory-user-0", accountStatus: "unknown" }],
		],
		[
			"sparse users",
			() => Object.assign([], { 1: authorityUser(1), length: 2 }),
		],
	])("rejects %s in the authority directory", (_name, users) => {
		expect(() =>
			parseAuthorizationDecision({
				schemaVersion: 1,
				status: "admitted",
				agentId: "agent-01",
				actorId: "directory-user-0",
				authorizationRevision: "directory-01",
				authorityContext: {
					schemaVersion: 1,
					users: users([authorityUser(0)]),
					organizationIds: [],
				},
			}),
		).toThrowError();
	});

	it("keeps the 256-item cap for selected Owners and availability", () => {
		expect(() =>
			parseOwnerIds(Array.from({ length: 257 }, (_, i) => `owner-${i}`)),
		).toThrowError();
		expect(() =>
			parseAvailability(
				Array.from({ length: 257 }, (_, i) => ({
					kind: "user",
					userId: `target-${i}`,
				})),
			),
		).toThrowError();
	});

	it("keeps a bounded authority directory input", () => {
		const users = Array.from({ length: 4097 }, (_, index) =>
			authorityUser(index),
		);
		expect(() =>
			parseAuthorizationDecision({
				schemaVersion: 1,
				status: "admitted",
				agentId: "agent-01",
				actorId: "directory-user-0",
				authorizationRevision: "directory-01",
				authorityContext: {
					schemaVersion: 1,
					users,
					organizationIds: [],
				},
			}),
		).toThrowError();
	});
});
