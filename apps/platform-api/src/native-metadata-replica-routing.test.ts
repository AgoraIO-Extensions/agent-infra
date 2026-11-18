import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { RuntimeNativeMetadataBindingResponseV1 } from "@agent-infra/contracts/runtime";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { createRuntimeHostApp } from "../../agent-runtime-host/src/app.js";
import {
	createRuntimeNativeMetadataCurrentAssemblyV1,
	createRuntimeNativeMetadataReadV1,
} from "../../agent-runtime-host/src/native-metadata-assembly.js";
import { createRuntimeNativeMetadataCurrentClientV1 } from "../../agent-runtime-host/src/native-metadata-current-client.js";
import { createRuntimeNativeMetadataProofVerifierV1 } from "../../agent-runtime-host/src/native-metadata-proof.js";
import { createWorkerRuntimeNativeMetadataClientV1 } from "../../platform-worker/src/runtime-native-metadata-client.js";
import { createPlatformApiNativeMetadataCurrentClientV1 } from "../../platform-worker/src/runtime-native-metadata-current-client.js";
import {
	createWorkerRuntimeNativeMetadataGatewayAppV1,
	createWorkerRuntimeNativeMetadataGatewayV1,
} from "../../platform-worker/src/runtime-native-metadata-gateway.js";
import { createWorkerRuntimeNativeMetadataProofIssuerV1 } from "../../platform-worker/src/runtime-native-metadata-proof.js";
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
	mode:
		| "service"
		| "replicas"
		| "replacement"
		| "restart"
		| "unreachable"
		| "wrong-source"
		| "worker-restart",
) {
	let binding: RuntimeNativeMetadataBindingResponseV1;
	const destinations: string[] = [];
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
	const sandboxToken = "fixture-native-metadata-sandbox-token";
	const proofIdentity = {
		issuer: "test",
		workerId: "worker",
		keyVersion: "key",
	};
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const verifyProof = createRuntimeNativeMetadataProofVerifierV1({
		...proofIdentity,
		publicKey,
	}).verify;
	const nestedDestinations: string[][] = [];
	const driver = vi.fn(
		async (
			...[, context]: Parameters<
				import("@agent-infra/agent-runtime").RuntimeHost["readNativeMetadataV1"]
			>
		) => {
			await context.revalidate();
			return { ...binding, selector: projection.selector, projection };
		},
	);
	const hostCurrent = createRuntimeNativeMetadataCurrentClientV1({
		baseUrl: "http://test-worker",
		serviceToken: sandboxToken,
		fetch: async (input, init) => {
			const start = destinations.length;
			const envelope = JSON.parse(String(init?.body));
			if (mode === "wrong-source")
				envelope.apiRequestSourceRef = `${uid[1]}.${randomUUID()}`;
			const worker = mode === "worker-restart" ? makeGateway() : gateway;
			const result = await worker.fetch(
				new Request(String(input), { ...init, body: JSON.stringify(envelope) }),
			);
			nestedDestinations.push(destinations.slice(start));
			return result;
		},
	});
	const host = createRuntimeHostApp({
		host: {} as never,
		serviceToken: sandboxToken,
		verifyGrant: async () => {
			throw new Error("unexpected execution grant");
		},
		nativeMetadataRead: createRuntimeNativeMetadataReadV1(
			{ readNativeMetadataV1: driver },
			createRuntimeNativeMetadataCurrentAssemblyV1({
				current: hostCurrent,
				resolveNativeSessionRef: async () => "fixture-native-session",
				verifyProof,
			}),
		),
	});
	const target = vi.fn(async () =>
		createWorkerRuntimeNativeMetadataClientV1({
			baseUrl: "http://test-host",
			serviceToken: sandboxToken,
			fetch: async (input, init) =>
				host.fetch(new Request(String(input), init)),
		}),
	);
	const resolve = async () => binding;
	const makeGateway = () =>
		createWorkerRuntimeNativeMetadataGatewayAppV1({
			serviceToken,
			binding: { resolve },
			callbackCredential: {
				resolve: async () => ({ kind: "sandbox", token: sandboxToken }),
			},
			gateway: createWorkerRuntimeNativeMetadataGatewayV1({
				binding: { resolve },
				current,
				proofIssuer: createWorkerRuntimeNativeMetadataProofIssuerV1({
					...proofIdentity,
					privateKey,
				}),
				transport: { resolve: target },
			}),
		});
	const gateway = makeGateway();
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
		nestedDestinations,
		driver,
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
	"routes Worker and nested Host current checks to the API replica %s that owns the live request",
	async (index) => {
		const f = fixture("replicas");
		const response = await f.request(index);
		expect(response?.status).toBe(200);
		expect(await response?.json()).toEqual(projection);
		expect(f.destinations).toEqual(Array(4).fill(ips[index]));
		expect(f.nestedDestinations).toEqual([[ips[index]], [ips[index]]]);
		expect(f.driver).toHaveBeenCalledOnce();
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

it.each(["wrong-source", "worker-restart"] as const)(
	"rejects a nested Host callback after %s without any outbound API request for that callback",
	async (mode) => {
		const f = fixture(mode);
		expect((await f.request(0))?.status).toBe(503);
		expect(f.target).toHaveBeenCalledOnce();
		expect(f.driver).not.toHaveBeenCalled();
		expect(f.nestedDestinations).toEqual([[]]);
		expect(f.destinations).toEqual([ips[0]]);
	},
);
