import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	connectionConsumerProfileFingerprintV1,
	connectionSystemAccessFingerprintV1,
} from "@agent-infra/contracts/connection-consumer-profile";
import { runtimeOAuthConfigurationRevisionV1 } from "@agent-infra/contracts/runtime/oauth-installation-node";
import {
	captureConnectionConsumerRegisteredBindingV1,
	planConnectionConsumerRegistrationV1,
} from "@agent-infra/platform-core";
import { build, transform } from "esbuild";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
	workloadDesiredFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import {
	sessionSandboxDeploymentTokenFixture,
	sessionSandboxModelProjectionFixture,
	sessionSandboxRuntimeAuthFixture,
	sessionSandboxTemplateBindingFixture,
} from "./test-support/session-sandbox-v4.js";
import { workloadResourceConfigurationHashV1 } from "./workload-runtime.js";

vi.setConfig({ testTimeout: 15_000 });

let directory: string;
const platformStoreDistPath = new URL(
	"../../../packages/platform-store/dist/index.mjs",
	import.meta.url,
).pathname;
let platformStoreDistOriginal: string | undefined;
const connectionConsumerProfile = {
	schemaVersion: 1,
	publicOrigin: "https://connection.example.test",
	mcpPath: "/mcp/v1",
	consumerId: "platform-worker",
	audience: "connection-api",
	egressProfile: { ref: "egress-platform", revision: "r1" },
};
const connectionConsumerApproval = {
	schemaVersion: 1,
	configFingerprint:
		"26062a8f8e5a003ff8047fead83d76c254d9b54834ca5348fb7e4ceee67d205b",
	egressEnforced: true,
	source: { ref: "platform-deployment", revision: "r1" },
};
beforeAll(async () => {
	try {
		platformStoreDistOriginal = await readFile(platformStoreDistPath, "utf8");
	} catch {
		platformStoreDistOriginal = undefined;
	}
	await mkdir(dirname(platformStoreDistPath), { recursive: true });
	if (platformStoreDistOriginal === undefined)
		await writeFile(
			platformStoreDistPath,
			`${[
				"export class PostgresConversationQueryV1 { constructor() {} close() { return Promise.resolve(); } }",
				"export class PostgresAgentDefaultRelayKeyStoreV1 {}",
				"export class PostgresRelayKeyVersionStoreV1 {}",
				"export class PostgresAgentConfigurationQueryV1 { async readSessionMaintenanceBinding() { return null; } async close() {} }",
				"export class PostgresAgentConfigurationTransactionV1 {}",
				"export class PostgresWecomConnectionsV1 {}",
				"export class PostgresWecomSetupV1 {}",
				"export class PostgresConversationExecutionTransactionV1 {}",
				"export class PostgresConnectionInstallationAuthorizationTransactionV1 {}",
				"export const validateWecomSetupCredentialRecordV1 = () => ({})",
				"export const openPostgresWorkloadStateReaderV1 = () => ({ close: async () => {}, readCurrentState: async () => null })",
			].join("\n")}\n`,
		);
	directory = await mkdtemp(join(tmpdir(), "worker-binding-"));
	await writeFile(
		join(directory, "session-reserve-adapter.js"),
		"export const createSessionSandboxReserveAdapterV1 = (options) => ({ input: options });\n",
	);

	await writeFile(
		join(directory, "kubernetes-client.js"),
		"export const createWorkerKubernetesClientV1 = (namespace) => ({ namespace }); export class WorkloadKubernetesError extends Error {}",
	);
	const source = await readFile(
		new URL("./deployment-entry.ts", import.meta.url),
		"utf8",
	);
	const { code } = await transform(source, {
		loader: "ts",
		format: "esm",
		target: "node24",
	});
	for (const name of [
		"hostname-route-configuration",
		"sig-core-sdk-trial",
		"workload-resource-name",
		"skill-sync-failure",
	]) {
		const compiled = await transform(
			await readFile(new URL("./" + name + ".ts", import.meta.url), "utf8"),
			{ loader: "ts", format: "esm", target: "node24" },
		);
		await writeFile(join(directory, name + ".js"), compiled.code);
	}
	const materializerAssembly = await transform(
		await readFile(
			new URL("./skill-materializer-assembly.ts", import.meta.url),
			"utf8",
		),
		{
			loader: "ts",
			format: "esm",
			target: "node24",
		},
	);
	const materialization = await transform(
		await readFile(
			new URL("./skill-materialization.ts", import.meta.url),
			"utf8",
		),
		{
			loader: "ts",
			format: "esm",
			target: "node24",
		},
	);
	const materializerProductionAssembly = await transform(
		await readFile(
			new URL("./skill-materializer-production-assembly.ts", import.meta.url),
			"utf8",
		),
		{
			loader: "ts",
			format: "esm",
			target: "node24",
		},
	);
	const materializerStoreAdapter = await transform(
		await readFile(
			new URL("./skill-materializer-store-adapter.ts", import.meta.url),
			"utf8",
		),
		{
			loader: "ts",
			format: "esm",
			target: "node24",
		},
	);
	const nativeMetadataAssembly = await transform(
		await readFile(
			new URL("./native-metadata-deployment-assembly.ts", import.meta.url),
			"utf8",
		),
		{
			loader: "ts",
			format: "esm",
			target: "node24",
		},
	);
	const nativeMetadataProof = await transform(
		await readFile(
			new URL("./runtime-native-metadata-proof.ts", import.meta.url),
			"utf8",
		),
		{
			loader: "ts",
			format: "esm",
			target: "node24",
		},
	);
	const nativeMetadataGateway = await transform(
		await readFile(
			new URL("./runtime-native-metadata-gateway.ts", import.meta.url),
			"utf8",
		),
		{
			loader: "ts",
			format: "esm",
			target: "node24",
		},
	);
	const modelDirectoryDeployment = await transform(
		await readFile(
			new URL("./runtime-model-directory-deployment.ts", import.meta.url),
			"utf8",
		),
		{
			loader: "ts",
			format: "esm",
			target: "node24",
		},
	);
	const modelDirectoryService = await transform(
		await readFile(
			new URL("./runtime-model-directory-service.ts", import.meta.url),
			"utf8",
		),
		{
			loader: "ts",
			format: "esm",
			target: "node24",
		},
	);
	const runtimeMetadataServer = await transform(
		await readFile(
			new URL("./runtime-native-metadata-server.ts", import.meta.url),
			"utf8",
		),
		{
			loader: "ts",
			format: "esm",
			target: "node24",
		},
	);
	const nativeMetadataCurrentClient = await transform(
		await readFile(
			new URL("./runtime-native-metadata-current-client.ts", import.meta.url),
			"utf8",
		),
		{
			loader: "ts",
			format: "esm",
			target: "node24",
		},
	);
	const nativeMetadataClient = await transform(
		await readFile(
			new URL("./runtime-native-metadata-client.ts", import.meta.url),
			"utf8",
		),
		{
			loader: "ts",
			format: "esm",
			target: "node24",
		},
	);
	const savedKeyCandidatesProduction = await transform(
		await readFile(
			new URL("./saved-key-candidates-production.ts", import.meta.url),
			"utf8",
		),
		{
			loader: "ts",
			format: "esm",
			target: "node24",
		},
	);
	const savedKeyCandidatesService = await transform(
		await readFile(
			new URL("./saved-key-candidates-service.ts", import.meta.url),
			"utf8",
		),
		{
			loader: "ts",
			format: "esm",
			target: "node24",
		},
	);
	await build({
		entryPoints: [
			new URL("./kubernetes-runtime-comparison.ts", import.meta.url).pathname,
		],
		bundle: true,
		packages: "external",
		platform: "node",
		format: "esm",
		outfile: join(directory, "kubernetes-runtime-comparison.js"),
	});
	await build({
		entryPoints: [new URL("./skill-hub-delivery.ts", import.meta.url).pathname],
		bundle: true,
		packages: "external",
		platform: "node",
		format: "esm",
		outfile: join(directory, "skill-hub-delivery.js"),
	});
	await build({
		entryPoints: [
			new URL("./codex-session-executor.ts", import.meta.url).pathname,
		],
		bundle: true,
		packages: "external",
		platform: "node",
		format: "esm",
		outfile: join(directory, "codex-session-executor.js"),
	});
	await build({
		entryPoints: [
			new URL("./agent-workload-placement.ts", import.meta.url).pathname,
		],
		bundle: true,
		packages: "external",
		platform: "node",
		format: "esm",
		outfile: join(directory, "agent-workload-placement.js"),
	});
	for (const name of [
		"maintenance-session-view",
		"maintenance-terminal-gateway",
	]) {
		await build({
			entryPoints: [new URL("./" + name + ".ts", import.meta.url).pathname],
			bundle: true,
			packages: "external",
			platform: "node",
			format: "esm",
			outfile: join(directory, name + ".js"),
		});
	}
	await writeFile(join(directory, "package.json"), '{"type":"module"}');
	await writeFile(join(directory, "deployment.mjs"), code);
	await writeFile(
		join(directory, "skill-materializer-assembly.js"),
		materializerAssembly.code,
	);
	await writeFile(
		join(directory, "skill-materialization.js"),
		materialization.code,
	);
	await writeFile(
		join(directory, "skill-materializer-production-assembly.js"),
		materializerProductionAssembly.code,
	);
	await writeFile(
		join(directory, "skill-materializer-store-adapter.js"),
		materializerStoreAdapter.code,
	);
	await writeFile(
		join(directory, "native-metadata-deployment-assembly.js"),
		nativeMetadataAssembly.code,
	);
	// The deployment-entry fixture loads the assembly module without enabling
	// native metadata. Keep its deployment graph self-contained while still
	// satisfying the assembly's token-derivation import.
	await writeFile(
		join(directory, "session-workload-adapter.js"),
		`export const sessionSandboxServiceTokenV1 = () => 'fixture-sandbox-token';
export const isNativeMetadataWorkerOriginV1 = (value) => {
  if (typeof value !== 'string') return false;
  try {
    const origin = new URL(value);
    const releaseScopedService = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?-platform-worker-native-metadata$/.test(origin.hostname);
    return origin.protocol === 'http:' && origin.username === '' && origin.password === '' &&
      (origin.hostname === 'platform-worker-native-metadata' || releaseScopedService) &&
      (origin.port === '' || origin.port === '80') &&
      (origin.pathname === '/' || origin.pathname === '') && origin.search === '' && origin.hash === '';
  } catch { return false; }
};
`,
	);
	await writeFile(
		join(directory, "runtime-native-metadata-proof.js"),
		nativeMetadataProof.code,
	);
	await writeFile(
		join(directory, "runtime-native-metadata-gateway.js"),
		nativeMetadataGateway.code,
	);
	await writeFile(
		join(directory, "runtime-native-metadata-current-client.js"),
		nativeMetadataCurrentClient.code,
	);
	await writeFile(
		join(directory, "runtime-native-metadata-client.js"),
		nativeMetadataClient.code,
	);
	await writeFile(
		join(directory, "saved-key-candidates-production.js"),
		savedKeyCandidatesProduction.code,
	);
	await writeFile(
		join(directory, "saved-key-candidates-service.js"),
		savedKeyCandidatesService.code,
	);
	await writeFile(
		join(directory, "runtime-recovery-budget.js"),
		(
			await transform(
				await readFile(
					new URL("./runtime-recovery-budget.ts", import.meta.url),
					"utf8",
				),
				{ loader: "ts", format: "esm", target: "node24" },
			)
		).code,
	);
	await writeFile(
		join(directory, "runtime-model-directory-deployment.js"),
		modelDirectoryDeployment.code,
	);
	await writeFile(
		join(directory, "runtime-grant-signer.js"),
		"export const createWorkerRuntimeModelDirectoryGrantSignerV1 = () => () => ({ schemaVersion: 1, format: 'compact-jws', token: 'fixture' });\n",
	);
	await writeFile(
		join(directory, "runtime-host-client.js"),
		"export const createWorkerRuntimeHostClientV1 = () => ({});\n",
	);
	await writeFile(
		join(directory, "runtime-model-directory-service.js"),
		modelDirectoryService.code,
	);
	await writeFile(
		join(directory, "runtime-native-metadata-server.js"),
		runtimeMetadataServer.code,
	);
	await build({
		entryPoints: [
			new URL("./connection-consumer-projection.ts", import.meta.url).pathname,
		],
		bundle: true,
		packages: "external",
		platform: "node",
		format: "esm",
		outfile: join(directory, "connection-consumer-projection.js"),
	});
	await build({
		entryPoints: [
			new URL("./connection-registration-bindings.ts", import.meta.url)
				.pathname,
		],
		bundle: true,
		packages: "external",
		platform: "node",
		format: "esm",
		outfile: join(directory, "connection-registration-bindings.js"),
		plugins: [
			{
				name: "owned-registration-read-fixture",
				setup(builder) {
					builder.onResolve(
						{ filter: /^@agent-infra\/platform-store$/ },
						() => ({
							path: "registration-reader",
							namespace: "registration-fixture",
						}),
					);
					builder.onLoad(
						{ filter: /.*/, namespace: "registration-fixture" },
						() => ({
							contents: `
export class PostgresConnectionConsumerRegistrationStoreV1 {
 constructor(input) { globalThis.registrationDatabase = input.databaseUrl; }
 async registered() { globalThis.registrationReads = (globalThis.registrationReads ?? 0) + 1; return globalThis.registrations ?? {}; }
 async close() { globalThis.registrationCloses = (globalThis.registrationCloses ?? 0) + 1; }
}
export async function readConnectionConsumerSourceSelectionV1() {
 if(globalThis.sourceSelectionFailed) throw Error('controlled source unavailable');
 return structuredClone(globalThis.sourceSelection ?? {automaticAgentIds:[],legacyAgentIds:[]});
}
export class PostgresConnectionAssociationSourceV1 {
 constructor(input) { globalThis.associationSourceDatabase = input.databaseUrl; globalThis.associationSourceOpens = (globalThis.associationSourceOpens ?? 0) + 1; }
 async persistent(agentId) {
  (globalThis.associationReads ??= []).push(agentId);
  if (globalThis.associationSourceFailed) throw Error('controlled association source unavailable');
  return (globalThis.persistentConnectionAgents ?? []).includes(agentId);
 }
 async close() { globalThis.associationSourceCloses = (globalThis.associationSourceCloses ?? 0) + 1; if (process.env.ASSOCIATION_CLOSE_FAILS) throw Error('controlled association close failure'); }
}
`,
						}),
					);
				},
			},
		],
	});
	await build({
		entryPoints: [
			new URL(
				"./connection-installation-principal-bindings.ts",
				import.meta.url,
			).pathname,
		],
		bundle: true,
		packages: "external",
		platform: "node",
		format: "esm",
		outfile: join(directory, "connection-installation-principal-bindings.js"),
	});
	// The real Session image producer graph; only its own Store readers are a
	// recording fixture, so no database is contacted.
	await build({
		entryPoints: [
			new URL("./worker-session-demand-images.ts", import.meta.url).pathname,
		],
		bundle: true,
		packages: "external",
		platform: "node",
		format: "esm",
		outfile: join(directory, "worker-session-demand-images.js"),
		plugins: [
			{
				name: "session-image-store-fixture",
				setup(builder) {
					builder.onResolve(
						{ filter: /^@agent-infra\/platform-store$/ },
						(args) =>
							args.importer.endsWith("worker-session-demand-images.ts")
								? { path: "session-image-store", namespace: "session-store" }
								: undefined,
					);
					builder.onLoad({ filter: /.*/, namespace: "session-store" }, () => ({
						contents: `
export class PostgresAgentConfigurationQueryV1 {
 constructor(options) { (globalThis.sessionImageReaderUrls ??= []).push(options.databaseUrl); }
 async readCommittedTemplateReleases() { return []; }
 async close() { globalThis.sessionImageCloses = (globalThis.sessionImageCloses ?? 0) + 1; }
}
export function openPostgresSessionSandboxImageReaderV1(options) {
 (globalThis.sessionImageReaderUrls ??= []).push(options.databaseUrl);
 return {
  async read(namespace) {
   (globalThis.sessionImageReads ??= []).push(namespace);
   const value = globalThis.sessionImageReadback;
   return { ...value, items: value.items.map((item) => ({ metadata: item.metadata, workerProjectionInputs: () => item.inputs })) };
  },
  async close() { globalThis.sessionImageCloses = (globalThis.sessionImageCloses ?? 0) + 1; },
 };
}
export function openPostgresWorkspaceSnapshotMaterializationReaderV1() {
 return { async read() { throw new Error('snapshot metadata is not part of this fixture'); }, async close() {} };
}
`,
					}));
				},
			},
		],
	});
	// The real Agent Workload image producer graph; only its Store readers are a
	// recording fixture, so no database is contacted.
	await build({
		entryPoints: [
			new URL("./worker-agent-workload-demand-images.ts", import.meta.url)
				.pathname,
		],
		bundle: true,
		packages: "external",
		platform: "node",
		format: "esm",
		outfile: join(directory, "worker-agent-workload-demand-images.js"),
		plugins: [
			{
				name: "agent-workload-image-store-fixture",
				setup(builder) {
					builder.onResolve(
						{ filter: /^@agent-infra\/platform-store$/ },
						(args) =>
							args.importer.endsWith("worker-agent-workload-demand-images.ts")
								? { path: "agent-image-store", namespace: "agent-store" }
								: undefined,
					);
					builder.onLoad({ filter: /.*/, namespace: "agent-store" }, () => ({
						contents: `
const opened = (url) => (globalThis.agentImageReaderUrls ??= []).push(url);
const closed = async () => { globalThis.agentImageCloses = (globalThis.agentImageCloses ?? 0) + 1; };
const observed = () => globalThis.agentImageObservation;
export class PostgresAgentManagementQueryV1 {
 constructor(options) { opened(options.databaseUrl); }
 async getAgent(scope, agentId) { (globalThis.agentImageReads ??= []).push(agentId); return { management: observed().management }; }
 close() { return closed(); }
}
export class PostgresAgentConfigurationQueryV1 {
 constructor(options) { opened(options.databaseUrl); }
 async read(input) { (globalThis.agentImageActors ??= []).push(input.actorId); return { outcome: 'found', configuration: observed().configuration }; }
 close() { return closed(); }
}
export function openPostgresWorkloadStateReaderV1(options) {
 opened(options.databaseUrl);
 return { async readCurrentState() { return observed().state; }, close: closed };
}
export function openPostgresWorkspaceSnapshotMaterializationReaderV1() {
 return { async read() { throw new Error('snapshot metadata is not part of this fixture'); }, close: closed };
}
`,
					}));
				},
			},
		],
	});
	await symlink(
		new URL("../node_modules", import.meta.url).pathname,
		join(directory, "node_modules"),
		"dir",
	);
	await writeFile(
		join(directory, "configuration.mjs"),
		`
export const workloadInput = { databaseUrl: 'postgresql://stale.example.test/stale', policy: { namespace: 'worker-binding' } };
export const signing = { workerId: 'worker' };
export const connectionConsumerProfile = ${JSON.stringify(connectionConsumerProfile)};
export const connectionConsumerApproval = ${JSON.stringify(connectionConsumerApproval)};
`,
	);
	await writeFile(
		join(directory, "workload-deployment.js"),
		`
export const createWorkloadReadinessAuthorizationV1 = () => { globalThis.calls.push('readiness'); };
export const createProductionWorkloadWorkerOptionsV1 = async (input) => { globalThis.calls.push('workload'); globalThis.fileExchange = { origin: input.policy.runtimeAuth?.fileExchangeOrigin ?? null, egress: input.policy.fileExchangeEgress ?? null }; globalThis.snapshot = input.policy.connectionConsumerSnapshot; globalThis.installation = input.policy.connectionInstallationRevision; globalThis.snapshots = input.policy.connectionConsumerSnapshotsByAgent; globalThis.installations = input.policy.connectionInstallationRevisionsByAgent; globalThis.publication = input.policy.connectionInstallationOAuthPublication; globalThis.publications = input.policy.connectionInstallationOAuthPublicationsByAgent; return input; };
`,
	);
	await writeFile(
		join(directory, "workload-runtime.js"),
		`export const workloadResourceConfigurationHashV1 = () => 'synthetic-hash';
export const createWorkloadReadinessLedgerV1 = () => ({});`,
	);
	await writeFile(
		join(directory, "conversation-deployment.js"),
		`
export const createProductionConversationRuntimeResolverV2 = (input) => { globalThis.calls.push('conversation'); globalThis.connection = { profile: input.connectionConsumerProfile, approval: input.connectionConsumerApproval }; return async () => 'original-control'; };
export const createProductionSessionSandboxReceiverV1 = (workload, options) => { globalThis.calls.push('sandbox'); globalThis.oauthProvisioning = options.oauthProvisioning ?? null; globalThis.manualBootstrap = options.connectionInstallBootstrap; globalThis.manualPublication = options.connectionManualPublication; return async () => ({ status: 'observed', resources: [] }); };
`,
	);
	await writeFile(
		join(directory, "wecom-deployment.js"),
		`
export const createWecomDeploymentCoordinatorV1 = (input) => { globalThis.calls.push('wecom'); globalThis.wecomDatabase = input.databaseUrl; return {}; };
`,
	);
	// #4199 C2: the real Worker assembly of the exception route.
	await build({
		entryPoints: [
			new URL("./connection-manual-installation-deployment.ts", import.meta.url)
				.pathname,
		],
		bundle: true,
		packages: "external",
		platform: "node",
		format: "esm",
		outfile: join(directory, "connection-manual-installation-deployment.js"),
	});
	// #4199 C2: the real publication contract parser and projection decision.
	await build({
		entryPoints: [
			new URL("./connection-manual-publication.ts", import.meta.url).pathname,
		],
		bundle: true,
		packages: "external",
		platform: "node",
		format: "esm",
		outfile: join(directory, "connection-manual-publication.js"),
	});
	// #3289：使用真实的 origin/egress 解析，覆盖写入任何 Kubernetes 资源之前的配置拒绝。
	await build({
		entryPoints: [
			new URL("./workload-runtime-auth.ts", import.meta.url).pathname,
		],
		bundle: true,
		packages: "external",
		platform: "node",
		format: "esm",
		outfile: join(directory, "workload-runtime-auth.js"),
	});
	await writeFile(
		join(directory, "run.mjs"),
		`
globalThis.calls = [];
try {
 const entry = await import('./deployment.mjs');
 if (process.env.RUN_MUTATE_SUPPLY === 'true') {
   const configuration = await import('./configuration.mjs');
   configuration.connectionInstallationSupply.ref = 'mutated';
   configuration.connectionInstallationSupply.revision = 'r99';
 }
 const signal = new AbortController().signal;
 if (process.env.RUN_HOSTNAME_POLICY === 'true') {
   const options = await entry.createPlatformWorkloadWorkerOptionsV1(signal);
   console.log(JSON.stringify({ calls:globalThis.calls, namespace:options.policy.namespace, routeHostSuffix:options.policy.routeHostSuffix, tlsSecretName:options.policy.tlsSecretName, hostnameRoutes:options.policy.hostnameRoutes ?? null }));
   process.exit(0);
 }
 if (process.env.RUN_AGENT_WORKLOAD_IMAGES) {
   const fixture = JSON.parse(process.env.RUN_AGENT_WORKLOAD_IMAGES);
   globalThis.agentImageObservation = fixture.observed;
   let result;
   try { result = { receipt: await entry.readPlatformAgentWorkloadDemandImagesV1(fixture.request) }; }
   catch (error) { result = { error: error.message }; }
   console.log(JSON.stringify({ ...result, calls: globalThis.calls, readerUrls: globalThis.agentImageReaderUrls ?? [], reads: globalThis.agentImageReads ?? [], actors: globalThis.agentImageActors ?? [], closes: globalThis.agentImageCloses ?? 0 }));
   process.exit(0);
 }
 if (process.env.RUN_SESSION_IMAGES) {
   const fixture = JSON.parse(process.env.RUN_SESSION_IMAGES);
   globalThis.sessionImageReadback = fixture.readback;
   let result;
   try { result = { receipt: await entry.readPlatformSessionDemandImagesV1(fixture.request) }; }
   catch (error) { result = { error: error.message }; }
   console.log(JSON.stringify({ ...result, calls: globalThis.calls, readerUrls: globalThis.sessionImageReaderUrls ?? [], reads: globalThis.sessionImageReads ?? [], closes: globalThis.sessionImageCloses ?? 0, registrationReads: globalThis.registrationReads ?? 0 }));
   process.exit(0);
 }
 if (process.env.RUN_NATIVE_PORTS === 'true') {
   const options = await entry.createPlatformNativeMetadataGatewayOptionsV1(signal);
   console.log(JSON.stringify(options?.ports ?? null));
   process.exit(0);
 }
 if (process.env.RUN_RESERVE_DELIVERY) {
   // #4157: the reserve adapter receives the Worker workload with the current-source check.
   const fixture = JSON.parse(process.env.RUN_RESERVE_DELIVERY);
   if (fixture.selection) globalThis.sourceSelection = fixture.selection;
   const reserves = await entry.createPlatformSessionReserveWorkerOptionsV1(signal);
   const workload = reserves.adapter.input.workload;
   const current = workload.connectionDeliveryCurrent;
   const results = {};
   const check = async (label, agentId) => {
     try { results[label] = await current(agentId); } catch { results[label] = 'rejected'; }
   };
   if (typeof current === 'function') {
     for (const agentId of fixture.agents) await check('before:' + agentId, agentId);
     globalThis.persistentConnectionAgents = fixture.agents;
     for (const agentId of fixture.agents) await check('associated:' + agentId, agentId);
     globalThis.associationSourceFailed = true;
     for (const agentId of fixture.agents) await check('failed:' + agentId, agentId);
   }
   const sameWorkload = workload === (await entry.createPlatformWorkloadWorkerOptionsV1(signal));
   console.log(JSON.stringify({ guard: typeof current, results, reads: globalThis.associationReads ?? [], opens: globalThis.associationSourceOpens ?? 0, database: globalThis.associationSourceDatabase ?? null, sameWorkload }));
   process.exit(0);
 }
 if (process.env.RUN_RESERVE_OPTIONS === "true") {
   const reserves = await entry.createPlatformSessionReserveWorkerOptionsV1(signal);
   console.log(JSON.stringify({ configured: reserves !== undefined, namespace: reserves?.configuration.namespace, revision: reserves?.configuration.revision, enabled: reserves?.configuration.enabled, databaseUrl: reserves?.databaseUrl }));
   process.exit(0);
 }
 const workload = await entry.createPlatformWorkloadWorkerOptionsV1(signal);
 if (process.env.RUN_MOUNTED_CREDENTIALS === 'true') {
   console.log(JSON.stringify({ tokenMatches: workload.serviceToken === 'mounted-worker-fixture' }));
   process.exit(0);
 }
 if (process.env.RUN_REGISTERED_BINDINGS === 'true') {
   console.log(JSON.stringify({snapshot:globalThis.snapshot ?? null,snapshots:globalThis.snapshots ?? {},installations:globalThis.installations ?? {},reads:globalThis.registrationReads ?? 0,closes:globalThis.registrationCloses ?? 0,database:globalThis.registrationDatabase ?? null,resolverCalls:globalThis.legacyResolverCalls ?? 0}));process.exit(0);
 }
 if (process.env.RUN_REGISTRATION === 'true') {
   console.log(JSON.stringify({ policy:workload.connectionConsumerRegistration?.policy ?? null, hasAdapter:typeof workload.connectionConsumerRegistration?.adapter?.register==='function' }));process.exit(0);
 }
 if (process.env.RUN_PUBLICATION === 'true') {
   console.log(JSON.stringify({ publication:globalThis.publication ?? null, publications:globalThis.publications ?? null }));process.exit(0);
 }

 if (process.env.RUN_EVALUATION === 'true') {
   const storage = await import(${JSON.stringify(new URL("../../../packages/object-storage/dist/index.mjs", import.meta.url).href)});
   storage.requireEvaluationObjectStorageV1(workload.evaluation.storage);
   console.log(JSON.stringify({batchSize:workload.evaluation.batchSize,timeoutMs:workload.evaluation.timeoutMs,hasCleanupStorage:typeof workload.evaluation.storage.remove==='function',hasScorer:typeof workload.evaluationScoring?.loadExperimentPolicy==='function',scorerLeaseMs:workload.evaluationScoring?.leaseMs,sharedStorage:workload.evaluationScoring?.storage===workload.evaluation.storage,hasAnalysisPolicy:typeof workload.evaluation.loadAnalysisPolicy==='function'}));
   workload.evaluation.closeStorage();process.exit(0);
 }
 if (process.env.RUN_FILE_EXCHANGE === 'true') {
   console.log(JSON.stringify(globalThis.fileExchange));
   process.exit(0);
 }
	if (process.env.RUN_OAUTH_PROVISIONING === 'true') {
   const conversation = await entry.createPlatformConversationWorkerOptionsV2(signal);
   console.log(JSON.stringify({ provisioning: globalThis.oauthProvisioning ?? null, calls: globalThis.calls }));
   await conversation.closeDeployment?.();
   process.exit(0);
 }
	const conversation = await entry.createPlatformConversationWorkerOptionsV2(signal);
	if (process.env.RUN_MANUAL_ENABLED) {
	 const bootstrap = globalThis.manualBootstrap;
	 console.log(JSON.stringify({ manualDrain: typeof conversation.connectionInstallation?.manual?.drain === 'function', standard: conversation.connectionInstallation?.configuration?.clientId ?? null, bootstrap: bootstrap ? { port: bootstrap.port, workerOrigin: bootstrap.workerOrigin, clientName: bootstrap.clientName, configuration: bootstrap.configuration, approval: bootstrap.approval } : null, ...(globalThis.manualPublication ? { publication: { contract: globalThis.manualPublication.contract, associated: await globalThis.manualPublication.associated(process.env.RUN_PUBLICATION_AGENT ?? 'none') } } : {}) }));
	 await conversation.closeDeployment?.();
	 process.exit(0);
	}
	if (process.env.RUN_MANUAL_DORMANCY) {
	 console.log(JSON.stringify({ manualDrain: !!conversation.connectionInstallation?.manual, manualBootstrap: !!globalThis.manualBootstrap, standard: conversation.connectionInstallation?.configuration?.clientId ?? null, ...(globalThis.manualPublication ? { manualPublication: true } : {}) }));
	 await conversation.closeDeployment?.();
	 process.exit(0);
	}
	if (process.env.RUN_INSTALLATION_APPROVAL) {
	 const mode = process.env.RUN_INSTALLATION_APPROVAL;
	 const {PostgresConnectionInstallationAuthorizationTransactionV1: Store} = await import('@agent-infra/platform-store');
	 const configuration = (await import('./configuration.mjs')).connectionInstallation.configuration;
	 const reference = {agentId:'agent-a',conversationId:'conversation-a',executionId:'execution-a',sessionGeneration:1};
	 const scope = {agentId:'agent-a',sandboxId:'sandbox-a',podUid:'pod-a',sessionGeneration:1,configFingerprint:configuration.configFingerprint,source:configuration.source,oauthConfiguration:{ref:configuration.ref,revision:configuration.revision}};
	 const input = {principal:{kind:'user',id:'alice'},reference,scope,authorizationId:'authorization-a',command:'begin'};
	 const current = {
	   user:{schemaVersion:1,userId:'alice',accountStatus:'active',organizationIds:['eng'],authorizationRevision:'identity-r1'},
	   agent:{schemaVersion:1,agentId:'agent-a',applicationId:'application-a',applicantId:'owner',status:'available',revision:1,approvalRevision:1,decisionReason:null,serviceAvailability:'ready',desiredState:'running',workloadRevision:1,fence:1,ownerIds:['owner'],availability:[{kind:'user',userId:'alice'}],failureCode:null},
	   boundary:{schemaVersion:1,principal:input.principal,agentId:'agent-a',channelId:'web',identityRevision:'identity-r1',agentAuthorizationRevision:'agent-r1',accessSources:[{kind:'user',userId:'alice'}]},
	   agentAuthorizationRevision:'agent-r1',reference,scope
	 };
	 const saved = {authorization:{schemaVersion:1,authorizationId:input.authorizationId,confirmationRevision:'confirmation-r1',principal:input.principal,reference,scope,status:'awaiting_confirmation',expiresAt:600000},identityRevision:'identity-r1',agentAuthorizationRevision:'agent-r1'};
	 let reads = 0, finalChecks = 0;
	 if (mode === 'core-denied') current.user.accountStatus = 'disabled';
	 const originalTransaction = Store.prototype.transaction;
	 // Keep the real Core producer and production assembly; replace only DB I/O.
	 Store.prototype.transaction = async (work) => work({
	   current:async()=>{ reads++;return current; }, read:async()=>saved,
	   now:async()=>1000,hasUnresolvedSend:async()=>false,commandAllowed:async()=>true
	 });
	 try {
	   const result = await conversation.connectionInstallation?.authorize(input,signal,async()=>{
	     finalChecks++;
	     if(mode==='final-check-denied')throw new Error('controlled finalCheck denial');
	     if(mode==='revoked-after-final-check')current.user.accountStatus='disabled';
	   });
	   console.log(JSON.stringify({result:result??null,reads,finalChecks,workloadReady:!!workload,configured:!!conversation.connectionInstallation}));
	 } finally {
	   Store.prototype.transaction = originalTransaction;
	   await conversation.closeDeployment?.();
	 }
	 process.exit(0);
	}
	if (process.env.RUN_SKILL_CHECK === "true") {
	 console.log(JSON.stringify({ skillMaterializer: typeof workload.skillMaterializer?.materialize }));
	 process.exit(0);
	}
 if (process.env.RUN_CLOSE_INSTALLATION === "true") await conversation.closeDeployment?.();
 if (process.env.RUN_PRINCIPAL_INSTALLATION_MAP === "true") {
   console.log(JSON.stringify({hasCommandStore:!!conversation.connectionInstallation?.commandStore,configurations:conversation.connectionInstallation?.configurationsByAgentAndPrincipal ?? null,workloadReady:!!workload,shared:conversation.connectionInstallation?.configuration ?? null}));
   process.exit(0);
 }
 if (process.env.RUN_INSTALLATION_MAP === "true") {
   console.log(JSON.stringify({hasCommandStore:!!conversation.connectionInstallation?.commandStore,configurations:conversation.connectionInstallation?.configurationsByAgent ?? null,workloadReady:!!workload,shared:conversation.connectionInstallation?.configuration ?? null}));
   process.exit(0);
 }
	if (process.env.RUN_INVALID_PROFILE === 'true') {
	 const control = await conversation.resolveRuntimeHost({ purpose: 'control' });
	 let business;
	 try { await conversation.resolveRuntimeHost({ purpose: 'business' }); } catch (error) { business = error.message; }
	 console.log(JSON.stringify({ control, business, snapshot: globalThis.snapshot, installation: globalThis.installation }));
	 process.exit(0);
	}
 console.log(JSON.stringify({ databases: [workload.databaseUrl, conversation.databaseUrl, globalThis.wecomDatabase], calls: globalThis.calls, connection: globalThis.connection, snapshot: globalThis.snapshot ? JSON.parse(globalThis.snapshot) : null, installation: globalThis.installation, snapshots: globalThis.snapshots, installations: globalThis.installations, installationConfigured: typeof conversation.connectionInstallation?.authorize === 'function', ...(process.env.REPORT_ASSOCIATION ? { associationOpens: globalThis.associationSourceOpens, associationCloses: globalThis.associationSourceCloses ?? 0 } : {}) }));
} catch (error) {
 console.log(JSON.stringify({ error: error.message, calls: globalThis.calls, ...(process.env.REPORT_ASSOCIATION ? { associationOpens: globalThis.associationSourceOpens, associationCloses: globalThis.associationSourceCloses ?? 0 } : {}) }));
 process.exitCode = 1;
}
`,
	);
});
afterAll(async () => {
	if (directory) await rm(directory, { recursive: true, force: true });
	if (platformStoreDistOriginal === undefined)
		await rm(platformStoreDistPath, { force: true });
	else await writeFile(platformStoreDistPath, platformStoreDistOriginal);
});

