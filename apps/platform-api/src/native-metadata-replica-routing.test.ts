import { randomUUID } from "node:crypto";
import type { RuntimeNativeMetadataBindingResponseV1 } from "@agent-infra/contracts/runtime";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { createPlatformApiNativeMetadataCurrentClientV1 } from "../../platform-worker/src/runtime-native-metadata-current-client.js";
import {
	createWorkerRuntimeNativeMetadataGatewayAppV1,
	createWorkerRuntimeNativeMetadataGatewayV1,
} from "../../platform-worker/src/runtime-native-metadata-gateway.js";
import { createNativeMetadataCurrentAppV1 } from "./http/native-metadata-current-routes.js";
import { registerNativeMetadataRoutes } from "./http/native-metadata-routes.js";
import {
	createRuntimeNativeMetadataCurrentCheckerV1,
	createRuntimeNativeMetadataRequestRegistryV1,
} from "./runtime-native-metadata-current.js";
import { createRuntimeNativeMetadataWorkerReaderV1 } from "./runtime-native-metadata-reader.js";
import { createPlatformWorkerNativeMetadataGatewayClientV1 } from "./runtime-native-metadata-worker-client.js";

const namespace = "test";
const serviceToken = "fixture-native-metadata-service-token";
const uid = [randomUUID(), randomUUID()];
const ips = ["10.0.0.11", "10.0.0.12"];
const identity = {
	schemaVersion: 1 as const,
	userId: "owner",
	displayName: "Owner",
	accountStatus: "active" as const,
	organizationIds: [],
	roles: ["employee" as const],
	authorizationRevision: "auth-v1",
};
const projection = {
	selector: "skills" as const,
	revision: "a".repeat(64),
	capabilities: [],
};

function fixture(
	mode: "service" | "replicas" | "replacement" | "restart" | "unreachable",
) {
	let binding: RuntimeNativeMetadataBindingResponseV1;
	const destinations: string[] = [];
	const target = vi.fn(async () => ({
		read: async () => ({ ...binding, projection }),
	}));
	const currentApps: Hono[] = [];
	const current = createPlatformApiNativeMetadataCurrentClientV1({
		baseUrl:
			mode === "service"
				? "http://test-platform-api:3000"
				: "http://test-platform-api.test.svc:3000",
		serviceToken,
		...(mode === "service"
			? {}
			: {
					replicas: {
						namespace,
						read: (async (kind: string, name: string) => {
							if (kind === "Endpoints" && name === "test-platform-api")
								return {
									metadata: { name, namespace },
									subsets: [
										{
											ports: [{ name: "http", protocol: "TCP", port: 3000 }],
											addresses: ips.map((ip, index) => ({
												ip,
												targetRef: {
													kind: "Pod",
													name: `api-${index}`,
													uid: uid[index],
													namespace,
												},
											})),
										},
									],
								};
							const index = name === "api-0" ? 0 : 1;
							return {
								metadata: {
									name,
									namespace,
									labels: { "app.kubernetes.io/component": "platform-api" },
									uid: mode === "replacement" ? randomUUID() : uid[index],
								},
								status: {
									podIP: ips[index],
									conditions: [{ type: "Ready", status: "True" }],
								},
							};
						}) as NonNullable<
							Parameters<
								typeof createPlatformApiNativeMetadataCurrentClientV1
							>[0]["replicas"]
						>["read"],
					},
				}),
		fetch: async (input, init) => {
			const host = new URL(String(input)).hostname;
			destinations.push(host);
			if (mode === "unreachable") throw new Error("fixture unreachable");
			const index = host === "test-platform-api" ? 1 : ips.indexOf(host);
			const app = currentApps[index];
			if (!app) throw new Error("unexpected callback destination");
			return app.fetch(new Request(String(input), init));
		},
	});
	const gateway = createWorkerRuntimeNativeMetadataGatewayAppV1({
		serviceToken,
		gateway: createWorkerRuntimeNativeMetadataGatewayV1({
			binding: { resolve: async () => binding },
			current,
			proofIssuer: {
				issue: async () => ({
					schemaVersion: 1,
					format: "native-metadata-jws",
					token: "fixture-proof",
				}),
			},
			transport: { resolve: target },
		}),
	});
	const publicApps = uid.map((instanceUid) => {
		const registry = createRuntimeNativeMetadataRequestRegistryV1({
			instanceUid: mode === "service" ? undefined : instanceUid,
		});
		currentApps.push(
			createNativeMetadataCurrentAppV1({
				serviceToken,
				...createRuntimeNativeMetadataCurrentCheckerV1({
					registry:
						mode === "restart"
							? createRuntimeNativeMetadataRequestRegistryV1({ instanceUid })
							: registry,
					authorize: async () => ({
						outcome: "allowed",
						authority: {
							actorId: identity.userId,
							agentId: "agent",
							channelId: "web",
							authorizationRevision: identity.authorizationRevision,
						},
					}),
				}),
			}),
		);
		const app = new Hono();
		registerNativeMetadataRoutes(app, {
			identity: { resolve: async () => identity, hydrateUsers: async () => [] },
			reader: createRuntimeNativeMetadataWorkerReaderV1({
				requestRegistry: registry,
				resolveRequest: async ({ requestContext }) => {
					if (!requestContext) throw new Error("missing request context");
					binding ??= {
						schemaVersion: 1,
						readId: randomUUID(),
						selector: "skills",
						scope: {
							schemaVersion: 1,
							principal: { kind: "user", id: identity.userId },
							agentId: "agent",
							channelId: "web",
							conversationId: "conversation",
							executionId: "execution",
							sessionGeneration: 1,
							authorizationRevision: identity.authorizationRevision,
						},
						readStartedAt: requestContext.readStartedAt,
						expiresAt: requestContext.expiresAt,
						requestId: randomUUID(),
						traceId: requestContext.traceId ?? randomUUID(),
						originalHostScopeRef: "host",
					};
					return binding;
				},
				gateway: createPlatformWorkerNativeMetadataGatewayClientV1({
					baseUrl: "http://test-worker",
					serviceToken,
					fetch: async (input, init) =>
						gateway.fetch(new Request(String(input), init)),
				}),
			}),
		});
		return app;
	});
	return {
		target,
		destinations,
		request: (index: number) =>
			publicApps[index]?.request(
				"/api/v2/conversations/conversation/executions/execution/native-metadata?selector=skills",
			),
	};
}

it("reproduces registry miss when Service routes the original API A request to API B", async () => {
	const f = fixture("service");
	expect((await f.request(0))?.status).toBe(503);
	expect(f.destinations).toEqual(["test-platform-api"]);
	expect(f.target).not.toHaveBeenCalled();
});

it.each([0, 1])(
	"routes both current checks to the API replica %s that owns the live request",
	async (index) => {
		const f = fixture("replicas");
		const response = await f.request(index);
		expect(response?.status).toBe(200);
		expect(await response?.json()).toEqual(projection);
		expect(f.destinations).toEqual([ips[index], ips[index]]);
		expect(f.target).toHaveBeenCalledOnce();
	},
);

it.each(["replacement", "restart", "unreachable"] as const)(
	"fails closed on %s without trying the other replica",
	async (mode) => {
		const f = fixture(mode);
		expect((await f.request(0))?.status).toBe(503);
		expect(f.destinations).toEqual(mode === "replacement" ? [] : [ips[0]]);
		expect(f.target).not.toHaveBeenCalled();
	},
);
