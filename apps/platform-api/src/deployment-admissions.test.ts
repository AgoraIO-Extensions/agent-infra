import { createHash } from "node:crypto";
import type {
	AgentConfigurationModelInputV1,
	AgentConfigurationModelV1,
} from "@agent-infra/platform-core";
import { describe, expect, it, vi } from "vitest";
import {
	createDeploymentAdmissionsV1,
	type DeploymentAdmissionInputV1,
} from "./deployment-admissions.js";
import { createDeploymentIdentityScope } from "./deployment-identity.js";
import type { IdentityContext } from "./http/identity.js";

const actor: IdentityContext = {
	schemaVersion: 1,
	userId: "alice",
	displayName: "Alice",
	accountStatus: "active",
	organizationIds: ["org-a"],
	roles: ["employee"],
	authorizationRevision: "identity-a",
};
const request = {
	schemaVersion: 1,
	agentId: "agent-a",
	requestId: "request-a",
	traceId: "trace-a",
} as const;
const manifestMediaType = "application/vnd.oci.image.manifest.v1+json";
const configMediaType = "application/vnd.oci.image.config.v1+json";
const digest = (text: string) =>
	`sha256:${createHash("sha256").update(text).digest("hex")}`;

/** Synthetic registry bytes exercise the actual OCI parser, digest and policy path. */
function fixture(
	mode: "platform-adapter" | "self-managed" = "platform-adapter",
	connection = false,
) {
	const runtime = {
		schemaVersion: 1,
		interactionMode: mode,
		...(mode === "platform-adapter" ? { protocol: "acp" } : {}),
		service: { port: 8080 },
		health: { path: "/healthz" },
		capabilities: { modelSelection: true, connection },
	};
	const config = JSON.stringify({
		os: "linux",
		architecture: "amd64",
		config: {
			Entrypoint: ["node"],
			Cmd: ["host.mjs"],
			WorkingDir: "/workspace",
			User: "10001",
			Env: [],
			Labels: { "io.agora.agent.runtime.manifest": JSON.stringify(runtime) },
		},
	});
	const configDigest = digest(config);
	const manifest = JSON.stringify({
		schemaVersion: 2,
		mediaType: manifestMediaType,
		config: {
			mediaType: configMediaType,
			digest: configDigest,
			size: Buffer.byteLength(config),
		},
		layers: [],
	});
	const imageDigest = digest(manifest);
	const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
		const url = new URL(
			input instanceof Request ? input.url : input.toString(),
		);
		if (
			decodeURIComponent(url.pathname) === `/v2/codex/manifests/${imageDigest}`
		)
			return new Response(manifest, {
				headers: {
					"content-type": manifestMediaType,
					"docker-content-digest": imageDigest,
				},
			});
		if (decodeURIComponent(url.pathname) === `/v2/codex/blobs/${configDigest}`)
			return new Response(config, {
				headers: { "content-type": configMediaType },
			});
		return new Response(null, { status: 404 });
	});
	const authorize = vi.fn<
		DeploymentAdmissionInputV1["registry"]["policy"]["authorize"]
	>(async () => ({
		status: "admitted",
		decisionRef: "decision-a",
		evaluatedAt: "2026-09-14T00:00:00Z",
	}));
	const catalog = {
		schemaVersion: 1,
		revision: "catalog-a",
		validUntil: Date.now() + 60_000,
		endpoints: [
			{
				endpointId: "endpoint-a",
				baseUrl: "https://models.example.test/v1",
				origin: "https://models.example.test",
				protocol: "openai-responses-v1",
				security: { tls: "verify-peer", redirects: "reject" },
				capabilities: {
					streaming: true,
					tools: true,
					reasoningLevels: ["medium", "high"],
				},
				allowedModels: ["model-a", "model-b"],
				available: true,
			},
		],
	};
	const load = vi.fn(async (_signal: AbortSignal): Promise<unknown> => catalog);
	const input: DeploymentAdmissionInputV1 = {
		currentIdentity: vi.fn(async () => actor),
		registry: {
			endpoint: "https://registry.example.test",
			imageReferencePrefix: "registry.example.test/agents",
			admissionPolicyRef: "policy-a",
			fetch,
			policy: { authorize },
		},
		templates: [
			{
				templateId: "codex",
				imageDigest,
				imageReference: `registry.example.test/agents/codex@${imageDigest}`,
				allowedEnvironmentKeys: ["LANG"],
				allowedSecretKeys: ["MODEL_API_KEY"],
				platformManagedKeys: ["PORT"],
				connectionEnabled: false,
			},
		],
		modelCatalog: { revision: "catalog-a", load },
		channelPolicy: {
			revision: "channels-a",
			bindings: [
				{
					kind: "wecom_bot",
					bindingReference: "bot-a",
					agentId: "agent-a",
					actorIds: ["alice"],
				},
			],
		},
	};
	return { input, authorize, fetch, imageDigest, catalog, load };
}