it.each(["ownerConnectionBindings", "ownerConnectionBindingConfiguration"])(
	"keeps Owner supply dormant when %s is configured",
	async (name) => {
		const path = join(directory, "configuration.mjs");
		const original = await readFile(path, "utf8");
		try {
			await writeFile(path, `${original}\nexport const ${name} = {};\n`);
			const result = run();
			expect(result.status).toBe(1);
			expect(JSON.parse(result.stderr || result.stdout)).toEqual({
				error: "CONNECTION_OWNER_SUPPLY_REQUIRES_PREPARE",
				calls: [],
			});
		} finally {
			await writeFile(path, original);
		}
	},
);

const database = "postgresql://database.example.test/platform";
function run(overrides: Record<string, string | undefined> = {}) {
	return spawnSync(process.execPath, [join(directory, "run.mjs")], {
		encoding: "utf8",
		// Loading the deployment graph can exceed five seconds on a cold CI runner.
		timeout: 10_000,
		env: {
			...process.env,
			PLATFORM_DATABASE_URL: database,
			PLATFORM_WORKER_NAMESPACE: "worker-binding",
			...overrides,
		},
	});
}

it("keeps registration default off and passes explicit policy/adapter from the existing Worker module", async () => {
	const original = await readFile(join(directory, "configuration.mjs"), "utf8");
	const absent = run({ RUN_REGISTRATION: "true" });
	expect(absent.status, absent.stderr).toBe(0);
	expect(JSON.parse(absent.stdout)).toEqual({
		policy: null,
		hasAdapter: false,
	});
	const policy = {
		schemaVersion: 1,
		sourceNamespace: "worker-entry-test",
		revision: "policy-1",
		callbackUrl: "https://platform.example.test/connection/callback",
		resource: "https://connection.example.test/mcp",
		scope: "mcp:tools",
	};
	try {
		await writeFile(
			join(directory, "configuration.mjs"),
			`${original}\nworkloadInput.connectionConsumerRegistration={policy:${JSON.stringify(policy)},adapter:{register:async()=>({outcome:'unknown',failureCode:'UNCONFIGURED'}),reconcile:async()=>({outcome:'unknown',failureCode:'UNCONFIGURED'})}};\n`,
		);
		const configured = run({ RUN_REGISTRATION: "true" });
		expect(configured.status, configured.stderr).toBe(0);
		expect(JSON.parse(configured.stdout)).toEqual({ policy, hasAdapter: true });
	} finally {
		await writeFile(join(directory, "configuration.mjs"), original);
	}
});

