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

	it("resolves the read-only presentation identity once per request and never across requests (#2632)", async () => {
		let resolutions = 0;
		let active = true;
		const scope = createDeploymentIdentityScope({
			async resolve(request) {
				resolutions += 1;
				await Promise.resolve();
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

		// 列表里的每一项都要展示：同一个请求并发取 5 次，只解析一次，拿到同一个身份。
		const first = await scope.requestScope(
			new Request("https://platform.test/alice"),
			() =>
				Promise.all(
					Array.from({ length: 5 }, () => scope.requestIdentity("trace_01")),
				),
		);
		expect(resolutions).toBe(1);
		expect(new Set(first).size).toBe(1);
		expect(first[0]?.userId).toBe("alice");

		// 下一个请求重新解析，不复用上一个请求的结果；并发的两个请求互不串用。
		const [bob, carol] = await Promise.all(
			["bob", "carol"].map((userId) =>
				scope.requestScope(new Request(`https://platform.test/${userId}`), () =>
					scope.requestIdentity("trace_02"),
				),
			),
		);
		expect([bob?.userId, carol?.userId]).toEqual(["bob", "carol"]);
		expect(resolutions).toBe(3);

		// 准入不变：同一个请求里 currentIdentity 每次都重新解析，撤权立即生效。
		await scope.requestScope(
			new Request("https://platform.test/alice"),
			async () => {
				await scope.requestIdentity("trace_03");
				await scope.currentIdentity("trace_03");
				await scope.currentIdentity("trace_03");
				expect(resolutions).toBe(6);
				active = false;
				await expect(scope.currentIdentity("trace_03")).rejects.toMatchObject({
					body: { code: "AUTHORIZATION_REVOKED" },
				});
			},
		);

		// 停用之后的新请求不会拿到旧的展示身份。
		await expect(
			scope.requestScope(new Request("https://platform.test/alice"), () =>
				scope.requestIdentity("trace_04"),
			),
		).rejects.toMatchObject({ body: { code: "AUTHORIZATION_REVOKED" } });
		await expect(scope.requestIdentity("trace_05")).rejects.toThrow("scope");
	});

	it("shares a failed presentation resolution only within its own request (#2632)", async () => {
		let failing = true;
		let resolutions = 0;
		const scope = createDeploymentIdentityScope({
			async resolve() {
				resolutions += 1;
				if (failing) throw new Error("PRIVATE_DIRECTORY_DETAIL");
				return identity;
			},
			async hydrateUsers() {
				return [];
			},
		});
		const failures = await scope.requestScope(
			new Request("https://platform.test/alice"),
			() =>
				Promise.allSettled([
					scope.requestIdentity("trace_01"),
					scope.requestIdentity("trace_01"),
				]),
		);
		expect(failures.map((result) => result.status)).toEqual([
			"rejected",
			"rejected",
		]);
		expect(resolutions).toBe(1);
		failing = false;
		await expect(
			scope.requestScope(new Request("https://platform.test/alice"), () =>
				scope.requestIdentity("trace_02"),
			),
		).resolves.toMatchObject({ userId: "alice" });
		expect(resolutions).toBe(2);
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
