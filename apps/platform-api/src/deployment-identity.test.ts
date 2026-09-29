import { describe, expect, it } from "vitest";

import {
	allocateDeploymentApplicationIds,
	createDeploymentIdentityScope,
} from "./deployment-identity.js";
import type { IdentityContext } from "./http/identity.js";

const identity: IdentityContext = {
	schemaVersion: 1,
	userId: "alice",
	displayName: "Alice",
	accountStatus: "active",
	organizationIds: ["org_01"],
	roles: ["employee"],
	authorizationRevision: "revision_01",
};

describe("deployment identity scope", () => {
	it("keeps concurrent HTTP identities separate and rechecks current status", async () => {
		let active = true;
		const scope = createDeploymentIdentityScope({
			async resolve(request) {
				return {
					...identity,
					userId: new URL(request.url).pathname.slice(1),
					accountStatus: active ? "active" : "disabled",
				};
			},
			async hydrateUsers() {
				return [];
			},
		});
		await Promise.all(
			["alice", "bob"].map((userId) =>
				scope.requestScope(
					new Request(`https://platform.test/${userId}`),
					async () => {
						await Promise.resolve();
						expect((await scope.currentIdentity("trace_01")).userId).toBe(
							userId,
						);
					},
				),
			),
		);
		await expect(scope.currentIdentity("trace_01")).rejects.toThrow("scope");
		await scope.requestScope(
			new Request("https://platform.test/alice"),
			async () => {
				await scope.currentIdentity("trace_01");
				active = false;
				await expect(scope.currentIdentity("trace_01")).rejects.toMatchObject({
					body: { code: "AUTHORIZATION_REVOKED" },
				});
			},
		);
	});

	it("binds reproducible application IDs to the submitting user and idempotency key", async () => {
		const input = { identity, idempotencyKey: "request_01" };
		const first = await allocateDeploymentApplicationIds(input);
		expect(
			await allocateDeploymentApplicationIds(structuredClone(input)),
		).toEqual(first);
		expect(
			await allocateDeploymentApplicationIds({
				...input,
				identity: { ...identity, userId: "bob" },
			}),
		).not.toEqual(first);
		expect(
			await allocateDeploymentApplicationIds({
				...input,
				idempotencyKey: "request_02",
			}),
		).not.toEqual(first);
		expect(first.applicationId).not.toBe(first.agentId);
	});
});