it("does not use a shared Consumer when the automatic registration source has no binding resolver", async () => {
	const path = join(directory, "configuration.mjs");
	const original = await readFile(path, "utf8");
	const policy = {
		schemaVersion: 1,
		sourceNamespace: "worker-entry-test",
		revision: "policy-1",
		callbackUrl: "https://platform.example.test/connection/callback",
		resource: "https://connection.example.test/mcp",
		scope: "mcp",
	};
	try {
		await writeFile(
			path,
			`${original}\nworkloadInput.connectionConsumerRegistration={policy:${JSON.stringify(policy)}};\n`,
		);
		const result = run();
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			snapshot: null,
			snapshots: {},
			installationConfigured: false,
			calls: ["readiness", "workload", "wecom", "conversation", "sandbox"],
		});
	} finally {
		await writeFile(path, original);
	}
});

it.each([false, true])(
	"assembles independent Consumer snapshots from persistent registrations and rechecks late changes (%s)",
	async (changed) => {
		const path = join(directory, "configuration.mjs");
		const original = await readFile(path, "utf8");
		const policy = {
			schemaVersion: 1 as const,
			sourceNamespace: "worker-registration-projection",
			revision: "policy-1",
			callbackUrl: "https://platform.example.test/connection/callback",
			resource: "https://connection.example.test/mcp/v1",
			scope: "mcp",
		};
		const registrations = Object.fromEntries(
			["agent-a", "agent-b"].map((agentId) => {
				const intent = planConnectionConsumerRegistrationV1({
					policy,
					platformAgentId: agentId,
					platformOwnerId: `owner-${agentId}`,
					consumerName: agentId,
				});
				return [
					agentId,
					captureConnectionConsumerRegisteredBindingV1({
						intent,
						receipt: {
							schemaVersion: 1,
							operationId: intent.operationId,
							sourceNamespace: intent.sourceNamespace,
							sourceKey: intent.sourceKey,
							requestDigest: intent.requestDigest,
							consumerId: `random-${agentId}`,
							consumerRevision: "4",
							registrationId: `registration-${agentId}`,
						},
						associationRevision: 1,
					}),
				];
			}),
		);
		try {
			await writeFile(
				path,
				`${original}
import { connectionConsumerProfileFingerprintV1 } from '@agent-infra/contracts/connection-consumer-profile';
workloadInput.connectionConsumerRegistration={policy:${JSON.stringify(policy)}};
globalThis.registrations=${JSON.stringify(registrations)};
export const resolveConnectionConsumerBindingsByAgent=async(signal,registrations)=>{
 signal.throwIfAborted();
 const values=Object.fromEntries(Object.entries(registrations).map(([agentId,binding])=>{
  const profile={...connectionConsumerProfile,consumerId:binding.receipt.consumerId};
  return [agentId,{profile,approval:{schemaVersion:1,egressEnforced:true,configFingerprint:connectionConsumerProfileFingerprintV1(profile),source:binding.source},installationSupply:{ref:'protected-'+agentId,revision:'r1'}}];
 }));
 ${changed ? "delete globalThis.registrations['agent-a'];" : ""}
 return values;
};
`,
			);
			const result = run({ RUN_REGISTERED_BINDINGS: "true" });
			expect(result.status, result.stderr).toBe(0);
			const value = JSON.parse(result.stdout);
			expect(value).toMatchObject({
				snapshot: null,
				reads: 2,
				closes: 1,
				database,
			});
			expect(Object.keys(value.snapshots)).toEqual(
				changed ? ["agent-b"] : ["agent-a", "agent-b"],
			);
			for (const [id, snapshot] of Object.entries(value.snapshots)) {
				expect(snapshot).toEqual(
					expect.stringContaining(`"consumerId":"random-${id}"`),
				);
				expect(snapshot).toEqual(
					expect.stringContaining(`"ref":"${registrations[id]?.source.ref}"`),
				);
			}
		} finally {
			await writeFile(path, original);
		}
	},
);

it.each([false, true])(
	"does not project shared profiles after removal of an associated Agent's automatic policy (sourceUnavailable=%s)",
	async (sourceUnavailable) => {
		const path = join(directory, "configuration.mjs");
		const original = await readFile(path, "utf8");
		try {
			await writeFile(
				path,
				`${original}
globalThis.sourceSelection={automaticAgentIds:['agent-a'],legacyAgentIds:['agent-b']};
globalThis.sourceSelectionFailed=${sourceUnavailable};
`,
			);
			const result = run({ RUN_REGISTERED_BINDINGS: "true" });
			expect(result.status, result.stderr).toBe(0);
			const projected = JSON.parse(result.stdout);
			expect(projected.snapshot).toBeNull();
			expect(Object.keys(projected.snapshots)).toEqual(
				sourceUnavailable ? [] : ["agent-b"],
			);
			if (!sourceUnavailable)
				expect(projected.snapshots["agent-b"]).toContain(
					'"consumerId":"platform-worker"',
				);
		} finally {
			await writeFile(path, original);
		}
	},
);

it.each([false, true])(
	"preserves a resolver-backed legacy Agent while excluding automatic sources and late source changes (%s)",
	async (changed) => {
		const path = join(directory, "configuration.mjs");
		const original = await readFile(path, "utf8");
		try {
			await writeFile(
				path,
				`${original}
import { connectionConsumerProfileFingerprintV1 } from '@agent-infra/contracts/connection-consumer-profile';
globalThis.sourceSelection={automaticAgentIds:['agent-a'],legacyAgentIds:['agent-b']};
export const resolveConnectionConsumerBindingsByAgent=async(signal)=>{
 signal.throwIfAborted();
 globalThis.legacyResolverCalls=(globalThis.legacyResolverCalls ?? 0)+1;
 const profile={...connectionConsumerProfile,consumerId:'legacy-consumer-b'};
 const legacy={profile,approval:{...connectionConsumerApproval,configFingerprint:connectionConsumerProfileFingerprintV1(profile)},installationSupply:{ref:'legacy-b-supply',revision:'r1'}};
 ${changed ? "globalThis.sourceSelection={automaticAgentIds:['agent-a','agent-b'],legacyAgentIds:[]};" : ""}
 return {'agent-a':legacy,'agent-b':legacy};
};
`,
			);
			const result = run({ RUN_REGISTERED_BINDINGS: "true" });
			expect(result.status, result.stderr).toBe(0);
			const projected = JSON.parse(result.stdout);
			expect(projected.snapshot).toBeNull();
			expect(projected.resolverCalls).toBe(1);
			expect(Object.keys(projected.snapshots)).toEqual(
				changed ? [] : ["agent-b"],
			);
			if (!changed)
				expect(projected.snapshots["agent-b"]).toContain(
					'"consumerId":"legacy-consumer-b"',
				);
		} finally {
			await writeFile(path, original);
		}
	},
);

it("uses the selected deployment database for all Worker consumers and prepares once", () => {
	const result = run();
	expect(result.status, result.stderr).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual({
		databases: [database, database, database],
		calls: ["readiness", "workload", "wecom", "conversation", "sandbox"],
		connection: {
			profile: connectionConsumerProfile,
			approval: connectionConsumerApproval,
		},
		snapshot: {
			profile: connectionConsumerProfile,
			approval: connectionConsumerApproval,
		},
		installationConfigured: false,
	});
});

it("rejects an executor layout without its summed Store charge before constructing adapters", async () => {
	const path = join(directory, "configuration.mjs");
	const original = await readFile(path, "utf8");
	await writeFile(
		path,
		`${original}\nObject.assign(workloadInput.policy, ${JSON.stringify({
			resources: {
				requests: { cpu: "100m", memory: "128Mi" },
				limits: { cpu: "1", memory: "1Gi" },
			},
			storageSize: "1Gi",
			codexSessionExecutor: {
				resources: {
					requests: { cpu: "100m", memory: "64Mi" },
					limits: { cpu: "500m", memory: "256Mi" },
				},
			},
		})});\n`,
	);
	try {
		const result = run();
		expect(result.status).not.toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			error: "CODEX_SESSION_EXECUTOR_RESOURCE_COST_INVALID",
			calls: [],
		});
	} finally {
		await writeFile(path, original);
	}
});

it("loads reserve policy from a deployment file when the module omits it", async () => {
	const reserveFile = join(directory, "session-reserves.json");
	await writeFile(
		reserveFile,
		JSON.stringify({
			schemaVersion: 1,
			enabled: false,
			revision: 2,
			namespace: "worker-binding",
			totalBudget: { cpuMillis: 0, memoryBytes: 0, storageBytes: 0 },
			resourceCosts: [],
			maximumReserves: 0,
			maximumConcurrentCreates: 0,
			ttlMs: 0,
			cooldownMs: 0,
			failureBackoffMs: 0,
			profiles: [],
		}),
	);
	const result = run({
		RUN_RESERVE_OPTIONS: "true",
		PLATFORM_WORKER_SESSION_RESERVES_FILE: reserveFile,
	});
	expect(result.status, result.stderr).toBe(0);
	expect(JSON.parse(result.stdout)).toMatchObject({
		configured: true,
		namespace: "worker-binding",
		enabled: false,
	});
});

it.each([
	["shared startup Consumer", undefined, undefined, ["agent-a"]],
	[
		"per-Agent startup Consumers",
		{
			"agent-a": {
				profile: connectionConsumerProfile,
				approval: connectionConsumerApproval,
			},
		},
		undefined,
		["agent-a"],
	],
	[
		"startup legacy Agents beside persistent Agents",
		{
			"agent-a": {
				profile: connectionConsumerProfile,
				approval: connectionConsumerApproval,
			},
		},
		{ automaticAgentIds: ["agent-auto"], legacyAgentIds: ["agent-a"] },
		["agent-a", "agent-auto"],
	],
] as const)(
	"hands the reserve adapter the Worker workload with the current Connection source check: %s (#4157)",
	async (_label, profilesByAgent, selection, agents) => {
		const configurationPath = join(directory, "configuration.mjs");
		const original = await readFile(configurationPath, "utf8");
		const reserveFile = join(directory, "session-reserves-delivery.json");
		await writeFile(
			reserveFile,
			JSON.stringify({
				schemaVersion: 1,
				enabled: false,
				revision: 3,
				namespace: "worker-binding",
				totalBudget: { cpuMillis: 0, memoryBytes: 0, storageBytes: 0 },
				resourceCosts: [],
				maximumReserves: 0,
				maximumConcurrentCreates: 0,
				ttlMs: 0,
				cooldownMs: 0,
				failureBackoffMs: 0,
				profiles: [],
			}),
		);
		try {
			if (profilesByAgent)
				await writeFile(
					configurationPath,
					// Per-Agent startup Consumers come from the deployment resolver; static
					// per-Agent maps are no longer accepted.
					`${original}\nexport const resolveConnectionConsumerBindingsByAgent = async (signal) => { signal.throwIfAborted(); return ${JSON.stringify(
						Object.fromEntries(
							Object.entries(profilesByAgent).map(([agentId, binding]) => [
								agentId,
								{
									...binding,
									installationSupply: {
										ref: `installation-${agentId}`,
										revision: "r1",
									},
								},
							]),
						),
					)}; };\n`,
				);
			const result = run({
				RUN_RESERVE_DELIVERY: JSON.stringify({ selection, agents }),
				PLATFORM_WORKER_SESSION_RESERVES_FILE: reserveFile,
			});
			expect(result.status, result.stderr).toBe(0);
			const value = JSON.parse(result.stdout);
			expect(value).toMatchObject({
				guard: "function",
				opens: 1,
				database,
				sameWorkload: true,
			});
			// Before association delivery continues; after a later association, and while
			// the source is unavailable, delivery of the startup Consumer is closed.
			expect(value.results["before:agent-a"]).toBe(true);
			expect(value.results["associated:agent-a"]).toBe(false);
			expect(value.results["failed:agent-a"]).toBe("rejected");
			if (selection) {
				// Agents outside the startup legacy set received no startup Consumer at all.
				expect(value.results["associated:agent-auto"]).toBe(true);
				expect(value.reads).not.toContain("agent-auto");
			}
		} finally {
			await writeFile(configurationPath, original);
		}
	},
);

