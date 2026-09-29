import { Writable } from "node:stream";
import { startObservability } from "@agent-infra/observability";
import { currentRequestMetadata } from "@agent-infra/observability/http";
import { expect, it, vi } from "vitest";
import {
	assemblePlatformApi,
	type PlatformApiAssemblyInput,
} from "./assembly.js";
import { requestMetadata } from "./http/common.js";
import { startPlatformApi } from "./index.js";

function input(): PlatformApiAssemblyInput {
	const unavailable = async (): Promise<never> => {
		throw new Error("PRIVATE_UNUSED_ADAPTER_SENTINEL");
	};
	return {
		databaseUrl: "postgres://fixture:fixture@127.0.0.1:1/fixture",
		identity: {
			async resolve(request) {
				if (request.headers.has("x-fixture-denied")) return null;
				if (request.headers.has("x-fixture-failed"))
					throw new Error("PRIVATE_DIRECTORY_SENTINEL");
				return {
					schemaVersion: 1,
					userId: "user-1",
					displayName: "Fixture",
					accountStatus: "active",
					organizationIds: ["org-1"],
					roles: ["employee"],
					authorizationRevision: "authorization-1",
				};
			},
			hydrateUsers: async () => [],
		},
		admissions: {
			authorizationAdmission: { authorize: unavailable },
			imageAdmission: { admitImage: unavailable },
			modelAdmission: { admitModels: unavailable },
			secretAdmission: { admitSecrets: unavailable },
			channelAdmission: { admitChannels: unavailable },
		},
		allocateApplicationIds: unavailable,
		prepareApplicationSecrets: unavailable,
		prepareConfigurationSecrets: unavailable,
		presentAgent: unavailable,
	};
}

it("assembles and serves stable isolated request metadata with bounded output", async () => {
	const lines: string[] = [];
	const telemetry = startObservability({
		service: "platform-api",
		output: new Writable({
			write(chunk, _encoding, done) {
				lines.push(String(chunk));
				done();
			},
		}),
	});
	const metadata: ReturnType<typeof requestMetadata>[] = [];
	const assembly = assemblePlatformApi({
		...input(),
		telemetry,
		async requestScope(request, work) {
			const first = requestMetadata(request);
			metadata.push(first);
			await Promise.resolve();
			expect(requestMetadata(request)).toEqual(first);
			await work();
			expect(requestMetadata(request)).toEqual(first);
		},
	});
	const server = startPlatformApi({
		dependencies: assembly.dependencies,
		port: 0,
		log: () => {},
	});
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No port");
		const external = "123e4567-e89b-42d3-a456-426614174099";
		const replies = await Promise.all(
			[{}, { "x-fixture-denied": "1" }, { "x-fixture-failed": "1" }].map(
				(headers) =>
					fetch(`http://127.0.0.1:${address.port}/api/v1/session`, {
						headers: {
							...headers,
							"x-request-id": external,
							traceparent: external,
						},
					}),
			),
		);
		expect(replies.map((reply) => reply.status)).toEqual([200, 401, 503]);
		const bodies = await Promise.all(replies.map((reply) => reply.json()));
		expect(bodies[0]).toMatchObject({ user: { userId: "user-1" } });
		const observations = lines.map((line) => JSON.parse(line));
		expect(observations).toHaveLength(3);
		expect(new Set(metadata.map((item) => item.requestId)).size).toBe(3);
		expect(new Set(metadata.map((item) => item.traceId)).size).toBe(3);
		for (const item of metadata) {
			expect(observations).toContainEqual(expect.objectContaining(item));
			expect(item.requestId).not.toBe(external);
			expect(item.traceId).not.toBe(external);
		}
		for (const body of bodies.slice(1)) {
			expect(observations).toContainEqual(
				expect.objectContaining({
					traceId: (body as { traceId: string }).traceId,
				}),
			);
		}
		expect(observations.map((item) => item.outcome).sort()).toEqual([
			"completed",
			"failed",
			"rejected",
		]);
		expect(lines.join("")).not.toMatch(
			/SENTINEL|user-1|org-1|x-fixture|api\/v1/,
		);
		expect(currentRequestMetadata()).toBeUndefined();
		expect(telemetry.status().enabled).toBe(false);
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
		await assembly.close();
	}
	expect(telemetry.status().state).toBe("closed");
});

it("keeps the assembled response and shutdown when capture throws", async () => {
	const record = vi.fn(() => {
		throw new Error("PRIVATE_CAPTURE_SENTINEL");
	});
	const close = vi.fn(async () => {});
	const assembly = assemblePlatformApi({
		...input(),
		telemetry: { record, close } as unknown as ReturnType<
			typeof startObservability
		>,
	});
	const { createPlatformApp } = await import("./app.js");
	try {
		const response = await createPlatformApp(assembly.dependencies).request(
			"/api/v1/session",
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ user: { userId: "user-1" } });
		expect(record).toHaveBeenCalledOnce();
	} finally {
		await assembly.close();
	}
	expect(close).toHaveBeenCalledOnce();
});