function modelInput(replaceCredential = true): AgentConfigurationModelInputV1 {
	return {
		options: [
			{
				optionId: "option-a",
				endpointId: "endpoint-a",
				modelId: "model-a",
				reasoningLevels: ["medium", "high"],
				replaceCredential,
			},
		],
		defaultOptionId: "option-a",
		defaultReasoningLevel: "medium",
	};
}

describe("production deployment admissions", () => {
	it("rejects images outside the repository the Worker can actually deploy", async () => {
		const { input, fetch } = fixture();
		const admissions = createDeploymentAdmissionsV1({
			...input,
			imageRepository: "registry.example.test/agents/codex",
		});
		const result = await admissions.imageAdmission.admitImage({
			...request,
			requested: {
				kind: "custom",
				imageReference: "registry.example.test/agents/other:latest",
				interactionMode: "platform-adapter",
			},
		});
		expect(result.status).toBe("rejected");
		expect(fetch).not.toHaveBeenCalled();
		expect(() =>
			createDeploymentAdmissionsV1({
				...input,
				imageRepository: "registry.example.test/agents/other",
			}),
		).toThrow("PLATFORM_DEPLOYMENT_ADMISSION_CONFIGURATION_INVALID");
	});
	it("binds actual OCI content and policy evidence to the trusted actor and template", async () => {
		const { input, authorize, imageDigest, fetch } = fixture();
		const admissions = createDeploymentAdmissionsV1(input);
		const result = await admissions.imageAdmission.admitImage({
			...request,
			requested: { kind: "standard", templateId: "codex" },
		});
		expect(result).toMatchObject({
			schemaVersion: 1,
			status: "admitted",
			agentId: request.agentId,
			requestId: request.requestId,
			source: {
				kind: "standard",
				templateId: "codex",
				imageDigest,
				connectionEnabled: false,
				allowedEnvironmentKeys: ["LANG"],
			},
		});
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(authorize).toHaveBeenCalledWith(
			{
				...request,
				subjectRef: "alice",
				imageReference: input.templates[0]?.imageReference,
				immutableDigest: imageDigest,
				usage: "standard-template",
				admissionPolicyRef: "policy-a",
			},
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		authorize.mockResolvedValueOnce({
			status: "admitted",
			decisionRef: "decision-b",
			evaluatedAt: "2026-09-14T00:00:00Z",
		});
		const changed = await admissions.imageAdmission.admitImage({
			...request,
			requested: { kind: "standard", templateId: "codex" },
		});
		if (result.status !== "admitted" || changed.status !== "admitted")
			throw new Error("Expected actual registry admission");
		expect(changed.source.admissionRevision).not.toBe(
			result.source.admissionRevision,
		);
	});

	it("preserves self-managed identity responsibility and rejects interaction-mode mismatch", async () => {
		const { input, authorize } = fixture("self-managed", true);
		const admissions = createDeploymentAdmissionsV1(input);
		const imageReference = input.templates[0]?.imageReference ?? "";
		expect(
			await admissions.imageAdmission.admitImage({
				...request,
				requested: {
					kind: "custom",
					imageReference,
					interactionMode: "self-managed",
					identityResponsibility: "platform-managed",
				},
			}),
		).toMatchObject({
			status: "admitted",
			source: {
				kind: "custom",
				interactionMode: "self-managed",
				identityResponsibility: "platform-managed",
				connectionEnabled: false,
			},
		});
		expect(authorize.mock.calls[0]?.[0].usage).toBe("custom-agent");
		for (const requested of [
			{ kind: "standard", templateId: "codex" } as const,
			{
				kind: "custom",
				imageReference,
				interactionMode: "platform-adapter",
			} as const,
		])
			expect(
				await admissions.imageAdmission.admitImage({ ...request, requested }),
			).toMatchObject({ status: "rejected" });
	});

	it("rejects absent templates, corrupt OCI content, registry denial and unsupported Connection claims", async () => {
		const f = fixture();
		const admissions = createDeploymentAdmissionsV1(f.input);
		const selection = { kind: "standard", templateId: "codex" } as const;
		expect(
			await admissions.imageAdmission.admitImage({
				...request,
				requested: { kind: "standard", templateId: "other" },
			}),
		).toMatchObject({ status: "rejected" });
		expect(f.fetch).not.toHaveBeenCalled();
		f.authorize.mockResolvedValueOnce({ status: "rejected" });
		expect(
			await admissions.imageAdmission.admitImage({
				...request,
				requested: selection,
			}),
		).toMatchObject({ status: "rejected" });
		f.fetch.mockResolvedValueOnce(
			new Response("invalid", {
				headers: {
					"content-type": manifestMediaType,
					"docker-content-digest": f.imageDigest,
				},
			}),
		);
		expect(
			await admissions.imageAdmission.admitImage({
				...request,
				requested: selection,
			}),
		).toMatchObject({ status: "rejected" });
		const connectionClaim = createDeploymentAdmissionsV1({
			...f.input,
			templates: f.input.templates.map((t) => ({
				...t,
				connectionEnabled: true,
			})),
		});
		expect(
			await connectionClaim.imageAdmission.admitImage({
				...request,
				requested: selection,
			}),
		).toMatchObject({ status: "rejected" });
	});

	it("keeps simultaneous request identities isolated through real registry policy awaits", async () => {
		const f = fixture();
		const scope = createDeploymentIdentityScope({
			async resolve(req) {
				await Promise.resolve();
				return { ...actor, userId: new URL(req.url).pathname.slice(1) };
			},
			async hydrateUsers() {
				return [];
			},
		});
		const admissions = createDeploymentAdmissionsV1({
			...f.input,
			currentIdentity: scope.currentIdentity,
		});
		await Promise.all(
			["alice", "bob"].map((user) =>
				scope.requestScope(
					new Request(`https://platform.example.test/${user}`),
					async () => {
						expect(
							await admissions.imageAdmission.admitImage({
								...request,
								requestId: user,
								requested: { kind: "standard", templateId: "codex" },
							}),
						).toMatchObject({ status: "admitted" });
					},
				),
			),
		);
		expect(
			f.authorize.mock.calls
				.map(([input]) => [input.requestId, input.subjectRef])
				.toSorted(),
		).toEqual([
			["alice", "alice"],
			["bob", "bob"],
		]);
		await expect(
			admissions.imageAdmission.admitImage({
				...request,
				requested: { kind: "standard", templateId: "codex" },
			}),
		).rejects.toThrow("PLATFORM_DEPLOYMENT_IDENTITY_UNAVAILABLE");
	});

	it("rechecks identity for every admission and sanitizes dependency failure", async () => {
		const f = fixture();
		const resolve = vi.fn(async (): Promise<IdentityContext> => actor);
		const a = createDeploymentAdmissionsV1({
			...f.input,
			currentIdentity: resolve,
		});
		await a.secretAdmission.admitSecrets({
			...request,
			current: [],
			requested: [],
		});
		resolve.mockRejectedValue(new Error("credential=synthetic-private-value"));
		const results = await Promise.allSettled([
			a.imageAdmission.admitImage({
				...request,
				requested: { kind: "standard", templateId: "codex" },
			}),
			a.modelAdmission.admitModels({
				...request,
				current: null,
				requested: modelInput(),
			}),
			a.secretAdmission.admitSecrets({
				...request,
				current: [],
				requested: [],
			}),
			a.channelAdmission.admitChannels({
				...request,
				current: [],
				requested: [],
			}),
		]);
		for (const result of results) {
			expect(result.status).toBe("rejected");
			if (result.status === "rejected")
				expect(result.reason.message).toBe(
					"PLATFORM_DEPLOYMENT_IDENTITY_UNAVAILABLE",
				);
		}
		expect(resolve).toHaveBeenCalledTimes(5);
		expect(f.fetch).not.toHaveBeenCalled();
		expect(f.load).not.toHaveBeenCalled();
	});

	it("uses one real catalog snapshot for all options and freezes its configured revision", async () => {
		const f = fixture();
		const config = { ...f.input.modelCatalog };
		const admissions = createDeploymentAdmissionsV1({
			...f.input,
			modelCatalog: config,
		});
		config.revision = "changed-after-assembly";
		const requested = modelInput();
		const first = requested.options[0];
		if (!first) throw new Error();
		const result = await admissions.modelAdmission.admitModels({
			...request,
			current: null,
			requested: {
				...requested,
				options: [
					first,
					{ ...first, optionId: "option-b", modelId: "model-b" },
				],
			},
		});
		expect(result).toMatchObject({
			status: "admitted",
			configuration: {
				catalogRevision: "catalog-a",
				defaultOptionId: "option-a",
			},
		});
		expect(f.load).toHaveBeenCalledTimes(1);
		if (result.status !== "admitted") throw new Error();
		expect(result.configuration.options).toHaveLength(2);
		const ids = result.configuration.options.map(
			(option) => option.credential.secretId,
		);
		expect(new Set(ids).size).toBe(2);
		for (const option of result.configuration.options)
			expect(option.credential).toEqual({
				secretId: expect.any(String),
				version: 1,
				isSet: true,
			});
		expect(JSON.stringify(result)).not.toContain("https://");
	});

	it.each([
		"revision",
		"expired",
		"unavailable",
		"missing-endpoint",
		"model",
		"reasoning",
	])("rejects a catalog %s violation", async (kind) => {
		const f = fixture();
		const endpoint = f.catalog.endpoints[0];
		if (!endpoint) throw new Error();
		if (kind === "revision") f.catalog.revision = "other-revision";
		if (kind === "expired") f.catalog.validUntil = Date.now() - 1;
		if (kind === "unavailable") endpoint.available = false;
		if (kind === "missing-endpoint") endpoint.endpointId = "other-endpoint";
		if (kind === "model") endpoint.allowedModels = ["other-model"];
		if (kind === "reasoning")
			endpoint.capabilities.reasoningLevels = ["medium"];
		expect(
			await createDeploymentAdmissionsV1(f.input).modelAdmission.admitModels({
				...request,
				current: null,
				requested: modelInput(),
			}),
		).toMatchObject({ status: "rejected" });
	});

	it("reports unavailable catalog loading without leaking source errors", async () => {
		const f = fixture();
		f.load.mockRejectedValue(new Error("private endpoint and credential"));
		await expect(
			createDeploymentAdmissionsV1(f.input).modelAdmission.admitModels({
				...request,
				current: null,
				requested: modelInput(),
			}),
		).rejects.toThrow(/^PLATFORM_DEPLOYMENT_MODEL_ADMISSION_UNAVAILABLE$/);
	});

	it("retains and versions model Secret metadata without receiving plaintext", async () => {
		const a = createDeploymentAdmissionsV1(fixture().input);
		const current: AgentConfigurationModelV1 = {
			...modelInput(),
			catalogRevision: "catalog-a",
			options: [
				{
					optionId: "option-a",
					endpointId: "endpoint-a",
					modelId: "model-a",
					reasoningLevels: ["medium", "high"],
					credential: { secretId: "credential-a", version: 4, isSet: true },
				},
			],
		};
		for (const replace of [false, true]) {
			const result = await a.modelAdmission.admitModels({
				...request,
				current,
				requested: modelInput(replace),
			});
			expect(result).toMatchObject({
				status: "admitted",
				configuration: {
					options: [
						{
							credential: {
								secretId: "credential-a",
								version: replace ? 5 : 4,
								isSet: true,
							},
						},
					],
				},
			});
		}
		expect(current.options[0]?.credential.version).toBe(4);
		expect(
			await a.modelAdmission.admitModels({
				...request,
				current: null,
				requested: modelInput(false),
			}),
		).toMatchObject({ status: "rejected" });
	});

	it("only allocates requested Secret replacements, preserving Secret identity and current data", async () => {
		const a = createDeploymentAdmissionsV1(fixture().input);
		const current = [
			{
				name: "EXISTING",
				secretId: "secret-a",
				version: 7,
				isSet: true as const,
			},
			{
				name: "UNCHANGED",
				secretId: "secret-b",
				version: 1,
				isSet: true as const,
			},
		];
		const result = await a.secretAdmission.admitSecrets({
			...request,
			current,
			requested: [
				{ name: "NEW", replace: true },
				{ name: "EXISTING", replace: true },
			],
		});
		expect(result).toMatchObject({
			status: "admitted",
			secrets: [
				{ name: "EXISTING", secretId: "secret-a", version: 8, isSet: true },
				{ name: "NEW", secretId: expect.any(String), version: 1, isSet: true },
			],
		});
		expect(current[0]?.version).toBe(7);
		await expect(
			a.secretAdmission.admitSecrets({
				...request,
				current,
				requested: [{ name: "AGENT_INFRA_PRIVATE_KEY", replace: true }],
			}),
		).rejects.toThrow();
	});

	it("registers channel bindings for the exact Agent and actor, including retained bindings", async () => {
		const f = fixture();
		const channel = { kind: "wecom_bot", bindingReference: "bot-a" } as const;
		const a = createDeploymentAdmissionsV1(f.input);
		expect(
			await a.channelAdmission.admitChannels({
				...request,
				current: [],
				requested: [{ ...channel, enabled: true }],
			}),
		).toMatchObject({ status: "admitted", channels: [channel] });
		expect(
			await a.channelAdmission.admitChannels({
				...request,
				current: [channel],
				requested: [],
			}),
		).toMatchObject({ status: "admitted", channels: [channel] });
		expect(
			await a.channelAdmission.admitChannels({
				...request,
				agentId: "agent-other",
				current: [channel],
				requested: [],
			}),
		).toMatchObject({ status: "rejected" });
		expect(
			await a.channelAdmission.admitChannels({
				...request,
				current: [],
				requested: [
					{
						kind: "wecom_bot",
						enabled: true,
						bindingReference: "not-registered",
					},
				],
			}),
		).toMatchObject({ status: "rejected" });
		const otherActor = createDeploymentAdmissionsV1({
			...f.input,
			currentIdentity: async () => ({ ...actor, userId: "bob" }),
		});
		expect(
			await otherActor.channelAdmission.admitChannels({
				...request,
				current: [channel],
				requested: [],
			}),
		).toMatchObject({ status: "rejected" });
		expect(
			await a.channelAdmission.admitChannels({
				...request,
				current: [channel],
				requested: [{ kind: "wecom_bot", enabled: false }],
			}),
		).toMatchObject({ status: "admitted", channels: [] });
	});

	it("binds empty-channel evidence to the actual deployment policy and Agent", async () => {
		const f = fixture();
		const admit = (policy: string, agentId: string = request.agentId) =>
			createDeploymentAdmissionsV1({
				...f.input,
				channelPolicy: { revision: policy, bindings: [] },
			}).channelAdmission.admitChannels({
				...request,
				agentId,
				current: [],
				requested: [],
			});
		const first = await admit("policy-a");
		const changed = await admit("policy-b");
		const other = await admit("policy-a", "agent-b");
		if (
			first.status !== "admitted" ||
			changed.status !== "admitted" ||
			other.status !== "admitted"
		)
			throw new Error();
		expect(first.channels).toEqual([]);
		expect(first.channelRevision).not.toBe(changed.channelRevision);
		expect(first.channelRevision).not.toBe(other.channelRevision);
	});

	it.each([
		"model-revision",
		"channel-revision",
		"policy",
		"unpinned",
		"duplicate-template",
		"invalid-binding",
	])("rejects invalid deployment configuration: %s", (kind) => {
		const f = fixture();
		const template = f.input.templates[0];
		if (!template) throw new Error();
		const input: DeploymentAdmissionInputV1 = {
			...f.input,
			...(kind === "model-revision"
				? { modelCatalog: { ...f.input.modelCatalog, revision: "" } }
				: {}),
			...(kind === "channel-revision"
				? { channelPolicy: { ...f.input.channelPolicy, revision: "" } }
				: {}),
			...(kind === "policy"
				? { registry: { ...f.input.registry, admissionPolicyRef: "" } }
				: {}),
			...(kind === "unpinned"
				? {
						templates: [
							{
								...template,
								imageReference: "registry.example.test/agents/codex:mutable",
							},
						],
					}
				: {}),
			...(kind === "duplicate-template"
				? { templates: [template, template] }
				: {}),
			...(kind === "invalid-binding"
				? {
						channelPolicy: {
							revision: "policy-a",
							bindings: [
								{
									kind: "wecom_bot",
									bindingReference: "bot-a",
									agentId: "agent-a",
									actorIds: [],
								},
							],
						},
					}
				: {}),
		};
		expect(() => createDeploymentAdmissionsV1(input)).toThrow(
			/^PLATFORM_DEPLOYMENT_ADMISSION_CONFIGURATION_INVALID$/,
		);
		expect(f.fetch).not.toHaveBeenCalled();
	});
});