it("explicit reserve file rejects a conflicting module policy", async () => {
	const configurationPath = join(directory, "configuration.mjs");
	const original = await readFile(configurationPath, "utf8");
	const reserveFile = join(directory, "session-reserves-explicit.json");
	await writeFile(
		reserveFile,
		JSON.stringify({
			schemaVersion: 1,
			enabled: false,
			revision: 9,
			namespace: "worker-binding",
			totalBudget: { cpuMillis: 0, memoryBytes: 0, storageBytes: 0 },
			resourceCosts: [],
			maximumReserves: 0,
			maximumConcurrentCreates: 0,
			ttlMs: 0,
			cooldownMs: 0,
			failureBackoffMs: 0,
			profiles: [],
		}),
	);
	await writeFile(
		configurationPath,
		`${original}\nexport const sessionSandboxReserves = ${JSON.stringify({
			schemaVersion: 1,
			enabled: false,
			revision: 2,
			namespace: "worker-binding",
			totalBudget: { cpuMillis: 0, memoryBytes: 0, storageBytes: 0 },
			resourceCosts: [],
			maximumReserves: 0,
			maximumConcurrentCreates: 0,
			ttlMs: 0,
			cooldownMs: 0,
			failureBackoffMs: 0,
			profiles: [],
		})};\n`,
	);
	try {
		const result = run({
			RUN_RESERVE_OPTIONS: "true",
			PLATFORM_WORKER_SESSION_RESERVES_FILE: reserveFile,
		});
		expect(result.status).not.toBe(0);
		expect(`${result.stdout}${result.stderr}`).toContain(
			"SESSION_RESERVE_DEPLOYMENT_CONFIGURATION_CONFLICT",
		);
	} finally {
		await writeFile(configurationPath, original);
	}
});

it.each([
	"{",
	'{"architecture":"amd64"}',
	'{"architecture":"amd64","legacyUnplaced":"reject","runtimeClassName":"runv"}',
])(
	"fails closed on an invalid chart-rendered Agent placement %s (#4351)",
	(value) => {
		const result = run({ AGENT_INFRA_AGENT_WORKLOAD_PLACEMENT: value });
		expect(result.status).not.toBe(0);
		expect(`${result.stdout}${result.stderr}`).toContain(
			"WORKER_AGENT_WORKLOAD_PLACEMENT_INVALID",
		);
	},
);

it("fails closed when the Worker module supplies its own Agent placement (#4351)", async () => {
	const path = join(directory, "configuration.mjs");
	const original = await readFile(path, "utf8");
	try {
		await writeFile(
			path,
			original.replace(
				"policy: {",
				'policy: { agentWorkloadPlacement: { architecture: "amd64", legacyUnplaced: "reject" },',
			),
		);
		expect(await readFile(path, "utf8")).not.toBe(original);
		const result = run({
			AGENT_INFRA_AGENT_WORKLOAD_PLACEMENT:
				'{"architecture":"amd64","legacyUnplaced":"reject"}',
		});
		expect(result.status).not.toBe(0);
		expect(`${result.stdout}${result.stderr}`).toContain(
			"WORKER_AGENT_WORKLOAD_PLACEMENT_INVALID",
		);
	} finally {
		await writeFile(path, original);
	}
});

it("fails closed when an explicit reserve file is missing", () => {
	const result = run({
		RUN_RESERVE_OPTIONS: "true",
		PLATFORM_WORKER_SESSION_RESERVES_FILE: join(
			directory,
			"missing-reserves.json",
		),
	});
	expect(result.status).not.toBe(0);
	expect(`${result.stdout}${result.stderr}`).toContain(
		"SESSION_RESERVE_DEPLOYMENT_CONFIGURATION_MISSING",
	);
});

it("closes Connection when deployment supplies static per-Agent Consumer maps (#4157)", async () => {
	const configurationPath = join(directory, "configuration.mjs");
	const original = await readFile(configurationPath, "utf8");
	const agentBProfile = {
		...connectionConsumerProfile,
		consumerId: "platform-worker-agent-b",
		schemaVersion: 1 as const,
	} as const;
	const agentBApproval = {
		...connectionConsumerApproval,
		configFingerprint: connectionConsumerProfileFingerprintV1(agentBProfile),
	};
	const profiles = {
		"agent-a": {
			profile: connectionConsumerProfile,
			approval: connectionConsumerApproval,
		},
		"agent-b": { profile: agentBProfile, approval: agentBApproval },
	};
	try {
		await writeFile(
			configurationPath,
			`${original}\nexport const connectionConsumerProfilesByAgent = ${JSON.stringify(profiles)};\nexport const connectionInstallationSuppliesByAgent = ${JSON.stringify(
				{
					"agent-a": { ref: "installation-a", revision: "r1" },
					"agent-b": { ref: "installation-b", revision: "r2" },
				},
			)};\n`,
		);
		const result = run();
		expect(result.status, result.stderr).toBe(0);
		// Spec §13.5.7: no per-Agent entry from deployment, and no shared fallback either.
		const value = JSON.parse(result.stdout);
		expect(value.snapshot).toBeNull();
		expect(value.snapshots).toBeUndefined();
		expect(value.installations).toBeUndefined();
		// Only Connection closes: business work for Agents without Connection keeps running.
		const business = run({ RUN_INVALID_PROFILE: "true" });
		expect(business.status, business.stderr).toBe(0);
		const resolved = JSON.parse(business.stdout);
		expect(resolved.business).toBeUndefined();
		expect(resolved.snapshot ?? null).toBeNull();
	} finally {
		await writeFile(configurationPath, original);
	}
});

it("projects a persisted random OAuth client returned by the deployment resolver", async () => {
	const configurationPath = join(directory, "configuration.mjs");
	const original = await readFile(configurationPath, "utf8");
	const binding = {
		clientId: "oauth-client-random",
		profileFingerprint: connectionConsumerApproval.configFingerprint,
		source: connectionConsumerApproval.source,
	};
	try {
		await writeFile(
			configurationPath,
			`${original}\nexport const resolveConnectionConsumerBindingsByAgent = async (signal) => { signal.throwIfAborted(); return ${JSON.stringify(
				{
					"agent-a": {
						profile: connectionConsumerProfile,
						approval: connectionConsumerApproval,
						oauthClientBinding: binding,
						installationSupply: { ref: "installation-a", revision: "r1" },
					},
				},
			)}; };\n`,
		);
		const result = run();
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			snapshot: null,
			snapshots: {
				"agent-a": expect.stringContaining('"clientId":"oauth-client-random"'),
			},
			installations: { "agent-a": '["installation-a","r1"]' },
		});
	} finally {
		await writeFile(configurationPath, original);
	}
});

it("loads each Agent binding through the deployment Connection resolver", async () => {
	const configurationPath = join(directory, "configuration.mjs");
	const original = await readFile(configurationPath, "utf8");
	const agentBProfile = {
		...connectionConsumerProfile,
		consumerId: "platform-worker-agent-b",
		schemaVersion: 1 as const,
	} as const;
	const agentBApproval = {
		...connectionConsumerApproval,
		configFingerprint: connectionConsumerProfileFingerprintV1(agentBProfile),
	};
	try {
		await writeFile(
			configurationPath,
			`${original}\nexport const resolveConnectionConsumerBindingsByAgent = async (signal) => { signal.throwIfAborted(); return ${JSON.stringify(
				{
					"agent-a": {
						profile: connectionConsumerProfile,
						approval: connectionConsumerApproval,
						installationSupply: { ref: "installation-a", revision: "r1" },
					},
					"agent-b": {
						profile: agentBProfile,
						approval: agentBApproval,
						installationSupply: { ref: "installation-b", revision: "r2" },
					},
				},
			)}; };\n`,
		);
		const result = run();
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			snapshot: null,
			snapshots: {
				"agent-a": expect.stringContaining('"consumerId":"platform-worker"'),
				"agent-b": expect.stringContaining(
					'"consumerId":"platform-worker-agent-b"',
				),
			},
			installations: {
				"agent-a": '["installation-a","r1"]',
				"agent-b": '["installation-b","r2"]',
			},
		});
	} finally {
		await writeFile(configurationPath, original);
	}
});

it("fails closed when native metadata is enabled without runtime auth", () => {
	const result = run({
		PLATFORM_WORKER_NATIVE_METADATA_GATEWAY_ENABLED: "true",
	});
	expect(result.status).toBe(1);
	expect(JSON.parse(result.stdout)).toEqual({
		error: "PLATFORM_WORKER_NATIVE_METADATA_GATEWAY_CONFIGURATION_INVALID",
		calls: [],
	});
});

it("pairs the file exchange origin with exactly one declared egress at its port (#3289)", async () => {
	const configurationPath = join(directory, "configuration.mjs");
	const configuration = await readFile(configurationPath, "utf8");
	const origin = "http://agent-infra-e2e-native-metadata-api:3000";
	const egress = JSON.stringify({ ip: "172.18.0.44" });
	try {
		await writeFile(
			configurationPath,
			`${configuration}\nworkloadInput.policy.runtimeAuth = {};\n`,
		);
		const enabled = run({
			RUN_FILE_EXCHANGE: "true",
			PLATFORM_WORKER_FILE_EXCHANGE_ORIGIN: origin,
			PLATFORM_WORKER_FILE_EXCHANGE_EGRESS: egress,
		});
		expect(enabled.status, enabled.stderr).toBe(0);
		expect(JSON.parse(enabled.stdout)).toEqual({
			origin,
			egress: [{ destination: { ip: "172.18.0.44" }, port: 3000 }],
		});
		// 未配置文件交换时不生成这条规则。
		const disabled = run({ RUN_FILE_EXCHANGE: "true" });
		expect(disabled.status, disabled.stderr).toBe(0);
		expect(JSON.parse(disabled.stdout)).toEqual({ origin: null, egress: null });
		for (const overrides of [
			{ PLATFORM_WORKER_FILE_EXCHANGE_ORIGIN: origin },
			{
				PLATFORM_WORKER_FILE_EXCHANGE_ORIGIN: origin,
				PLATFORM_WORKER_FILE_EXCHANGE_EGRESS: "not-json",
			},
			{
				PLATFORM_WORKER_FILE_EXCHANGE_ORIGIN: origin,
				PLATFORM_WORKER_FILE_EXCHANGE_EGRESS: JSON.stringify({
					cidr: "203.0.113.0/24",
				}),
			},
			{
				PLATFORM_WORKER_FILE_EXCHANGE_ORIGIN: origin,
				PLATFORM_WORKER_FILE_EXCHANGE_EGRESS: JSON.stringify({
					ip: "not-an-ip",
				}),
			},
			{
				PLATFORM_WORKER_FILE_EXCHANGE_ORIGIN: origin,
				PLATFORM_WORKER_FILE_EXCHANGE_EGRESS: JSON.stringify({
					ip: "172.18.0.44",
					port: 9000,
				}),
			},
			{ PLATFORM_WORKER_FILE_EXCHANGE_EGRESS: egress },
		]) {
			const result = run(overrides);
			expect(result.status).toBe(1);
			expect(JSON.parse(result.stdout)).toEqual({
				error: "PLATFORM_WORKER_FILE_EXCHANGE_CONFIGURATION_INVALID",
				calls: [],
			});
		}
		// 部署模块声明的端口必须等于 origin 端口；模块与环境变量不能同时提供。
		await writeFile(
			configurationPath,
			`${configuration}\nworkloadInput.policy.runtimeAuth = { fileExchangeOrigin: ${JSON.stringify(origin)} };\nworkloadInput.policy.fileExchangeEgress = [{ destination: { ip: "172.18.0.44" }, port: 3001 }];\n`,
		);
		const mismatched = run();
		expect(mismatched.status).toBe(1);
		expect(JSON.parse(mismatched.stdout)).toEqual({
			error: "PLATFORM_WORKER_FILE_EXCHANGE_CONFIGURATION_INVALID",
			calls: [],
		});
		const duplicate = run({ PLATFORM_WORKER_FILE_EXCHANGE_EGRESS: egress });
		expect(duplicate.status).toBe(1);
		expect(JSON.parse(duplicate.stdout)).toEqual({
			error: "PLATFORM_WORKER_FILE_EXCHANGE_DUPLICATE",
			calls: [],
		});
	} finally {
		await writeFile(configurationPath, configuration);
	}
	// 每个场景都启动一次部署图，冷 CI 上单次约 1 秒。
}, 60_000);

it("loads mounted credentials at Worker startup for the v4 workload", async () => {
	const path = join(directory, "configuration.mjs");
	const tokenFile = join(directory, "worker-token");
	const keyringFile = join(directory, "worker-keyring.json");
	const original = await readFile(path, "utf8");
	const launch = () =>
		run({
			RUN_MOUNTED_CREDENTIALS: "true",
			PLATFORM_WORKER_SERVICE_TOKEN_FILE: tokenFile,
			AGENT_INFRA_WORKER_KEYRING_FILE: keyringFile,
		});
	try {
		await writeFile(
			path,
			`${original}
import { readFileSync } from 'node:fs';
export const workerCredentialSource = "mounted";
workloadInput.runtimeModelVersion = 4;
let keyringRead = false;
Object.defineProperty(workloadInput, "keyring", {
  enumerable: true,
  get() {
    if (keyringRead) throw new Error("keyring read twice during startup");
    keyringRead = true;
    return JSON.parse(readFileSync(process.env.AGENT_INFRA_WORKER_KEYRING_FILE, "utf8"));
  },
});
`,
		);
		const privateKey = generateKeyPairSync("rsa", {
			modulusLength: 3072,
		}).privateKey;
		await writeFile(
			keyringFile,
			JSON.stringify({
				keys: [
					{
						keyVersion: "test-wrap-v1",
						privateKeyPkcs8DerBase64: privateKey
							.export({ type: "pkcs8", format: "der" })
							.toString("base64"),
					},
				],
			}),
			{ mode: 0o600 },
		);
		await writeFile(tokenFile, "mounted-worker-fixture", { mode: 0o600 });
		const result = launch();
		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({ tokenMatches: true });
		await writeFile(tokenFile, "mounted-worker-fixture\n");
		const malformed = launch();
		expect(malformed.status).toBe(1);
		expect(JSON.parse(malformed.stdout).error).toBe(
			"WORKER_RUNTIME_CREDENTIALS_UNAVAILABLE",
		);
		await rm(tokenFile);
		const missing = launch();
		expect(missing.status).toBe(1);
		expect(JSON.parse(missing.stdout).error).toBe(
			"WORKER_RUNTIME_CREDENTIALS_UNAVAILABLE",
		);
		await writeFile(tokenFile, "mounted-worker-fixture");
		await writeFile(keyringFile, "invalid-keyring-fixture");
		const malformedRing = launch();
		expect(malformedRing.status).toBe(1);
		expect(JSON.parse(malformedRing.stdout).error).toBe(
			"WORKER_RUNTIME_CREDENTIALS_UNAVAILABLE",
		);
		expect(malformedRing.stdout + malformedRing.stderr).not.toContain(
			"invalid-keyring-fixture",
		);
	} finally {
		await rm(tokenFile, { force: true });
		await rm(keyringFile, { force: true });
		await writeFile(path, original);
	}
	// This test starts four Worker processes, each with its own ten-second limit.
}, 60_000);

it("wires the deployment API origin and keeps explicit current-confirmation ports", async () => {
	const configurationPath = join(directory, "configuration.mjs");
	const assemblyPath = join(
		directory,
		"native-metadata-deployment-assembly.js",
	);
	const configuration = await readFile(configurationPath, "utf8");
	const assembly = await readFile(assemblyPath, "utf8");
	const overrides = {
		RUN_NATIVE_PORTS: "true",
		PLATFORM_WORKER_NATIVE_METADATA_GATEWAY_ENABLED: "true",
		PLATFORM_WORKER_RELEASE_NAME: "worker-binding",
		PLATFORM_WORKER_NATIVE_METADATA_PLATFORM_API_ORIGIN:
			"http://worker-binding-native-metadata-api:3000",
	};
	try {
		await writeFile(
			assemblyPath,
			"export const createPlatformNativeMetadataGatewayAssemblyV1 = (options) => ({ ports: options.ports });",
		);
		const common = `${configuration}\nworkloadInput.policy.runtimeAuth = {};\nexport const serviceToken = 'fixture-service-token';\n`;
		await writeFile(configurationPath, common);
		let result = run(overrides);
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			port: 3004,
			platformApiCurrent: {
				baseUrl: overrides.PLATFORM_WORKER_NATIVE_METADATA_PLATFORM_API_ORIGIN,
				serviceToken: "fixture-service-token",
			},
		});
		result = run({
			...overrides,
			PLATFORM_WORKER_NATIVE_METADATA_API_REPLICA_ROUTING: "true",
		});
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout).platformApiCurrent.replicas).toEqual({
			namespace: "worker-binding",
		});
		await writeFile(
			configurationPath,
			`${common}\nexport const nativeMetadataGateway = { platformApiCurrent: { baseUrl: 'http://explicit-api:3000', serviceToken: 'explicit-token' } };`,
		);
		result = run(overrides);
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout).platformApiCurrent).toEqual({
			baseUrl: "http://explicit-api:3000",
			serviceToken: "explicit-token",
		});
		await writeFile(configurationPath, common);
		result = run({
			...overrides,
			PLATFORM_WORKER_NATIVE_METADATA_GATEWAY_ENABLED: "false",
		});
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toBeNull();
	} finally {
		await writeFile(configurationPath, configuration);
		await writeFile(assemblyPath, assembly);
	}
	// Four cold deployment processes each retain their own 10-second bound.
}, 60_000);

