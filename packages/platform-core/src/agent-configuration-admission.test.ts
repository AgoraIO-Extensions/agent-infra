import { describe, expect, it } from "vitest";

import {
	parseAuthorizationDecision,
	parseImageDecision,
	parseModelDecision,
} from "./agent-configuration-admission.ts";
import {
	parseAvailability,
	parseOwnerIds,
} from "./agent-configuration-input.ts";

const authorityUser = (index: number) => ({
	userId: `directory-user-${index}`,
	accountStatus: "active" as const,
});

const rejection = {
	schemaVersion: 1,
	status: "rejected",
	agentId: "agent-01",
	requestId: "request-01",
} as const;

describe("agent configuration admission rejection reasons", () => {
	it("accepts the resource cap reason only from the image port", () => {
		expect(
			parseImageDecision({
				...rejection,
				reason: "multi_service_resource_cap_exceeded",
			}),
		).toEqual({
			...rejection,
			reason: "multi_service_resource_cap_exceeded",
		});
		expect(parseImageDecision(rejection)).toEqual(rejection);
	});

	it.each(["codex_model_profile_unsupported", "unknown_profile", "", null])(
		"treats image rejection reason %j as an invalid dependency value",
		(reason) => {
			expect(() => parseImageDecision({ ...rejection, reason })).toThrowError(
				expect.objectContaining({ code: "dependency_unavailable" }),
			);
		},
	);

	it("rejects an image admission that carries a reason", () => {
		expect(() =>
			parseImageDecision({
				...rejection,
				status: "admitted",
				reason: "multi_service_resource_cap_exceeded",
				source: {},
			}),
		).toThrowError(expect.objectContaining({ code: "dependency_unavailable" }));
	});

	it("keeps the model port limited to its own rejection reason", () => {
		expect(
			parseModelDecision({
				...rejection,
				reason: "codex_model_profile_unsupported",
			}),
		).toEqual({ ...rejection, reason: "codex_model_profile_unsupported" });
		expect(() =>
			parseModelDecision({
				...rejection,
				reason: "multi_service_resource_cap_exceeded",
			}),
		).toThrowError(expect.objectContaining({ code: "dependency_unavailable" }));
	});
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
