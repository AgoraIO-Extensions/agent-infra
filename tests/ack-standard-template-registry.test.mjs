import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseAllDocuments } from "yaml";
import { validateStandardTemplateRegistryDeploymentV1 } from "../deploy/ack/standard-template-registry-preflight.ts";
import { standardTemplateRegistryFromDeploymentV1 } from "../packages/image-registry/src/deployment.ts";
import { createOciImageRegistryAdapterV1 } from "../packages/image-registry/src/oci-image-registry.ts";

const registry = {
	endpoint: "https://registry.example.test",
	imageReferencePrefix: "registry.example.test",
	repositories: ["codex", "claude", "opencode", "pi"].map(
		(id) => `team/agent-runtime-${id}`,
	),
	authentication: {
		realm: "https://auth.example.test/service/token",
		service: "harbor-registry",
	},
	credentialsSecretRef: {
		name: "standard-template-admission",
		key: "identity.json",
	},
};

function render(values) {
	const directory = mkdtempSync(join(tmpdir(), "ack-registry-"));
	try {
		const file = join(directory, "values.json");
		writeFileSync(file, JSON.stringify(values), { mode: 0o600 });
		return parseAllDocuments(
			execFileSync(
				"helm",
				[
					"template",
					"agent-infra",
					"deploy/ack/chart",
					"-n",
					"agent-infra",
					"--kube-version",
					"v1.36.1",
					"-f",
					file,
				],
				{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
			),
		)
			.map((document) => {
				assert.equal(document.errors.length, 0);
				return document.toJSON();
			})
			.filter(Boolean);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

test("the formal chart gives only API and Worker the same read-only admission identity", () => {
	const documents = render({ standardTemplateRegistry: registry });
	const readers = [];
	for (const document of documents) {
		const pod = document.spec?.template?.spec;
		if (!pod) continue;
		const volume = pod.volumes?.find(
			(entry) => entry.secret?.secretName === "standard-template-admission",
		);
		if (!volume) continue;
		assert.equal(volume.secret.defaultMode, 0o440);
		assert.deepEqual(volume.secret.items, [
			{ key: "identity.json", path: "credentials.json" },
		]);
		for (const container of [
			...(pod.initContainers ?? []),
			...(pod.containers ?? []),
		]) {
			const mount = container.volumeMounts?.find(
				(entry) => entry.name === volume.name,
			);
			if (!mount) continue;
			readers.push(container.name);
			assert.equal(mount.readOnly, true);
			assert.equal(mount.subPath, undefined);
			assert.equal(
				mount.mountPath,
				"/var/run/agent-infra/standard-template-registry",
			);
			const configuration = JSON.parse(
				container.env.find(
					(entry) => entry.name === "AGENT_INFRA_STANDARD_TEMPLATE_REGISTRY",
				).value,
			);
			const { credentialsSecretRef: _, ...expected } = registry;
			assert.deepEqual(configuration, expected);
		}
	}
	assert.deepEqual(readers.sort(), ["platform-api", "platform-worker"]);
});

const currentTemplates = Object.fromEntries(
	["codex", "claude", "opencode", "pi"].map((id, index) => [
		id,
		{
			repository: `registry.example.test/team/agent-runtime-${id}`,
			digest: `sha256:${String(index + 1).repeat(64)}`,
		},
	]),
);
const retainedTemplate = {
	templateId: "claude",
	imageRepository: "registry.example.test/team/agent-runtime-claude",
	imageDigest: `sha256:${"5".repeat(64)}`,
};
function deploymentFixture() {
	const b64 = (text) => Buffer.from(text).toString("base64");
	const bindings = Object.entries(currentTemplates).map(
		([templateId, image]) => ({
			templateId,
			imageRepository: image.repository,
			imageDigest: image.digest,
		}),
	);
	const apiTemplates = bindings.map((binding) => ({
		...binding,
		imageReference: `${binding.imageRepository}@${binding.imageDigest}`,
	}));
	const custom = {
		endpoint: "https://ghcr.io",
		imageReferencePrefix: "ghcr.io",
	};
	const api = `export const apiInput={registry:${JSON.stringify(custom)},templates:${JSON.stringify(apiTemplates)}};`;
	const worker = `const templateModelBindings=${JSON.stringify([...bindings, retainedTemplate])};\nconst base={registry:${JSON.stringify(custom)},templateModelBindings,policy:{imagePullSecretName:"node-pull"}};export const workloadInput=base;`;
	const documents = render({
		standardTemplateRegistry: registry,
		configuration: {
			enabled: true,
			api: { "configuration.mjs": b64(api) },
			worker: { "configuration.mjs": b64(worker) },
		},
	});
	documents.push({
		kind: "Secret",
		metadata: { name: registry.credentialsSecretRef.name },
		data: {
			"identity.json": b64('{"username":"synthetic","password":"synthetic"}'),
		},
	});
	return {
		documents,
		namespace: "agent-infra",
		imagePullSecretName: "node-pull",
		binding: registry,
		currentTemplates,
		retainedTemplates: [retainedTemplate],
	};
}

test("formal deployment preflight accepts matching consumer modules and their published current and retained references", () => {
	const receipt = validateStandardTemplateRegistryDeploymentV1(
		deploymentFixture(),
	);
	assert.equal(receipt.status, "passed", JSON.stringify(receipt));
	assert.equal(receipt.templateBindings, 5);
});

test("preflight permits unrelated production configuration and pure release projections", async () => {
	const fixture = deploymentFixture();
	for (const role of ["api", "worker"]) {
		const configuration = fixture.documents.find(
			(document) =>
				document.kind === "Secret" &&
				document.metadata.labels?.["app.kubernetes.io/component"] ===
					`platform-${role}` &&
				document.data?.["configuration.mjs"],
		);
		const suffix =
			role === "api"
				? "\napiInput.connectionConsumerRegistration={enabled:false};export const release=apiInput.templates.map(t=>({...t}));"
				: '\nworkloadInput.policy.imagePullSecretName="node-pull";export const retained=workloadInput.templateModelBindings.map(t=>({...t}));';
		const source =
			Buffer.from(
				configuration.data["configuration.mjs"],
				"base64",
			).toString() + suffix;
		configuration.data["configuration.mjs"] =
			Buffer.from(source).toString("base64");
		await import(
			`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
		);
	}
	assert.equal(
		validateStandardTemplateRegistryDeploymentV1(fixture).status,
		"passed",
	);
});

test("a Session cannot carry the application admission Secret even as an unmounted volume", () => {
	const fixture = deploymentFixture();
	fixture.documents.push({
		kind: "Pod",
		metadata: { name: "synthetic-session" },
		spec: {
			imagePullSecrets: [{ name: "node-pull-identity" }],
			volumes: [
				{
					name: "leaked-identity",
					secret: { secretName: registry.credentialsSecretRef.name },
				},
			],
			containers: [
				{
					name: "runtime-host",
					image: `registry.example.test/runtime@sha256:${"9".repeat(64)}`,
				},
			],
		},
	});
	assert.equal(
		validateStandardTemplateRegistryDeploymentV1(fixture).status,
		"failed",
	);
});

test("preflight refuses a referenced identity key absent from the rendered Secret", () => {
	const fixture = deploymentFixture();
	fixture.documents.find(
		(document) =>
			document.kind === "Secret" &&
			document.metadata.name === registry.credentialsSecretRef.name,
	).data = {};
	assert.equal(
		validateStandardTemplateRegistryDeploymentV1(fixture).status,
		"failed",
	);
});

test("Worker-generated Sessions cannot select the application admission identity for node pulls", () => {
	const fixture = deploymentFixture();
	const configuration = fixture.documents.find(
		(document) =>
			document.kind === "Secret" &&
			document.metadata.labels?.["app.kubernetes.io/component"] ===
				"platform-worker" &&
			document.data?.["configuration.mjs"],
	);
	const source = Buffer.from(configuration.data["configuration.mjs"], "base64")
		.toString()
		.replace(
			'imagePullSecretName:"node-pull"',
			`imagePullSecretName:"${registry.credentialsSecretRef.name}"`,
		);
	configuration.data["configuration.mjs"] =
		Buffer.from(source).toString("base64");
	const receipt = validateStandardTemplateRegistryDeploymentV1(fixture);
	assert.equal(receipt.status, "failed");
	assert.equal(receipt.consumer, "worker");
});

for (const [name, mutation] of [
	[
		"bracket property assignment",
		`workloadInput.policy["imagePullSecretName"]="${registry.credentialsSecretRef.name}";`,
	],
	[
		"whole policy replacement",
		`workloadInput.policy={imagePullSecretName:"${registry.credentialsSecretRef.name}"};`,
	],
]) {
	test(`Worker preflight rejects ${name}`, () => {
		const fixture = deploymentFixture();
		const configuration = fixture.documents.find(
			(document) =>
				document.kind === "Secret" &&
				document.metadata.labels?.["app.kubernetes.io/component"] ===
					"platform-worker" &&
				document.data?.["configuration.mjs"],
		);
		const source =
			Buffer.from(
				configuration.data["configuration.mjs"],
				"base64",
			).toString() +
			"\n" +
			mutation;
		configuration.data["configuration.mjs"] =
			Buffer.from(source).toString("base64");
		const receipt = validateStandardTemplateRegistryDeploymentV1(fixture);
		assert.equal(receipt.status, "failed");
		assert.equal(receipt.consumer, "worker");
	});
}

for (const [name, mutate, consumer] of [
	[
		"only Worker switches Registry",
		(fixture) => {
			const worker = fixture.documents.find(
				(document) =>
					document.metadata?.name === "agent-infra-worker" &&
					document.kind === "Deployment",
			);
			worker.spec.template.spec.containers[0].env =
				worker.spec.template.spec.containers[0].env.filter(
					(entry) => entry.name !== "AGENT_INFRA_STANDARD_TEMPLATE_REGISTRY",
				);
		},
		"worker",
	],
	[
		"Registry prefix differs from its endpoint",
		(fixture) => {
			fixture.binding = {
				...fixture.binding,
				imageReferencePrefix: "wrong.example.test",
			};
		},
		"shared",
	],
	[
		"API Secret reference is missing",
		(fixture) => {
			const api = fixture.documents.find(
				(document) =>
					document.metadata?.name === "agent-infra-api" &&
					document.kind === "Deployment",
			);
			api.spec.template.spec.volumes = api.spec.template.spec.volumes.filter(
				(entry) =>
					entry.secret?.secretName !== registry.credentialsSecretRef.name,
			);
		},
		"api",
	],
	[
		"API template repository is wrong",
		(fixture) => {
			const configuration = fixture.documents.find(
				(document) =>
					document.kind === "Secret" &&
					document.metadata.labels?.["app.kubernetes.io/component"] ===
						"platform-api" &&
					document.data?.["configuration.mjs"],
			);
			configuration.data["configuration.mjs"] = Buffer.from(
				Buffer.from(configuration.data["configuration.mjs"], "base64")
					.toString()
					.replace(
						'"imageReference":"registry.example.test/team/agent-runtime-codex@',
						'"imageReference":"registry.example.test/unapproved/codex@',
					),
			).toString("base64");
		},
		"api",
	],
	[
		"retained Worker digest has no release receipt",
		(fixture) => {
			fixture.retainedTemplates = [];
		},
		"worker",
	],
	[
		"API loads another configuration module",
		(fixture) => {
			const api = fixture.documents.find(
				(document) =>
					document.metadata?.name === "agent-infra-api" &&
					document.kind === "Deployment",
			);
			api.spec.template.spec.containers[0].env.find(
				(entry) => entry.name === "PLATFORM_API_CONFIGURATION_MODULE",
			).value = "file:///other/configuration.mjs";
		},
		"api",
	],
]) {
	test(`preflight refuses ${name} without including private input in the diagnostic`, () => {
		const fixture = deploymentFixture();
		mutate(fixture);
		const receipt = validateStandardTemplateRegistryDeploymentV1(fixture);
		assert.equal(receipt.status, "failed");
		assert.equal(receipt.consumer, consumer);
		assert.doesNotMatch(
			JSON.stringify(receipt),
			/password|username|Basic|Bearer/u,
		);
	});
}

for (const [name, change] of [
	[
		"root accessor",
		(source) =>
			source.replace(
				/\};$/u,
				',get deferred(){this.templates[0].imageReference="registry.example.test/wrong/codex";return false;}};',
			),
	],
	[
		"tagged template call",
		(source) =>
			`${source}\nfunction update(parts,templates){templates[0].imageReference="registry.example.test/wrong/codex";}update\`\${apiInput.templates}\`;`,
	],
	[
		"tagged template in release projection",
		(source) =>
			`${source}\nfunction update(parts,template){template.imageReference="registry.example.test/wrong/codex";}apiInput.templates.map(template=>update\`\${template}\`);`,
	],
	[
		"later template mutation",
		(source) =>
			`${source}\napiInput.templates[0].imageReference="registry.example.test/wrong/codex@${currentTemplates.codex.digest}";`,
	],
	[
		"computed override",
		(source) =>
			source
				.replace("templates:", '["templates"]:[],templates:')
				.replace("templates:", "templates:"),
	],
	[
		"computed final override",
		(source) => source.replace(/\};$/u, ',["templates"]:[]};'),
	],
	[
		"conflicting module Registry",
		(source) =>
			source.replace(
				'"endpoint":"https://ghcr.io"',
				'"standardTemplates":{},"endpoint":"https://ghcr.io"',
			),
	],
	[
		"alternate export",
		(source) =>
			source.replace("export const apiInput", "const apiInput") +
			"\nconst other={...apiInput,templates:[]};export {other as apiInput};",
	],
	[
		"mutating alias",
		(source) =>
			`${source}\nconst selected=apiInput.templates;selected[0].imageReference="registry.example.test/wrong/codex@${currentTemplates.codex.digest}";`,
	],
	[
		"destructured alias",
		(source) =>
			`${source}\nconst {templates}=apiInput;templates[0].imageReference="registry.example.test/wrong/codex@${currentTemplates.codex.digest}";`,
	],
	[
		"mutating loop",
		(source) =>
			`${source}\nfor(const template of apiInput.templates)template.imageReference="registry.example.test/wrong/codex@${currentTemplates.codex.digest}";`,
	],
]) {
	test(`preflight rejects unsupported ${name} in the effective module`, async () => {
		const fixture = deploymentFixture();
		const configuration = fixture.documents.find(
			(document) =>
				document.kind === "Secret" &&
				document.metadata.labels?.["app.kubernetes.io/component"] ===
					"platform-api" &&
				document.data?.["configuration.mjs"],
		);
		const source = change(
			Buffer.from(configuration.data["configuration.mjs"], "base64").toString(),
		);
		configuration.data["configuration.mjs"] =
			Buffer.from(source).toString("base64");
		const actual = await import(
			`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
		);
		assert.ok(actual.apiInput);
		assert.equal(
			validateStandardTemplateRegistryDeploymentV1(fixture).status,
			"failed",
		);
	});
}

test("rendered API and Worker bindings admit all current templates and the original retained digest", async () => {
	const directory = mkdtempSync(join(tmpdir(), "ack-registry-identity-"));
	try {
		const identity = join(directory, "identity.json");
		writeFileSync(
			identity,
			JSON.stringify({
				username: "synthetic-reader",
				password: "synthetic-password",
			}),
			{ mode: 0o600 },
		);
		const digest = (body) =>
			`sha256:${createHash("sha256").update(body).digest("hex")}`;
		const config = JSON.stringify({
			os: "linux",
			architecture: "amd64",
			config: {
				Labels: {
					"io.agora.agent.runtime.manifest": JSON.stringify({
						schemaVersion: 1,
						interactionMode: "platform-adapter",
						protocol: "acp",
						service: { port: 8080 },
						health: { path: "/healthz" },
						capabilities: { modelSelection: true },
					}),
				},
			},
		});
		const manifest = JSON.stringify({
			schemaVersion: 2,
			mediaType: "application/vnd.oci.image.manifest.v1+json",
			config: {
				mediaType: "application/vnd.oci.image.config.v1+json",
				digest: digest(config),
				size: Buffer.byteLength(config),
			},
			layers: [],
		});
		const retained = manifest.replace(
			'"layers":[]',
			'"layers":[],"retained":true',
		);
		const requests = [];
		for (const role of ["api", "worker"]) {
			const pod = render({ standardTemplateRegistry: registry }).find(
				(document) =>
					document.kind === "Deployment" &&
					document.metadata.name === `agent-infra-${role}`,
			).spec.template.spec;
			const raw = pod.containers[0].env.find(
				(entry) => entry.name === "AGENT_INFRA_STANDARD_TEMPLATE_REGISTRY",
			).value;
			const adapter = createOciImageRegistryAdapterV1({
				endpoint: "https://ghcr.io",
				imageReferencePrefix: "ghcr.io",
				standardTemplates: standardTemplateRegistryFromDeploymentV1(
					raw,
					identity,
				),
				policy: {
					authorize: async () => ({
						status: "admitted",
						decisionRef: "synthetic-policy",
						evaluatedAt: "2026-11-26T00:00:00Z",
					}),
				},
				fetch: async (url, init) => {
					const target = new URL(url);
					const auth = new Headers(init.headers).get("authorization");
					requests.push({ role, origin: target.origin, auth });
					if (target.origin === "https://auth.example.test") {
						assert.equal(
							auth,
							`Basic ${Buffer.from("synthetic-reader:synthetic-password").toString("base64")}`,
						);
						assert.ok(
							registry.repositories.some(
								(repository) =>
									target.searchParams.get("scope") ===
									`repository:${repository}:pull`,
							),
						);
						return Response.json({ token: "synthetic-bearer" });
					}
					if (target.origin === "https://registry.example.test" && !auth)
						return new Response(null, {
							status: 401,
							headers: {
								"www-authenticate": `Bearer realm="${registry.authentication.realm}",service="harbor-registry",scope="repository:${target.pathname.slice(4).replace(/\/(?:manifests|blobs)\/.*$/u, "")}:pull"`,
							},
						});
					if (target.origin === "https://registry.example.test")
						assert.equal(auth, "Bearer synthetic-bearer");
					else {
						assert.equal(target.origin, "https://ghcr.io");
						assert.equal(auth, null);
					}
					const body = target.pathname.includes("/blobs/")
						? config
						: decodeURIComponent(target.pathname).endsWith(digest(retained))
							? retained
							: manifest;
					return new Response(body, {
						headers: {
							"content-type": target.pathname.includes("/blobs/")
								? "application/vnd.oci.image.config.v1+json"
								: "application/vnd.oci.image.manifest.v1+json",
							"docker-content-digest": digest(body),
						},
					});
				},
			});
			for (const repository of registry.repositories) {
				const result = await adapter.admit({
					schemaVersion: 1,
					requestId: "request-1",
					traceId: "trace-1",
					subjectRef: "subject-1",
					agentId: "agent-1",
					imageReference: `${registry.imageReferencePrefix}/${repository}@${digest(manifest)}`,
					usage: "standard-template",
					admissionPolicyRef: "policy-1",
				});
				assert.equal(result.status, "admitted");
			}
			if (role === "worker") {
				const result = await adapter.admit({
					schemaVersion: 1,
					requestId: "request-old",
					traceId: "trace-old",
					subjectRef: "subject-1",
					agentId: "agent-1",
					imageReference: `${registry.imageReferencePrefix}/team/agent-runtime-claude@${digest(retained)}`,
					usage: "standard-template",
					admissionPolicyRef: "policy-1",
				});
				assert.equal(result.status, "admitted");
				assert.equal(result.immutableDigest, digest(retained));
			}
			const custom = await adapter.admit({
				schemaVersion: 1,
				requestId: "request-custom",
				traceId: "trace-custom",
				subjectRef: "subject-1",
				agentId: "agent-1",
				imageReference: `ghcr.io/custom/agent@${digest(manifest)}`,
				usage: "custom-agent",
				admissionPolicyRef: "policy-1",
			});
			assert.equal(custom.status, "admitted");
		}
		assert.ok(
			requests.some(
				(request) =>
					request.role === "api" && request.auth === "Bearer synthetic-bearer",
			),
		);
		assert.ok(
			requests.some(
				(request) =>
					request.role === "worker" &&
					request.auth === "Bearer synthetic-bearer",
			),
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