it("assembles the optional Store-backed Skill materializer in deployment entry", async () => {
	const path = join(directory, "configuration.mjs");
	const original = await readFile(path, "utf8");
	await writeFile(
		path,
		`${original}
export const skillMaterialization = {
  storage: { download: async () => new ReadableStream() },
  assemblyRoot: "/var/lib/agent-infra/skills",
  runtimeUid: 65534,
  store: {
    resolveSyncBindings: async () => [],
    readPublication: async () => null,
    recordAppliedReceipt: async (receipt) => receipt,
  },
  agentVersion: "agent-version-1",
  actor: { actorId: "deployment-actor", organizationIds: [], isAdministrator: false },
  resolveAdmissionPolicy: async () => { throw new Error("no package"); },
  sourceVerifier: { verify: async () => { throw new Error("no package"); } },
};
`,
	);
	try {
		const result = run({ RUN_SKILL_CHECK: "true" });
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			skillMaterializer: "function",
		});
	} finally {
		await writeFile(path, original);
	}
});

it("keeps ordinary Workload startup when optional Skill input is incomplete", async () => {
	const path = join(directory, "configuration.mjs");
	const original = await readFile(path, "utf8");
	await writeFile(
		path,
		`${original}\nexport const skillMaterialization = { storage: {} };\n`,
	);
	try {
		const result = run({ RUN_SKILL_CHECK: "true" });
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			skillMaterializer: "undefined",
		});
	} finally {
		await writeFile(path, original);
	}
});

it.each(["captureSyncAttempt", "recordSyncFailure", "complete"] as const)(
	"requires failure persistence ports when Skill materialization is enabled: %s",
	async (missing) => {
		const path = join(directory, "configuration.mjs");
		const original = await readFile(path, "utf8");
		const image = `registry.example.test/skill-init@sha256:${"a".repeat(64)}`;
		await writeFile(
			path,
			`${original}
workloadInput.policy.skillDeliveryImage = ${JSON.stringify(image)};
export const skillMaterialization = {
 storage: { download: async () => new ReadableStream() },
 assemblyRoot: "/var/lib/agent-infra/skills", runtimeUid: 65534,
 delivery: { client: { namespace: "worker-binding", read: async () => null, create: async () => null } },
 agentVersion: "agent-version-1",
 actor: { actorId: "deployment-actor", organizationIds: [], isAdministrator: false },
 store: {
  resolveSyncBindings: async () => [], readPublication: async () => null,
  recordAppliedReceipt: async (receipt) => receipt,
  ${missing === "captureSyncAttempt" ? "" : "captureSyncAttempt: async () => null,"}
  ${missing === "recordSyncFailure" ? "" : "recordSyncFailure: async () => true,"}
 },
 resolveAdmissionPolicy: async () => { throw new Error("no package"); },
 sourceVerifier: { verify: async () => { throw new Error("no package"); } },
};
`,
		);
		try {
			const result = run({
				RUN_SKILL_CHECK: "true",
				PLATFORM_WORKER_SKILL_MATERIALIZATION_REQUIRED: "true",
				PLATFORM_WORKER_SKILL_ASSEMBLY_ROOT: "/var/lib/agent-infra/skills",
				PLATFORM_WORKER_SKILL_INIT_IMAGE: image,
				AGENT_INFRA_AGENT_VERSION: "agent-version-1",
			});
			if (missing === "complete") {
				expect(result.status, result.stderr).toBe(0);
				expect(JSON.parse(result.stdout)).toEqual({
					skillMaterializer: "function",
				});
			} else {
				expect(result.status).not.toBe(0);
				expect(result.stdout).toContain(
					"SKILL_MATERIALIZER_CONFIGURATION_INVALID",
				);
			}
		} finally {
			await writeFile(path, original);
		}
	},
);

it("rejects explicitly enabled Skill materialization when its configuration is absent", () => {
	const result = run({
		PLATFORM_WORKER_SKILL_MATERIALIZATION_REQUIRED: "true",
	});
	expect(result.status).not.toBe(0);
	expect(result.stdout).toContain("SKILL_MATERIALIZER_CONFIGURATION_INVALID");
});

it.each([
	["close succeeds", undefined],
	["close fails and the preparation error is kept", "true"],
] as const)(
	"a preparation failure after the startup source guard opened closes it once: %s (#4157)",
	(_label, closeFails) => {
		const result = run({
			PLATFORM_WORKER_SKILL_MATERIALIZATION_REQUIRED: "true",
			ASSOCIATION_CLOSE_FAILS: closeFails,
			REPORT_ASSOCIATION: "true",
		});
		expect(result.status).not.toBe(0);
		const value = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
		expect(value).toMatchObject({
			error: "SKILL_MATERIALIZER_CONFIGURATION_INVALID",
			associationOpens: 1,
			associationCloses: 1,
		});
	},
);

it.each([
	["keeps the startup source guard open until shutdown", undefined, 0],
	["closes the startup source guard once at shutdown", "true", 1],
] as const)("a prepared deployment %s (#4157)", (_label, close, closes) => {
	const result = run({
		RUN_CLOSE_INSTALLATION: close,
		REPORT_ASSOCIATION: "true",
	});
	expect(result.status, result.stderr).toBe(0);
	expect(
		JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}"),
	).toMatchObject({ associationOpens: 1, associationCloses: closes });
});

it("passes the deployment-owned nonsecret installation producer to the Conversation Worker", async () => {
	const path = join(directory, "configuration.mjs");
	const original = await readFile(path, "utf8");
	await writeFile(
		path,
		`${original}
export const connectionInstallation = {
  configuration: {
    schemaVersion: 1,
    ref: "oauth-config",
    revision: "r1",
    clientId: "platform-client",
    callbackUrl: "https://platform.example.test/connection/callback",
    issuer: "https://connection.example.test/",
    authorizationEndpoint: "https://connection.example.test/oauth/authorize",
    tokenEndpoint: "https://connection.example.test/oauth/token",
    revocationEndpoint: "https://connection.example.test/oauth/revoke",
    resource: "https://connection.example.test/mcp",
    scope: "mcp",
    configFingerprint: "26062a8f8e5a003ff8047fead83d76c254d9b54834ca5348fb7e4ceee67d205b",
    source: { ref: "platform-deployment", revision: "r1" },
    runtimeOrigin: "https://runtime.example.test:3443/"
  },
  authorize: async (input, signal, finalCheck) => ({ ...input, revision: "confirmation-r1" })
};
`,
	);
	try {
		const result = run();
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout).installationConfigured).toBe(true);
	} finally {
		await writeFile(path, original);
	}
});

it("assembles the Platform database producer when only approved installation configuration is supplied", async () => {
	const path = join(directory, "configuration.mjs");
	const original = await readFile(path, "utf8");
	await writeFile(
		path,
		`${original}
export const connectionInstallation = {
  configuration: {
    schemaVersion: 1,
    ref: "oauth-config",
    revision: "r1",
    clientId: "platform-client",
    callbackUrl: "https://platform.example.test/connection/callback",
    issuer: "https://connection.example.test/",
    authorizationEndpoint: "https://connection.example.test/oauth/authorize",
    tokenEndpoint: "https://connection.example.test/oauth/token",
    revocationEndpoint: "https://connection.example.test/oauth/revoke",
    resource: "https://connection.example.test/mcp/v1",
    scope: "mcp",
    configFingerprint: "26062a8f8e5a003ff8047fead83d76c254d9b54834ca5348fb7e4ceee67d205b",
    source: { ref: "platform-deployment", revision: "r1" },
    runtimeOrigin: "https://runtime.example.test:3443/"
  },
};
`,
	);
	try {
		const result = run({ RUN_CLOSE_INSTALLATION: "true" });
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout).installationConfigured).toBe(true);
	} finally {
		await writeFile(path, original);
	}
});

const approvedPatInstallationModule = `
export const connectionInstallation = {
  configuration: {
    schemaVersion: 1, ref: "oauth-config", revision: "r1", clientId: "platform-client",
    callbackUrl: "https://platform.example.test/connection/callback",
    issuer: "https://connection.example.test/",
    authorizationEndpoint: "https://connection.example.test/oauth/authorize",
    tokenEndpoint: "https://connection.example.test/oauth/token",
    revocationEndpoint: "https://connection.example.test/oauth/revoke",
    resource: "https://connection.example.test/mcp/v1", scope: "mcp",
    configFingerprint: ${JSON.stringify(connectionConsumerApproval.configFingerprint)},
    source: ${JSON.stringify(connectionConsumerApproval.source)},
    runtimeOrigin: "https://runtime.example.test:3443/",
    patBinding: { consumerId: "platform-worker", bindingEndpoint: "https://connection.example.test/api/v1/connection/pat-bindings" }
  },
  principalBindingsByAgent: {
    "agent-a": {
      configuration: { ref: "oauth-config", revision: "r1" },
      issuer: "https://connection.example.test/",
      principals: { alice: "connection-alice" }
    }
  }
};
connectionInstallation.authorize = undefined;
`;

it("passes only the trusted configuration-module Session OAuth provisioning bundle to the receiver", async () => {
	const path = join(directory, "configuration.mjs");
	const original = await readFile(path, "utf8");
	const bundle = JSON.stringify({
		schemaVersion: 1,
		agentId: "agent-a",
		sessionId: "session-a",
		sandboxId: "sandbox-a",
		sessionGeneration: 1,
		principal: { kind: "user", id: "alice" },
		configuration: {
			schemaVersion: 1,
			ref: "oauth",
			revision: "r1",
			clientId: "client-a",
			issuer: "https://connection.example.test/",
			authorizationEndpoint: "https://connection.example.test/oauth/authorize",
			tokenEndpoint: "https://connection.example.test/oauth/token",
			revocationEndpoint: "https://connection.example.test/oauth/revoke",
			callbackUrl: "https://platform.example.test/callback",
			runtimeOrigin: "https://sandbox-a.worker-binding.svc:3443/",
			resource: "https://connection.example.test/mcp",
			scope: "mcp",
			configFingerprint: "a".repeat(64),
			source: { ref: "approved", revision: "r1" },
		},
		tlsSecretRef: { name: "tls", certKey: "tls.crt", keyKey: "tls.key" },
		callbackAuthSecretRef: { name: "callback", key: "callback.auth" },
		apiSelector: { component: "platform-api" },
	});
	await writeFile(
		path,
		`${original}\nexport const connectionOAuthProvisioning = ${bundle};`,
	);
	try {
		const result = run({ RUN_OAUTH_PROVISIONING: "true" });
		expect(result.status, result.stderr).toBe(0);
		const value = JSON.parse(result.stdout);
		expect(value.provisioning).toMatchObject({
			agentId: "agent-a",
			sessionId: "session-a",
			principal: { id: "alice" },
			configuration: { clientId: "client-a" },
		});
	} finally {
		await writeFile(path, original);
	}
});

it.each(["unconfigured", "manual", "full"] as const)(
	"keeps manual OAuth dormant in the Worker production assembly with %s configuration",
	async (mode) => {
		const path = join(directory, "configuration.mjs");
		const original = await readFile(path, "utf8");
		const { schemaVersion, publicOrigin, mcpPath, audience, egressProfile } =
			connectionConsumerProfile;
		const systemAccess = {
			schemaVersion: schemaVersion as 1,
			publicOrigin,
			mcpPath,
			audience,
			egressProfile,
			issuer: `${publicOrigin}/`,
			oauthCallbackUrl: "https://platform.example.test/connection/callback",
		};
		const approval = {
			...connectionConsumerApproval,
			configFingerprint: connectionSystemAccessFingerprintV1(systemAccess),
		};
		const bootstrap =
			mode === "unconfigured"
				? ""
				: `export const connectionInstallBootstrap = {
			port: 3445, clientName: "synthetic-install-name", workerOrigin: "https://worker.worker-binding.svc:3446/",
			configuration: ${JSON.stringify(systemAccess)}, approval: ${JSON.stringify(approval)},
			tlsSecretForSandbox: () => ({ name: "fixture-tls", certKey: "tls.crt", keyKey: "tls.key" }),
			callbackAuthSecretRef: { name: "fixture-callback", key: "callback.auth" },
			workerCaSecretRef: { name: "fixture-worker-ca", key: "ca.crt" },
			apiSelector: { component: "platform-api" },
		};`;
		const worker =
			mode === "full"
				? `export const connectionInstallWorker = {
			hostCaFile: "/fixture-must-not-read/ca.crt", readbackCertFile: "/fixture-must-not-read/server.crt",
			readbackKeyFile: "/fixture-must-not-read/server.key", keyring: { keys: [] },
		};`
				: "";
		try {
			for (const standard of [false, true]) {
				await writeFile(
					path,
					`${original}
${bootstrap}
${worker}
${
	standard
		? `${approvedPatInstallationModule}
delete connectionInstallation.configuration.patBinding;`
		: ""
}`,
				);
				const result = run({ RUN_MANUAL_DORMANCY: "true" });
				expect(result.status, result.stderr).toBe(0);
				expect(JSON.parse(result.stdout)).toEqual({
					manualDrain: false,
					manualBootstrap: false,
					standard: standard ? "platform-client" : null,
				});
				expect(result.stderr.trim()).toBe(
					mode === "unconfigured"
						? ""
						: JSON.stringify({
								service: "platform-worker",
								code: "CONNECTION_MANUAL_INSTALLATION_DORMANT",
								// #4199 C2: without an exception approval record the route stays dormant.
								reason: "exception_approval_missing",
							}),
				);
			}
		} finally {
			await writeFile(path, original);
		}
	},
);

it.each([
	["legacy OAuth", false, true, false],
	["approved OAuth", true, true, true],
	["OAuth without supply", true, false, false],
	["PAT", true, true, false],
] as const)(
	"projects publication from explicit %s deployment approval",
	async (route, publishOAuth, supply, expected) => {
		const path = join(directory, "configuration.mjs");
		const original = await readFile(path, "utf8");
		await writeFile(
			path,
			`${original}\n${approvedPatInstallationModule}\n${route === "PAT" ? "" : "delete connectionInstallation.configuration.patBinding;"}\n${publishOAuth ? "connectionInstallation.publishOAuth=true;" : ""}\n${supply ? 'export const connectionInstallationSupply={ref:"approved-publication",revision:"r1"};' : ""}\n`,
		);
		try {
			const result = run({ RUN_PUBLICATION: "true" });
			expect(result.status, result.stderr).toBe(0);
			expect(JSON.parse(result.stdout).publication).toBe(expected);
		} finally {
			await writeFile(path, original);
		}
	},
);

it("never publishes OAuth from static per-Agent deployment entries (#4157)", async () => {
	const path = join(directory, "configuration.mjs");
	const original = await readFile(path, "utf8");
	const setup = `${original}\n${approvedPatInstallationModule}\nconst oauth={...connectionInstallation.configuration};delete oauth.patBinding;connectionInstallation.configuration=undefined;delete connectionInstallation.configuration;connectionInstallation.configurationsByAgent={"agent-a":oauth,"agent-b":{...oauth,patBinding:{consumerId:"platform-worker",bindingEndpoint:"https://connection.example.test/api/v1/connection/pat-bindings"}},"agent-c":oauth};connectionInstallation.publishOAuth=true;\nexport const connectionConsumerProfilesByAgent={"agent-a":{profile:connectionConsumerProfile,approval:connectionConsumerApproval},"agent-b":{profile:connectionConsumerProfile,approval:connectionConsumerApproval},"agent-c":{profile:connectionConsumerProfile,approval:connectionConsumerApproval}};\nexport const connectionInstallationSuppliesByAgent={"agent-a":{ref:"supply-a",revision:"r1"},"agent-b":{ref:"supply-b",revision:"r1"}};\n`;
	await writeFile(path, setup);
	try {
		const result = run({ RUN_PUBLICATION: "true" });
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			publication: false,
			publications: null,
		});
	} finally {
		await writeFile(path, original);
	}
});

