import { describe, expect, it } from "vitest";
import { createPlatformApp, type PlatformAppDependencies } from "./app.js";
import { assemblePlatformApi } from "./assembly.js";
import { HttpProtocolError } from "./http/common.js";

function fixture(requestScope: PlatformAppDependencies["requestScope"]) {
	const unused = async (): Promise<never> => {
		throw new Error("unused fixture dependency");
	};
	const assembly = assemblePlatformApi({
		databaseUrl: "postgres://invalid:invalid@127.0.0.1:1/invalid",
		identity: { resolve: async () => null, hydrateUsers: async () => [] },
		admissions: {
			authorizationAdmission: { authorize: unused },
			imageAdmission: { admitImage: unused },
			modelAdmission: { admitModels: unused },
			secretAdmission: { admitSecrets: unused },
			channelAdmission: { admitChannels: unused },
		},
		allocateApplicationIds: unused,
		prepareApplicationSecrets: unused,
		prepareConfigurationSecrets: unused,
		presentAgent: unused,
	});
	return {
		app: createPlatformApp({ ...assembly.dependencies, requestScope }),
		close: () => assembly.close(),
	};
}

describe("original Hono request-scope response", () => {
	it.each([401, 403])(
		"awaits settlement and replaces the already finalized 202 with %s",
		async (status) => {
			let prepared: () => void = () => {};
			const routePrepared = new Promise<void>((resolve) => {
				prepared = resolve;
			});
			let settle: () => void = () => {};
			const settled = new Promise<void>((resolve) => {
				settle = resolve;
			});
			const f = fixture(async (_request, work) => {
				const accepted = await work();
				expect(accepted.status).toBe(202);
				prepared();
				await settled;
				return Response.json(
					{ outcome: "denied-after-settlement" },
					{ status },
				);
			});
			f.app.post("/scope-response", (context) =>
				context.json({ outcome: "accepted" }, 202),
			);
			let delivered = false;
			try {
				const pending = Promise.resolve(
					f.app.request("/scope-response", { method: "POST" }),
				).then((response) => {
					delivered = true;
					return response;
				});
				await routePrepared;
				expect(delivered).toBe(false);
				settle();
				const response = await pending;
				expect(response.status).toBe(status);
				expect(await response.json()).toEqual({
					outcome: "denied-after-settlement",
				});
			} finally {
				settle();
				await f.close();
			}
		},
	);

	it("keeps an already mapped 4xx Response available to the savepoint decision", async () => {
		const observed: number[] = [];
		const f = fixture(async (_request, work) => {
			const response = await work();
			observed.push(response.status);
			return response;
		});
		f.app.post("/scope-response", () => {
			throw new HttpProtocolError("INVALID_REQUEST", "trace-fixture");
		});
		try {
			const response = await f.app.request("/scope-response", {
				method: "POST",
			});
			expect(observed).toEqual([400]);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ code: "INVALID_REQUEST" });
		} finally {
			await f.close();
		}
	});

	it("rejects request-scope work after an unexpected route 5xx instead of settling successfully", async () => {
		const failure = new Error("controlled route failure");
		let committed = false;
		let observedError: unknown;
		const f = fixture(async (_request, work) => {
			try {
				const response = await work();
				committed = true;
				return response;
			} catch (error) {
				observedError = error;
				throw error;
			}
		});
		f.app.post("/scope-response", () => {
			throw failure;
		});
		try {
			const response = await f.app.request("/scope-response", {
				method: "POST",
			});
			expect(observedError).toBe(failure);
			expect(committed).toBe(false);
			expect(response.status).toBe(500);
			expect(await response.json()).toMatchObject({ code: "INTERNAL_ERROR" });
		} finally {
			await f.close();
		}
	});

	it("waits for rejected scope settlement and never returns the prepared 202", async () => {
		const prepared = Promise.withResolvers<void>();
		const settlement = Promise.withResolvers<void>();
		const f = fixture(async (_request, work) => {
			const response = await work();
			expect(response.status).toBe(202);
			prepared.resolve();
			await settlement.promise;
			return response;
		});
		f.app.post("/scope-response", (context) =>
			context.json({ outcome: "accepted" }, 202),
		);
		let delivered = false;
		const pending = Promise.resolve(
			f.app.request("/scope-response", { method: "POST" }),
		).then((response) => {
			delivered = true;
			return response;
		});
		try {
			await prepared.promise;
			expect(delivered).toBe(false);
			settlement.reject(new Error("controlled settlement failure"));
			const response = await pending;
			expect(response.status).toBe(500);
			expect(await response.json()).toMatchObject({ code: "INTERNAL_ERROR" });
		} finally {
			settlement.resolve();
			await pending;
			await f.close();
		}
	});
});
