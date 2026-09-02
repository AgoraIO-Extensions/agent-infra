import { once } from "node:events";
import { createServer } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { assemblePlatformApi } from "./assembly.js";
import {
	createPlatformApiShutdown,
	loadPlatformApiAssembly,
	startPlatformApi,
	startPlatformApiFromDeployment,
} from "./index.js";

const servers: { close(callback?: (error?: Error) => void): void }[] = [];

afterEach(async () => {
	await Promise.all(
		servers
			.splice(0)
			.map(
				(server) =>
					new Promise<void>((resolve, reject) =>
						server.close((error) => (error ? reject(error) : resolve())),
					),
			),
	);
});

describe("Platform API production assembly", () => {
	it("requires a deployment module with the assembly-input factory", async () => {
		await expect(loadPlatformApiAssembly("")).rejects.toThrow(
			"PLATFORM_API_DEPLOYMENT_MODULE is required",
		);
		await expect(
			loadPlatformApiAssembly(
				"data:text/javascript,export const invalid = true",
			),
		).rejects.toThrow("Platform API deployment module is invalid");
	});

	it("registers the complete app before starting the Node server", async () => {
		const identity = {
			schemaVersion: 1 as const,
			userId: "user-1",
			displayName: "Ada",
			accountStatus: "active" as const,
			organizationIds: ["org-1"],
			roles: ["employee" as const],
			authorizationRevision: "authorization-1",
		};
		const unavailable = async () => {
			throw new Error("unused test adapter");
		};
		const assembly = assemblePlatformApi({
			databaseUrl: "postgres://invalid:invalid@127.0.0.1:1/invalid",
			identity: {
				resolve: vi.fn().mockResolvedValue(identity),
				hydrateUsers: vi.fn().mockResolvedValue([]),
			},
			admissions: {
				authorizationAdmission: { authorize: unavailable },
				imageAdmission: { admitImage: unavailable },
				modelAdmission: { admitModels: unavailable },
				secretAdmission: { admitSecrets: unavailable },
				actionAdmission: { admitActions: unavailable },
				channelAdmission: { admitChannels: unavailable },
			},
			allocateApplicationIds: unavailable,
			prepareApplicationSecrets: unavailable,
			prepareConfigurationSecrets: unavailable,
			presentAgent: unavailable,
		});
		const server = startPlatformApi({
			dependencies: assembly.dependencies,
			log: () => {},
			port: 0,
		});
		servers.push(server);
		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error("Platform API did not bind a TCP port");
		}

		try {
			const response = await fetch(
				`http://127.0.0.1:${address.port}/api/v1/session`,
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				schemaVersion: 1,
				user: { userId: "user-1" },
			});
		} finally {
			await assembly.close();
		}
	});

	it("closes deployment assembly when the Node server cannot bind", async () => {
		const blocker = createServer();
		blocker.listen(0);
		await once(blocker, "listening");
		const address = blocker.address();
		if (!address || typeof address === "string") {
			throw new Error("Port blocker did not bind");
		}

		try {
			await expect(
				startPlatformApiFromDeployment({
					log: () => {},
					moduleSpecifier: new URL(
						"../../../tests/fixtures/platform-api-deployment.mjs",
						import.meta.url,
					).href,
					port: address.port,
				}),
			).rejects.toMatchObject({ code: "EADDRINUSE" });
		} finally {
			blocker.close();
			await once(blocker, "close");
		}
	});

	it("closes deployment resources once in server-first order", async () => {
		const calls: string[] = [];
		const assembly = {
			close: vi.fn(async () => {
				calls.push("assembly");
			}),
		} as unknown as Awaited<
			ReturnType<typeof startPlatformApiFromDeployment>
		>["assembly"];
		const server = {
			close(callback: (error?: Error) => void) {
				calls.push("server");
				callback();
			},
		} as ReturnType<typeof startPlatformApi>;
		const shutdown = createPlatformApiShutdown({ assembly, server });

		await Promise.all([shutdown(), shutdown()]);

		expect(calls).toEqual(["server", "assembly"]);
		expect(assembly.close).toHaveBeenCalledOnce();
	});
});