it.each([
	"connectionInstallationOAuthPublication",
	"connectionInstallationOAuthPublicationsByAgent",
])(
	"rejects direct publication policy override %s before preparation",
	async (key) => {
		const path = join(directory, "configuration.mjs");
		const original = await readFile(path, "utf8");
		await writeFile(
			path,
			`${original}\nworkloadInput.policy[${JSON.stringify(key)}]=true;\n`,
		);
		try {
			const result = run();
			expect(result.status).toBe(1);
			expect(JSON.parse(result.stdout)).toEqual({
				error: "CONNECTION_INSTALLATION_SUPPLY_UNAVAILABLE",
				calls: [],
			});
		} finally {
			await writeFile(path, original);
		}
	},
);

it.each(
	["PAT", "OAuth"].flatMap((route) =>
		[
			"approved",
			"core-denied",
			"final-check-denied",
			"revoked-after-final-check",
		].map((mode) => [route, mode] as const),
	),
)(
	"assembles and executes default %s authorization with principal bindings (%s)",
	async (route, mode) => {
		const path = join(directory, "configuration.mjs");
		const original = await readFile(path, "utf8");
		await writeFile(
			path,
			`${original}\n${approvedPatInstallationModule}\n${route === "OAuth" ? "delete connectionInstallation.configuration.patBinding;" : ""}`,
		);
		try {
			const result = run({
				RUN_INSTALLATION_APPROVAL: mode,
			});
			expect(result.status, result.stderr).toBe(0);
			const value = JSON.parse(result.stdout);
			expect(value.workloadReady).toBe(true);
			expect(value.configured).toBe(true);
			expect(value.reads).toBe(
				mode === "core-denied" || mode === "final-check-denied" ? 1 : 2,
			);
			expect(value.finalChecks).toBe(mode === "core-denied" ? 0 : 1);
			if (mode === "approved") {
				expect(value.result).toMatchObject({
					principal: { kind: "user", id: "alice" },
					connectionPrincipalId: "connection-alice",
					revision: "confirmation-r1",
				});
			} else expect(value.result).toBeNull();
		} finally {
			await writeFile(path, original);
		}
	},
);

it.each([
	[
		"wrong issuer",
		'connectionInstallation.principalBindingsByAgent["agent-a"].issuer="https://foreign.example.test/";',
	],
	[
		"old configuration",
		'connectionInstallation.principalBindingsByAgent["agent-a"].configuration.revision="old";',
	],
	[
		"invalid principal",
		'connectionInstallation.principalBindingsByAgent["agent-a"].principals.alice="";',
	],
	[
		"conflicting users",
		'connectionInstallation.principalBindingsByAgent["agent-a"].principals.bob="connection-alice";',
	],
	[
		"custom producer conflict",
		"connectionInstallation.authorize=async()=>null;",
	],
])(
	"isolates invalid principal bindings from ordinary Workload assembly (%s)",
	async (_label, mutation) => {
		const path = join(directory, "configuration.mjs");
		const original = await readFile(path, "utf8");
		await writeFile(
			path,
			`${original}\n${approvedPatInstallationModule}\n${mutation}\n`,
		);
		try {
			const result = run({ RUN_INSTALLATION_APPROVAL: "invalid-mapping" });
			expect(result.status, result.stderr).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual({
				result: null,
				reads: 0,
				finalChecks: 0,
				workloadReady: true,
				configured: false,
			});
		} finally {
			await writeFile(path, original);
		}
	},
);

it.each([
	"export const connectionInstallation = null;",
	"export const connectionInstallation = 'malformed';",
	"export const connectionInstallation = [];",
	"export const connectionInstallation = { configuration: {} };",
	"export const connectionInstallation = { configuration: {}, authorize: true };",
	"export const connectionInstallation = { configuration: {}, authorize: () => {}, extra: true };",
	"export const connectionInstallation = { configurationsByAgent: { 'agent-a': {} } };",
])(
	"disables malformed installation producer configuration without stopping ordinary assembly (%#)",
	async (entry) => {
		const path = join(directory, "configuration.mjs");
		const original = await readFile(path, "utf8");
		await writeFile(path, `${original}\n${entry}\n`);
		try {
			const result = run({ RUN_INSTALLATION_MAP: "true" });
			expect(result.status, result.stderr).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual({
				hasCommandStore: false,
				configurations: null,
				workloadReady: true,
				shared: null,
			});
			await writeFile(
				path,
				`${original.replace('"egressEnforced":true', '"egressEnforced":false')}\n${entry}\n`,
			);
			const control = run({ RUN_INVALID_PROFILE: "true" });
			expect(control.status, control.stderr).toBe(0);
			expect(JSON.parse(control.stdout)).toMatchObject({
				control: "original-control",
				business: "CONNECTION_CONSUMER_PROFILE_UNAVAILABLE",
				snapshot: null,
			});
		} finally {
			await writeFile(path, original);
		}
	},
);

it("keeps the original control resolver when configured approval is unavailable", async () => {
	const path = join(directory, "configuration.mjs");
	const original = await readFile(path, "utf8");
	await writeFile(
		path,
		original.replace('"egressEnforced":true', '"egressEnforced":false'),
	);
	try {
		const result = run({ RUN_INVALID_PROFILE: "true" });
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			control: "original-control",
			business: "CONNECTION_CONSUMER_PROFILE_UNAVAILABLE",
			snapshot: null,
		});
	} finally {
		await writeFile(path, original);
	}
});

it.each([
	undefined,
	"",
	"not-a-url-secret",
	"https://user:synthetic-secret@db.test/platform",
	"postgresql:///platform",
	"postgresql://db.test/",
])(
	"rejects invalid database binding before constructing dependencies (%#)",
	(value) => {
		const result = run({ PLATFORM_DATABASE_URL: value });
		expect(result.status).toBe(1);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toEqual({
			error: "PLATFORM_DATABASE_URL must name a PostgreSQL database",
			calls: [],
		});
	},
);

it.each([
	undefined,
	"",
	"other-namespace",
	"INVALID",
	"bad_namespace",
	"-bad",
	"bad-",
	"a".repeat(64),
])(
	"rejects missing, invalid or mismatched namespace before constructing dependencies (%#)",
	(value) => {
		const result = run({ PLATFORM_WORKER_NAMESPACE: value });
		expect(result.status).toBe(1);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toEqual({
			error:
				"PLATFORM_WORKER_NAMESPACE must match the workload policy namespace",
			calls: [],
		});
	},
);

it("captures the deployment supply before preparation and ignores later object mutation", async () => {
	const path = join(directory, "configuration.mjs");
	const original = await readFile(path, "utf8");
	await writeFile(
		path,
		`${original}\nexport const connectionInstallationSupply = { ref: "private-runtime-export", revision: "r7" };\n`,
	);
	try {
		const result = run({ RUN_MUTATE_SUPPLY: "true" });
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout).installation).toBe(
			'["private-runtime-export","r7"]',
		);
	} finally {
		await writeFile(path, original);
	}
});
it.each([
	{ ref: "/caller", revision: "r1" },
	{ ref: "approved-export", revision: "r1", token: "input-sentinel" },
])(
	"retains original control but blocks business for invalid supply (%#)",
	async (supply) => {
		const path = join(directory, "configuration.mjs");
		const original = await readFile(path, "utf8");
		await writeFile(
			path,
			`${original}\nexport const connectionInstallationSupply = ${JSON.stringify(supply)};\n`,
		);
		try {
			const result = run({ RUN_INVALID_PROFILE: "true" });
			expect(result.status, result.stderr).toBe(0);
			expect(JSON.parse(result.stdout)).toMatchObject({
				control: "original-control",
				business: "CONNECTION_INSTALLATION_SUPPLY_UNAVAILABLE",
				installation: null,
			});
			expect(result.stdout).not.toContain("input-sentinel");
		} finally {
			await writeFile(path, original);
		}
	},
);
it("rejects a supply without approved Consumer input", async () => {
	const path = join(directory, "configuration.mjs");
	const original = await readFile(path, "utf8");
	const withoutProfile = original.replace(
		/^export const connectionConsumer(?:Profile|Approval) = .*;$/gm,
		"",
	);
	await writeFile(
		path,
		`${withoutProfile}\nexport const connectionInstallationSupply = { ref: "private-runtime-export", revision: "r7" };\n`,
	);
	try {
		const result = run({ RUN_INVALID_PROFILE: "true" });
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			control: "original-control",
			business: "CONNECTION_INSTALLATION_SUPPLY_UNAVAILABLE",
			installation: null,
		});
	} finally {
		await writeFile(path, original);
	}
});
it("rejects the internal policy selector override before constructing dependencies", async () => {
	const path = join(directory, "configuration.mjs");
	const original = await readFile(path, "utf8");
	await writeFile(
		path,
		`${original}\nworkloadInput.policy.connectionInstallationRevision = '["caller","r1"]';\n`,
	);
	try {
		const result = run();
		expect(result.status).toBe(1);
		expect(JSON.parse(result.stdout)).toEqual({
			error: "CONNECTION_INSTALLATION_SUPPLY_UNAVAILABLE",
			calls: [],
		});
	} finally {
		await writeFile(path, original);
	}
});

it.each(["valid", "bad configuration", "bad Agent ID", "shared fallback"])(
	"never assembles a static per-Agent installation (%s, #4157)",
	async (mode) => {
		const path = join(directory, "configuration.mjs");
		const original = await readFile(path, "utf8");
		const profileB = {
			...connectionConsumerProfile,
			schemaVersion: 1 as const,
			consumerId: "consumer-b",
		};
		const approvalB = {
			...connectionConsumerApproval,
			configFingerprint: connectionConsumerProfileFingerprintV1(profileB),
		};
		const configurationFor = (clientId: string, fingerprint: string) => ({
			schemaVersion: 1,
			ref: clientId,
			revision: "r1",
			clientId,
			callbackUrl: "https://platform.example.test/connection/callback",
			issuer: "https://connection.example.test/",
			authorizationEndpoint: "https://connection.example.test/oauth/authorize",
			tokenEndpoint: "https://connection.example.test/oauth/token",
			revocationEndpoint: "https://connection.example.test/oauth/revoke",
			resource: "https://connection.example.test/mcp/v1",
			scope: "mcp",
			configFingerprint: fingerprint,
			source: connectionConsumerApproval.source,
			runtimeOrigin: "https://runtime.example.test:3443/",
		});
		const configurationsByAgent = {
			"agent-a": configurationFor(
				"client-a",
				connectionConsumerApproval.configFingerprint,
			),
			"agent-b": configurationFor("client-b", approvalB.configFingerprint),
		};
		const installation: Record<string, unknown> = { configurationsByAgent };
		if (mode === "bad configuration")
			installation.configurationsByAgent = {
				...configurationsByAgent,
				"agent-b": {},
			};
		if (mode === "bad Agent ID")
			installation.configurationsByAgent = {
				...configurationsByAgent,
				"bad id": configurationsByAgent["agent-b"],
			};
		if (mode === "shared fallback")
			installation.configuration = configurationsByAgent["agent-a"];
		try {
			await writeFile(
				path,
				`${original}
export const connectionConsumerProfilesByAgent=${JSON.stringify({ "agent-a": { profile: connectionConsumerProfile, approval: connectionConsumerApproval }, "agent-b": { profile: profileB, approval: approvalB } })};
export const connectionInstallationSuppliesByAgent=${JSON.stringify({ "agent-a": { ref: "installation-a", revision: "r1" }, "agent-b": { ref: "installation-b", revision: "r1" } })};
export const connectionInstallation=${JSON.stringify(installation)};
`,
			);
			const result = run({
				RUN_CLOSE_INSTALLATION: "true",
				RUN_INSTALLATION_MAP: "true",
			});
			expect(result.status, result.stderr).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual({
				hasCommandStore: false,
				configurations: null,
				workloadReady: true,
				shared: null,
			});
		} finally {
			await writeFile(path, original);
		}
	},
);

it("keeps ordinary Workload assembly but disables per-Agent OAuth without per-Agent profiles", async () => {
	const path = join(directory, "configuration.mjs");
	const original = await readFile(path, "utf8");
	try {
		await writeFile(
			path,
			`${original}\nexport const connectionInstallation={configurationsByAgent:{},authorize:async(input)=>input};\n`,
		);
		const result = run({
			RUN_CLOSE_INSTALLATION: "true",
			RUN_INSTALLATION_MAP: "true",
		});
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			hasCommandStore: false,
			configurations: null,
			workloadReady: true,
			shared: null,
		});
	} finally {
		await writeFile(path, original);
	}
});

it("passes the deployment-owned Eval factory and cleanup limits through the actual entry", async () => {
	const path = join(directory, "configuration.mjs");
	const original = await readFile(path, "utf8");
	try {
		await writeFile(
			path,
			`${original}
import {createEvaluationObjectStorageV1} from ${JSON.stringify(new URL("../../../packages/object-storage/dist/index.mjs", import.meta.url).href)};
const evaluationStorage=createEvaluationObjectStorageV1({region:'fixture',bucket:'fixture',endpoint:'http://127.0.0.1:1',maxObjectBytes:1024,timeoutMs:1000});
workloadInput.evaluation={storage:evaluationStorage,batchSize:7,timeoutMs:3000,closeStorage:()=>evaluationStorage.close(),loadAnalysisPolicy:async()=>({schemaVersion:1,policyId:"fixture-analysis",revision:1,validUntil:"2027-01-01T00:00:00.000Z",maximumWindowMs:86400000,maximumTasks:100,maximumModelFacts:1000,feedbackMetadataMs:600000})};
workloadInput.evaluationScoring={storage:evaluationStorage,loadDataPolicy:async()=>({}),loadExperimentPolicy:async()=>({}),batchSize:7,leaseMs:30000,retryDelayMs:1000};
`,
		);
		const result = run({ RUN_EVALUATION: "true" });
		expect(result.status, result.stderr + result.stdout).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			batchSize: 7,
			timeoutMs: 3000,
			hasCleanupStorage: true,
			hasScorer: true,
			scorerLeaseMs: 30000,
			sharedStorage: true,
			hasAnalysisPolicy: true,
		});
	} finally {
		await writeFile(path, original);
	}
});

it("keeps the production reserve factory disabled when no policy is mounted", () => {
	const result = run({ RUN_RESERVE_OPTIONS: "true" });
	expect(result.status, result.stderr).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual({ configured: false });
});
it("accepts explicit disabled policy for draining but rejects a different namespace", async () => {
	const path = join(directory, "configuration.mjs");
	const original = await readFile(path, "utf8");
	const policy = {
		schemaVersion: 1,
		revision: 1,
		enabled: false,
		namespace: "worker-binding",
		totalBudget: { cpuMillis: 0, memoryBytes: 0, storageBytes: 0 },
		resourceCosts: [],
		profiles: [],
		maximumReserves: 0,
		maximumConcurrentCreates: 0,
		ttlMs: 0,
		cooldownMs: 0,
		failureBackoffMs: 0,
	};
	try {
		await writeFile(
			path,
			`${original}\nexport const sessionSandboxReserves = ${JSON.stringify(policy)};\n`,
		);
		const valid = run({ RUN_RESERVE_OPTIONS: "true" });
		expect(valid.status, valid.stderr).toBe(0);
		expect(JSON.parse(valid.stdout)).toEqual({
			configured: true,
			enabled: false,
			revision: 1,
			namespace: "worker-binding",
			databaseUrl: database,
		});
		await writeFile(
			path,
			`${original}\nexport const sessionSandboxReserves = ${JSON.stringify({ ...policy, namespace: "foreign" })};\n`,
		);
		const invalid = run({ RUN_RESERVE_OPTIONS: "true" });
		expect(invalid.status).toBe(1);
		expect(JSON.parse(invalid.stdout).error).toBe(
			"SESSION_RESERVE_DEPLOYMENT_CONFIGURATION_INVALID",
		);
	} finally {
		await writeFile(path, original);
	}
});

it.each([
	"valid",
	"bad configuration",
	"shared fallback",
	"per-Agent fallback",
	"missing profiles",
])(
	"never assembles a deployment-supplied user installation index (%s, #4157)",
	async (mode) => {
		const path = join(directory, "configuration.mjs");
		const original = await readFile(path, "utf8");
		const configFor = (userId: string) => {
			const c = {
				schemaVersion: 1 as const,
				ref: `oauth-${userId}`,
				revision: "pending",
				clientId: `client-${userId}`,
				callbackUrl: "https://platform.example.test/connection/callback",
				issuer: "https://connection.example.test/",
				authorizationEndpoint:
					"https://connection.example.test/oauth/authorize",
				tokenEndpoint: "https://connection.example.test/oauth/token",
				revocationEndpoint: "https://connection.example.test/oauth/revoke",
				resource: "https://connection.example.test/mcp/v1",
				scope: "mcp" as const,
				configFingerprint: connectionConsumerApproval.configFingerprint,
				source: connectionConsumerApproval.source,
				runtimeOrigin: "https://runtime.example.test:3443/",
			};
			return { ...c, revision: runtimeOAuthConfigurationRevisionV1(c) };
		};
		const alice = configFor("alice");
		const bob = configFor("bob");
		const configurationsByAgentAndPrincipal = { "agent-a": { alice, bob } };
		const principalBindingsByAgentAndPrincipal = {
			"agent-a": Object.fromEntries(
				Object.entries({ alice, bob }).map(([userId, c]) => [
					userId,
					{
						issuer: c.issuer,
						configuration: { ref: c.ref, revision: c.revision },
						connectionPrincipalId: `connection-${userId}`,
					},
				]),
			),
		};
		const installation = {
			configurationsByAgentAndPrincipal,
			principalBindingsByAgentAndPrincipal,
			...(mode === "shared fallback" ? { configuration: alice } : {}),
			...(mode === "per-Agent fallback"
				? { configurationsByAgent: { "agent-a": alice } }
				: {}),
		};
		if (mode === "bad configuration")
			bob.clientId = "replaced-without-revision";
		try {
			await writeFile(
				path,
				`${original}\n${mode === "missing profiles" ? "" : `export const connectionConsumerProfilesByAgent=${JSON.stringify({ "agent-a": { profile: connectionConsumerProfile, approval: connectionConsumerApproval } })};`}\n${mode === "missing profiles" ? "" : 'export const connectionInstallationSuppliesByAgent={"agent-a":{ref:"supply-a",revision:"r1"}};'}\nexport const connectionInstallation=${JSON.stringify(installation)};\n`,
			);
			const result = run({
				RUN_CLOSE_INSTALLATION: "true",
				RUN_PRINCIPAL_INSTALLATION_MAP: "true",
			});
			expect(result.status, result.stderr).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual({
				hasCommandStore: false,
				configurations: null,
				workloadReady: true,
				shared: null,
			});
		} finally {
			await writeFile(path, original);
		}
	},
);

it("reads Session images with this module's own receiver authority and prepares nothing", async () => {
	const path = join(directory, "configuration.mjs");
	const original = await readFile(path, "utf8");
	const namespace = "worker-binding";
	const policy = {
		...workloadTestPolicy,
		namespace,
		runtimeAuth: sessionSandboxRuntimeAuthFixture,
	};
	const desired = workloadDesiredFixture(1, "agent-a", "internal-only");
	const sandboxId = "00000000-0000-4000-8000-000000000001";
	const binding = {
		schemaVersion: 1,
		sandboxId,
		sessionId: "conversation-a",
		agentId: "agent-a",
		principal: { kind: "user", id: "actor-a" },
		channelId: "web",
		generation: 1,
		resourceName: `sandbox-${sandboxId}`,
		workspaceScope: sandboxId,
	};
	const storePolicy = {
		namespace,
		resourceConfigurationHash: workloadResourceConfigurationHashV1(policy),
		configurationRevision: 1,
		workloadRevision: 1,
		managementFence: 1,
		imageDigest: desired.imageDigest,
	};
	const input = {
		source: "allocation",
		binding,
		resourceFence: 1,
		policy: storePolicy,
		deployment: desired,
		modelProjection: sessionSandboxModelProjectionFixture({
			agentId: "agent-a",
			configurationRevision: 1,
			imageDigest: desired.imageDigest,
		}),
		inputHash: "a".repeat(64),
	};
	const readback = {
		namespace,
		observedAtDatabase: "2026-11-16T00:00:00.000Z",
		storeSnapshot: "10:10:",
		pageCount: 1,
		enumerationComplete: true,
		emptyAfterCompleteEnumeration: false,
		scope: "namespace-and-unattributed-allocations",
		items: [
			{
				metadata: {
					binding,
					bindingKey: `session:${sandboxId}`,
					bindingStatus: "VERIFIED_STORE_COMPOSITE",
					resourceFence: 1,
					status: "unknown",
					desiredState: "running",
					namespace,
					policy: storePolicy,
					snapshotReadCas: { workloadRevision: 1, fence: 1 },
					ownerIds: ["owner-a"],
					inputStatus: "STORED_INPUTS_BOUND",
					missing: [],
					casHash: "b".repeat(64),
				},
				inputs: [input],
			},
		],
	};
	const context = {
		platformSource: "2".repeat(40),
		runtimeAuthority: "4".repeat(40),
		planHash: "a".repeat(64),
		clusterUid: "cluster",
		namespace,
		namespaceUid: "namespace-uid",
		release: "release",
		helmRevision: 46,
		installationId: "installation",
		directoryBindingHash: "b".repeat(64),
		directorySnapshotHash: "c".repeat(64),
	};
	const request = {
		schemaVersion: 1,
		context,
		targets: [{ sandboxId, inputHash: input.inputHash }],
	};
	const configuration = `export const workloadInput = { databaseUrl: 'postgresql://stale.example.test/stale', policy: ${JSON.stringify(policy)}, templateModelBindings: ${JSON.stringify([sessionSandboxTemplateBindingFixture(desired.imageDigest)])} };
export const signing = { workerId: ${JSON.stringify(sessionSandboxRuntimeAuthFixture.workerId)} };
export const serviceToken = ${JSON.stringify(sessionSandboxDeploymentTokenFixture)};
`;
	const reserves = (sourceSha?: string) => ({
		schemaVersion: 1,
		enabled: false,
		revision: 6,
		namespace,
		totalBudget: { cpuMillis: 0, memoryBytes: 0, storageBytes: 0 },
		resourceCosts: [],
		maximumReserves: 0,
		maximumConcurrentCreates: 0,
		ttlMs: 0,
		cooldownMs: 0,
		failureBackoffMs: 0,
		profiles: [],
		...(sourceSha ? { sourceSha } : {}),
	});
	const declared = join(directory, "session-image-reserves.json");
	const undeclared = join(directory, "session-image-reserves-unsourced.json");
	try {
		await writeFile(path, configuration);
		await writeFile(
			declared,
			JSON.stringify(reserves(context.runtimeAuthority)),
		);
		await writeFile(undeclared, JSON.stringify(reserves()));
		const result = run({
			PLATFORM_WORKER_SESSION_RESERVES_FILE: declared,
			RUN_SESSION_IMAGES: JSON.stringify({ request, readback }),
		});
		expect(result.status, result.stderr).toBe(0);
		const output = JSON.parse(result.stdout);
		expect(output.calls).toEqual([]);
		expect(output.registrationReads).toBe(0);
		expect(output.reads).toEqual([namespace]);
		expect(output.closes).toBe(2);
		expect(output.readerUrls).toHaveLength(2);
		expect(output.readerUrls[1]).toBe(output.readerUrls[0]);
		const url = new URL(output.readerUrls[0]);
		expect(url.host).toBe("database.example.test");
		expect(url.searchParams.get("options")).toContain(
			"default_transaction_read_only=on",
		);
		expect(output.receipt.targetScopeStatus).toBe("ALL_TARGETS_PROJECTED");
		expect(output.receipt.authority).toMatchObject({
			sourceSha: context.runtimeAuthority,
			configurationHash: createHash("sha256")
				.update(configuration)
				.digest("hex"),
			namespace,
			resourceConfigurationHash: storePolicy.resourceConfigurationHash,
			templateBindingCount: 1,
			oauthProvisioningConfigured: false,
		});
		expect(output.receipt.rows[0].groups[0]).toMatchObject({
			status: "PROJECTED_IMAGES",
			images: [
				{
					kind: "main",
					image: `${policy.imageRepository}@${desired.imageDigest}`,
				},
			],
			podIdentity: { serviceAccountName: binding.resourceName },
		});
		expect(result.stdout).not.toContain(sessionSandboxDeploymentTokenFixture);
		expect(result.stdout).not.toContain("owner-a");

		for (const [change, environment] of [
			[
				{ ...request, context: { ...context, namespace: "other" } },
				{ PLATFORM_WORKER_SESSION_RESERVES_FILE: declared },
			],
			[
				request,
				{
					PLATFORM_WORKER_NAMESPACE: "other",
					PLATFORM_WORKER_SESSION_RESERVES_FILE: declared,
				},
			],
			// No deployment-declared configuration source: the caller cannot name one.
			[request, { PLATFORM_WORKER_SESSION_RESERVES_FILE: undeclared }],
			[request, {}],
		] as const) {
			const rejected = run({
				...environment,
				RUN_SESSION_IMAGES: JSON.stringify({ request: change, readback }),
			});
			expect(rejected.status, rejected.stderr).toBe(0);
			expect(JSON.parse(rejected.stdout)).toEqual({
				error: "WORKER_SESSION_IMAGE_AUTHORITY_UNAVAILABLE",
				calls: [],
				readerUrls: [],
				reads: [],
				closes: 0,
				registrationReads: 0,
			});
		}
	} finally {
		await writeFile(path, original);
		await rm(declared, { force: true });
		await rm(undeclared, { force: true });
	}
});

it("reads Agent Workload images with this module's own Workload authority and prepares nothing", async () => {
	const path = join(directory, "configuration.mjs");
	const original = await readFile(path, "utf8");
	const namespace = "worker-binding";
	const policy = {
		...workloadTestPolicy,
		namespace,
		runtimeAuth: sessionSandboxRuntimeAuthFixture,
	};
	const context = {
		platformSource: "2".repeat(40),
		runtimeAuthority: "4".repeat(40),
		planHash: "a".repeat(64),
		clusterUid: "cluster",
		namespace,
		namespaceUid: "namespace-uid",
		release: "release",
		helmRevision: 46,
		installationId: "installation",
		directoryBindingHash: "b".repeat(64),
		directorySnapshotHash: "c".repeat(64),
	};
	const request = {
		schemaVersion: 1,
		context,
		target: {
			agentId: "agent-a",
			proposal: {
				schemaVersion: 1,
				command: "upgrade_custom_image",
				imageReference: `${policy.imageRepository}@sha256:${"4".repeat(64)}`,
			},
		},
	};
	// A standard Agent: the receipt is stable UNKNOWN before any Registry call.
	const observed = {
		management: { revision: 3, workloadRevision: 1, desiredState: "running" },
		configuration: {
			agentId: "agent-a",
			revision: 2,
			source: { kind: "standard", templateId: "template-a" },
			ownerIds: ["owner-a"],
		},
		state: null,
	};
	const configuration = (admission = true) =>
		`export const workloadInput = { databaseUrl: 'postgresql://stale.example.test/stale', policy: ${JSON.stringify(policy)}${admission ? ", admissionPolicyRef: 'policy-a', registrySubjectRef: 'subject-a'" : ""} };
export const signing = { workerId: ${JSON.stringify(sessionSandboxRuntimeAuthFixture.workerId)} };
export const serviceToken = ${JSON.stringify(sessionSandboxDeploymentTokenFixture)};
`;
	const reserves = (sourceSha?: string) => ({
		schemaVersion: 1,
		enabled: false,
		revision: 6,
		namespace,
		totalBudget: { cpuMillis: 0, memoryBytes: 0, storageBytes: 0 },
		resourceCosts: [],
		maximumReserves: 0,
		maximumConcurrentCreates: 0,
		ttlMs: 0,
		cooldownMs: 0,
		failureBackoffMs: 0,
		profiles: [],
		...(sourceSha ? { sourceSha } : {}),
	});
	const declared = join(directory, "agent-image-reserves.json");
	const hostnameFile = join(directory, "agent-hostname-routes.json");
	try {
		await writeFile(path, configuration());
		await writeFile(
			declared,
			JSON.stringify(reserves(context.runtimeAuthority)),
		);
		const result = run({
			PLATFORM_WORKER_SESSION_RESERVES_FILE: declared,
			RUN_AGENT_WORKLOAD_IMAGES: JSON.stringify({ request, observed }),
		});
		expect(result.status, result.stderr).toBe(0);
		const output = JSON.parse(result.stdout);
		expect(output.calls).toEqual([]);
		expect(output.reads).toEqual(["agent-a", "agent-a"]);
		expect(output.actors).toEqual([
			"platform-worker-agent-workload-image-preview",
			"platform-worker-agent-workload-image-preview",
		]);
		expect(output.readerUrls).toHaveLength(3);
		expect(output.closes).toBe(3);
		for (const value of output.readerUrls) {
			const url = new URL(value);
			expect(url.host).toBe("database.example.test");
			expect(url.searchParams.get("options")).toContain(
				"default_transaction_read_only=on",
			);
		}
		expect(output.receipt).toMatchObject({
			kind: "worker-agent-workload-demand-images",
			authority: {
				sourceSha: context.runtimeAuthority,
				configurationHash: createHash("sha256")
					.update(configuration())
					.digest("hex"),
				namespace,
				imageRepository: policy.imageRepository,
			},
			target: {
				status: "UNKNOWN",
				reason: "WRONG_RESOURCE_FAMILY",
				images: [],
			},
			storeReads: { contextStable: true, readCount: 2 },
		});
		expect(result.stdout).not.toContain(sessionSandboxDeploymentTokenFixture);
		expect(result.stdout).not.toContain("owner-a");

		const hostnameRoutes = {
			hostSuffix: "agents.example.test",
			platformOrigin: "https://platform.example.test",
			clusterIssuerName: "letsencrypt-http01-staging",
			agentIds: ["agent-a"],
		};
		const hostnameBytes = JSON.stringify({
			schemaVersion: 1,
			enabled: true,
			namespace,
			hostnameRoutes,
		});
		await writeFile(hostnameFile, hostnameBytes);
		const configured = run({
			PLATFORM_WORKER_SESSION_RESERVES_FILE: declared,
			PLATFORM_WORKER_HOSTNAME_ROUTES_FILE: hostnameFile,
			RUN_AGENT_WORKLOAD_IMAGES: JSON.stringify({ request, observed }),
		});
		expect(configured.status, configured.stderr).toBe(0);
		const configuredOutput = JSON.parse(configured.stdout);
		expect(configuredOutput.calls).toEqual([]);
		expect(configuredOutput.receipt.authority).toMatchObject({
			hostnameRoutes,
			hostnameRouteConfigurationHash: createHash("sha256")
				.update(hostnameBytes)
				.digest("hex"),
			configurationHash: output.receipt.authority.configurationHash,
		});
		expect(configuredOutput.receipt.authority.imagePolicyHash).not.toBe(
			output.receipt.authority.imagePolicyHash,
		);
		expect(configuredOutput.receipt.target).toMatchObject({
			status: "UNKNOWN",
			reason: "WRONG_RESOURCE_FAMILY",
			images: [],
		});
		expect(await readFile(path, "utf8")).toBe(configuration());

		for (const [change, environment, module] of [
			[
				{ ...request, context: { ...context, namespace: "other" } },
				{ PLATFORM_WORKER_SESSION_RESERVES_FILE: declared },
				configuration(),
			],
			[
				request,
				{
					PLATFORM_WORKER_NAMESPACE: "other",
					PLATFORM_WORKER_SESSION_RESERVES_FILE: declared,
				},
				configuration(),
			],
			// No deployment-declared configuration source: the caller cannot name one.
			[request, {}, configuration()],
			// The Workload admission references are part of the authority.
			[
				request,
				{ PLATFORM_WORKER_SESSION_RESERVES_FILE: declared },
				configuration(false),
			],
		] as const) {
			await writeFile(path, module);
			const rejected = run({
				...environment,
				RUN_AGENT_WORKLOAD_IMAGES: JSON.stringify({
					request: change,
					observed,
				}),
			});
			expect(rejected.status, rejected.stderr).toBe(0);
			expect(JSON.parse(rejected.stdout)).toEqual({
				error: "WORKER_AGENT_WORKLOAD_IMAGE_AUTHORITY_UNAVAILABLE",
				calls: [],
				readerUrls: [],
				reads: [],
				actors: [],
				closes: 0,
			});
		}
	} finally {
		await writeFile(path, original);
		await rm(declared, { force: true });
		await rm(hostnameFile, { force: true });
	}
	// Six cold deployment processes need a budget beyond one process timeout.
}, 90_000);

it("loads a scoped hostname declaration without rewriting legacy Worker configuration", async () => {
	const path = join(directory, "configuration.mjs");
	const original = await readFile(path, "utf8");
	const file = join(directory, "hostname-routes.json");
	const hostnameRoutes = {
		hostSuffix: "apps.example.test",
		platformOrigin: "https://platform.example.test",
		clusterIssuerName: "letsencrypt-http01-staging",
		agentIds: ["agent-a"],
	};
	try {
		await writeFile(
			path,
			original +
				'\nworkloadInput.policy={...workloadInput.policy,routeHostSuffix:"legacy.example.test",tlsSecretName:"legacy-tls"};\n',
		);
		const moduleBytes = await readFile(path, "utf8");
		await writeFile(
			file,
			JSON.stringify({
				schemaVersion: 1,
				enabled: true,
				namespace: "worker-binding",
				hostnameRoutes,
			}),
		);
		const configured = run({
			RUN_HOSTNAME_POLICY: "true",
			PLATFORM_WORKER_HOSTNAME_ROUTES_FILE: file,
		});
		expect(configured.status, configured.stderr + configured.stdout).toBe(0);
		expect(JSON.parse(configured.stdout)).toMatchObject({
			routeHostSuffix: "legacy.example.test",
			tlsSecretName: "legacy-tls",
			hostnameRoutes,
		});
		expect(await readFile(path, "utf8")).toBe(moduleBytes);
		await writeFile(
			file,
			JSON.stringify({
				schemaVersion: 1,
				enabled: true,
				namespace: "foreign",
				hostnameRoutes,
			}),
		);
		const rejected = run({
			RUN_HOSTNAME_POLICY: "true",
			PLATFORM_WORKER_HOSTNAME_ROUTES_FILE: file,
		});
		expect(rejected.status).not.toBe(0);
		expect(JSON.parse(rejected.stdout)).toMatchObject({
			error: "HOSTNAME_ROUTE_CONFIGURATION_SCOPE_MISMATCH",
			calls: [],
		});
	} finally {
		await writeFile(path, original);
		await rm(file, { force: true });
	}
});

// #4199 C2 D5/S3: the Worker takes the same exception gate decision as the API
// from the same projected inputs, and carries an enabled route or does not start.
it("assembles the exception route exactly when the shared gate opens it", async () => {
	const { generateKeyPairSync, randomBytes } = await import("node:crypto");
	const { connectionSystemAccessFingerprintV1: fingerprintOf } = await import(
		"@agent-infra/contracts/connection-consumer-profile"
	);
	const {
		decideConnectionManualInstallationDeploymentV1,
		migratePlatformDatabase,
	} = await import("@agent-infra/platform-store");
	const { startPostgresTestDatabase } = await import(
		"../../../packages/platform-store/src/postgres-test.js"
	);
	const { runtimeTlsFixture } = await import(
		"../../../tests/runtime-tls-fixture.js"
	);
	const postgres = (await import("postgres")).default;
	const realDatabase = await startPostgresTestDatabase(
		"worker-entry-manual-route",
	);
	const tls = await runtimeTlsFixture({
		dnsNames: ["worker.worker-binding.svc"],
	});
	const sql = postgres(realDatabase.databaseUrl, {
		max: 1,
		onnotice: () => {},
	});
	const path = join(directory, "configuration.mjs");
	const original = await readFile(path, "utf8");
	try {
		await migratePlatformDatabase({ databaseUrl: realDatabase.databaseUrl });
		const systemAccess = {
			schemaVersion: 1 as const,
			publicOrigin: "https://connection.example.test",
			mcpPath: "/mcp",
			audience: "https://connection.example.test/mcp",
			egressProfile: { ref: "fixture-egress", revision: "r1" },
			issuer: "https://connection.example.test/",
			oauthCallbackUrl: "https://platform.example.test/connection/callback",
		};
		const approval = {
			schemaVersion: 1,
			configFingerprint: fingerprintOf(systemAccess),
			egressEnforced: true,
			source: { ref: "user-authorized-2026-11-18T08:37Z", revision: "1" },
		};
		const exceptionApproval = {
			schemaVersion: 1,
			kind: "consistency-exception-v1",
			policy: { ref: "consistency-exception-v1", revision: "1" },
			notAfter: "2099-01-01T00:00:00Z",
			maximumPinnedPrincipals: 2,
			verificationWindowHours: 24,
			connectionRelease: "agora-connector-734dafc9",
			systemAccessFingerprint: approval.configFingerprint,
			approvalSource: approval.source,
		};
		const serviceToken = `service-${randomBytes(16).toString("hex")}`;
		const keyringKey = generateKeyPairSync("rsa", { modulusLength: 3072 })
			.privateKey.export({ format: "der", type: "pkcs8" })
			.toString("base64");
		const readbackPort = 40_000 + Math.floor(Math.random() * 20_000);
		// The legacy shared profile is not part of system access mode.
		const base = original
			.replace(/export const connectionConsumerProfile = [^\n]*\n/, "")
			.replace(/export const connectionConsumerApproval = [^\n]*\n/, "")
			.replace(
				"export const signing = { workerId: 'worker' };",
				`import { generateKeyPairSync } from 'node:crypto';
export const signing = { workerId: 'worker', issuer: 'worker-issuer', keyId: 'worker-key', privateKey: generateKeyPairSync('ed25519').privateKey };
export const serviceToken = ${JSON.stringify(serviceToken)};`,
			);
		const transport = {
			bootstrap: `export const connectionInstallBootstrap = {
	port: 3445, workerOrigin: "https://worker.worker-binding.svc:${readbackPort}/",
	tlsSecretForSandbox: () => ({ name: "fixture-tls", certKey: "tls.crt", keyKey: "tls.key" }),
	callbackAuthSecretRef: { name: "fixture-callback", key: "callback.auth" },
	workerCaSecretRef: { name: "fixture-worker-ca", key: "ca.crt" },
	apiSelector: { component: "platform-api" },
};`,
			worker: `export const connectionInstallWorker = {
	hostCaFile: ${JSON.stringify(join(tls.directory, "ca.crt"))},
	readbackCertFile: ${JSON.stringify(join(tls.directory, "tls.crt"))},
	readbackKeyFile: ${JSON.stringify(join(tls.directory, "tls.key"))},
	keyring: { keys: [{ keyVersion: "key-1", privateKeyPkcs8DerBase64: ${JSON.stringify(keyringKey)} }] },
};`,
		};
		const environment = (record: unknown) => ({
			RUN_MANUAL_ENABLED: "true",
			PLATFORM_DATABASE_URL: realDatabase.databaseUrl,
			AGENT_INFRA_CONNECTION_SYSTEM_ACCESS: JSON.stringify(systemAccess),
			AGENT_INFRA_CONNECTION_SYSTEM_ACCESS_APPROVAL: JSON.stringify(approval),
			AGENT_INFRA_CONNECTION_CONFIG_VERSION: `1-${approval.configFingerprint}`,
			AGENT_INFRA_CONNECTION_EXCEPTION_APPROVAL:
				record === undefined ? undefined : JSON.stringify(record),
		});
		const sameAsApi = (record: unknown) =>
			decideConnectionManualInstallationDeploymentV1({
				exceptionApproval: record,
				standardInstallationConfigured: false,
				systemAccess: { system: systemAccess, approval },
				callbackDelivery: "ready",
				databaseUrl: realDatabase.databaseUrl,
			});
		const lastLine = (stdout: string) =>
			JSON.parse(stdout.trim().split("\n").at(-1) ?? "null");
		const secrets = [serviceToken, keyringKey, tls.key];

		// Enabled: the drain is wired and the Sandbox bootstrap carries the gate's values.
		await writeFile(
			path,
			`${base}\n${transport.bootstrap}\n${transport.worker}`,
		);
		expect((await sameAsApi(exceptionApproval)).status).toBe("enabled");
		const enabled = run(environment(exceptionApproval));
		expect(enabled.status, enabled.stderr).toBe(0);
		expect(lastLine(enabled.stdout)).toEqual({
			manualDrain: true,
			standard: null,
			bootstrap: {
				port: 3445,
				workerOrigin: `https://worker.worker-binding.svc:${readbackPort}/`,
				clientName: "Agent Infra",
				configuration: systemAccess,
				approval,
			},
		});
		expect(enabled.stdout).toContain("CONNECTION_MANUAL_INSTALLATION_ENABLED");
		for (const secret of secrets) {
			expect(enabled.stdout).not.toContain(secret);
			expect(enabled.stderr).not.toContain(secret);
		}

		// #4199 C2 publication contract: only through the open gate, only for an Agent with a
		// current verified Owner manual association (real PG), and never an invalid contract.
		const contract = JSON.stringify({
			serviceRef: "connection-mcp",
			contract: {
				ref: "connection-mcp-publication",
				revision: "1",
				serverInfo: { name: "connection", version: "1.0.0" },
				tools: [{ name: "list_actions", succeededResultSchema: {} }],
			},
			toolDeclarations: [
				{
					name: "list_actions",
					description: "List Connection actions.",
					inputSchema: { type: "object" },
				},
			],
		});
		const associate = async (agentId: string, ownerId: string, n: number) => {
			await sql`insert into platform.agents(id,authorization_revision) values (${agentId},'agent-r1') on conflict do nothing`;
			await sql`insert into platform.agent_owners(agent_id,owner_id,created_at) values (${agentId},${ownerId},now()) on conflict do nothing`;
			await sql`insert into platform.connection_association_generations(agent_id,last_revision) values (${agentId},1) on conflict do nothing`;
			await sql`insert into platform.connection_manual_associations(agent_id,connection_agent_id,credential_fingerprint,association_revision,owner_id,credential_ciphertext,verified_at) values (${agentId},${`connection-${agentId}`},${String(n).repeat(64)},1,${ownerId},${sql.json({ schemaVersion: 1, agentId, ownerId, secretVersion: 1, crypto: { dekFingerprint: String(n + 1).repeat(64) } })},now())`;
		};
		await associate("agent-alice", "alice", 1);
		await sql`insert into platform.agents(id,authorization_revision) values ('agent-bob','agent-r1')`;
		await sql`insert into platform.agent_owners(agent_id,owner_id,created_at) values ('agent-bob','bob',now())`;
		const published = (
			record: unknown,
			value: string | undefined,
			agent: string,
		) =>
			run({
				...environment(record),
				AGENT_INFRA_CONNECTION_MANUAL_PUBLICATION_CONTRACT: value,
				RUN_PUBLICATION_AGENT: agent,
			});
		const associatedRun = published(exceptionApproval, contract, "agent-alice");
		expect(associatedRun.status, associatedRun.stderr).toBe(0);
		expect(lastLine(associatedRun.stdout).publication).toEqual({
			contract,
			associated: true,
		});
		// Another user's Agent and an Agent nobody associated get nothing.
		for (const agent of ["agent-bob", "agent-unknown"])
			expect(
				lastLine(published(exceptionApproval, contract, agent).stdout)
					.publication,
			).toEqual({ contract, associated: false });
		// Removing the association stops the projection for new renders.
		await sql`delete from platform.connection_manual_associations where agent_id='agent-alice'`;
		expect(
			lastLine(published(exceptionApproval, contract, "agent-alice").stdout)
				.publication,
		).toEqual({ contract, associated: false });
		await associate("agent-alice", "alice", 3);
		// A replaced Owner (replaceAgentAccess leaves the association row) is not current.
		await sql`delete from platform.agent_owners where agent_id='agent-alice'`;
		await sql`insert into platform.agent_owners(agent_id,owner_id,created_at) values ('agent-alice','bob',now())`;
		expect(
			lastLine(published(exceptionApproval, contract, "agent-alice").stdout)
				.publication,
		).toEqual({ contract, associated: false });
		await sql`insert into platform.agent_owners(agent_id,owner_id,created_at) values ('agent-alice','alice',now())`;
		// An invalid contract, or one bound to another descriptor contract, is never handed on.
		for (const invalid of [
			"{",
			JSON.stringify({ ...JSON.parse(contract), toolDeclarations: [] }),
			contract.replace('"revision":"1"', '"revision":"2"'),
		]) {
			const refused = published(exceptionApproval, invalid, "agent-alice");
			expect(refused.status, refused.stderr).toBe(0);
			expect(lastLine(refused.stdout)).not.toHaveProperty("publication");
			expect(refused.stderr).toContain(
				JSON.stringify({
					service: "platform-worker",
					code: "CONNECTION_MANUAL_PUBLICATION_CONTRACT_INVALID",
				}),
			);
			expect(refused.stderr).not.toContain("list_actions");
		}
		// A closed gate projects nothing even with the contract set.
		const closed = published(
			{ ...exceptionApproval, notAfter: "2026-01-01T00:00:00Z" },
			contract,
			"agent-alice",
		);
		expect(closed.status, closed.stderr).toBe(0);
		expect(lastLine(closed.stdout)).toEqual({
			manualDrain: false,
			standard: null,
			bootstrap: null,
		});
		expect(closed.stderr).toContain("CONNECTION_MANUAL_INSTALLATION_DORMANT");
		await sql`delete from platform.connection_manual_associations`;
		await sql`delete from platform.agent_owners where agent_id in ('agent-alice','agent-bob')`;

		// The gate opened it but this Worker cannot carry it: it does not start.
		for (const module of [
			`${base}\n${transport.bootstrap}`,
			`${base}\n${transport.worker}`,
			`${base}\n${transport.bootstrap.replace("port: 3445,", 'port: 3445, clientName: "forged",')}\n${transport.worker}`,
			`${base}\n${transport.bootstrap}\n${transport.worker.replace(join(tls.directory, "tls.key"), "/missing/tls.key")}`,
		]) {
			await writeFile(path, module);
			const refused = run(environment(exceptionApproval));
			expect(refused.status).not.toBe(0);
			expect(lastLine(refused.stdout)).toMatchObject({
				error: "CONNECTION_MANUAL_INSTALLATION_WORKER_UNAVAILABLE",
			});
			for (const secret of [...secrets, "/missing/tls.key"]) {
				expect(refused.stdout).not.toContain(secret);
				expect(refused.stderr).not.toContain(secret);
			}
		}

		// Dormant exactly when the API is: nothing is assembled and the reason is logged.
		await writeFile(
			path,
			`${base}\n${transport.bootstrap}\n${transport.worker}`,
		);
		const dormant = [
			[undefined, "exception_approval_missing"],
			[
				{ ...exceptionApproval, notAfter: "2026-01-01T00:00:00Z" },
				"exception_expired",
			],
			[
				{ ...exceptionApproval, systemAccessFingerprint: "0".repeat(64) },
				"system_access_fingerprint_mismatch",
			],
			[
				{ ...exceptionApproval, maximumPinnedPrincipals: 0 },
				"exception_approval_invalid",
			],
		] as const;
		for (const [record, reason] of dormant) {
			expect(await sameAsApi(record)).toEqual({ status: "dormant", reason });
			const result = run(environment(record));
			expect(result.status, result.stderr).toBe(0);
			expect(lastLine(result.stdout)).toEqual({
				manualDrain: false,
				standard: null,
				bootstrap: null,
			});
			expect(result.stderr.trim()).toBe(
				JSON.stringify({
					service: "platform-worker",
					code: "CONNECTION_MANUAL_INSTALLATION_DORMANT",
					reason,
				}),
			);
		}

		// Cross-user, cross-Agent: another user's confirmed standard installation on
		// another Agent closes the route for every user in both processes.
		await sql`insert into platform.agents(id,authorization_revision) values ('agent-b','agent-r1')`;
		await sql`insert into platform.relay_key_subjects(purpose,subject_id,last_version,current_version) values ('personal','bob',1,1)`;
		await sql`insert into platform.relay_key_versions(purpose,subject_id,key_version,key_id,ciphertext) values ('personal','bob',1,'fixture-key-bob',${sql.json({ purpose: "personal", subjectId: "bob", keyId: "fixture-key-bob", keyVersion: 1 })})`;
		await sql`insert into platform.conversations(id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision,host_session_ref) values ('conversation-b','agent-b','bob','web','active',1,'agent-r1','host-b')`;
		await sql`insert into platform.conversation_executions(execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,authorization_revision,created_at,runtime_submit_protocol,original_operation_digest,original_submit_host_session_ref,execution_source,relay_key_purpose,relay_key_subject_id,relay_key_id,relay_key_version,delivery_fence) values ('execution-b','conversation-b','agent-b','bob','web','turn-b','processing',1,'agent-r1',now(),'v4',${"a".repeat(43)},'host-b','web','personal','bob','fixture-key-bob',1,3)`;
		await sql`insert into platform.connection_installation_authorizations
			(id, execution_id, user_id, confirmation_revision, binding, identity_revision,
			 agent_authorization_revision, status, expires_at)
			values ('standard-bob', 'execution-b', 'bob', 'confirmation-r1',
				${sql.json({ principal: { kind: "user", id: "bob" }, reference: { executionId: "execution-b" } })},
				'identity-r1', 'agent-r1', 'confirmed', clock_timestamp() + interval '1 hour')`;
		expect(await sameAsApi(exceptionApproval)).toEqual({
			status: "dormant",
			reason: "confirmed_principals_unresolvable",
		});
		const unresolved = run(environment(exceptionApproval));
		expect(unresolved.status, unresolved.stderr).toBe(0);
		expect(lastLine(unresolved.stdout)).toMatchObject({
			manualDrain: false,
			bootstrap: null,
		});
	} finally {
		await writeFile(path, original);
		await sql.end();
		await tls.cleanup();
		await realDatabase.stop();
	}
}, 240_000);
