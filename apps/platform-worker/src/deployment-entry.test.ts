import { spawnSync } from "node:child_process";
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
import { connectionConsumerProfileFingerprintV1 } from "@agent-infra/contracts/connection-consumer-profile";
import { build, transform } from "esbuild";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

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
				"export class PostgresAgentConfigurationQueryV1 {}",
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
	const source = await readFile(
		new URL("./deployment-entry.ts", import.meta.url),
		"utf8",
	);
	const { code } = await transform(source, {
		loader: "ts",
		format: "esm",
		target: "node24",
	});
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
export const createProductionWorkloadWorkerOptionsV1 = async (input) => { globalThis.calls.push('workload'); globalThis.fileExchange = { origin: input.policy.runtimeAuth?.fileExchangeOrigin ?? null, egress: input.policy.fileExchangeEgress ?? null }; globalThis.snapshot = input.policy.connectionConsumerSnapshot; globalThis.installation = input.policy.connectionInstallationRevision; globalThis.snapshots = input.policy.connectionConsumerSnapshotsByAgent; globalThis.installations = input.policy.connectionInstallationRevisionsByAgent; return input; };
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
export const createProductionSessionSandboxReceiverV1 = () => { globalThis.calls.push('sandbox'); return async () => ({ status: 'observed', resources: [] }); };
`,
	);
	await writeFile(
		join(directory, "wecom-deployment.js"),
		`
export const createWecomDeploymentCoordinatorV1 = (input) => { globalThis.calls.push('wecom'); globalThis.wecomDatabase = input.databaseUrl; return {}; };
`,
	);
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
 if (process.env.RUN_NATIVE_PORTS === 'true') {
   const options = await entry.createPlatformNativeMetadataGatewayOptionsV1(signal);
   console.log(JSON.stringify(options?.ports ?? null));
   process.exit(0);
 }
 const workload = await entry.createPlatformWorkloadWorkerOptionsV1(signal);
 if (process.env.RUN_FILE_EXCHANGE === 'true') {
   console.log(JSON.stringify(globalThis.fileExchange));
   process.exit(0);
 }
	const conversation = await entry.createPlatformConversationWorkerOptionsV2(signal);
	if (process.env.RUN_SKILL_CHECK === "true") {
	 console.log(JSON.stringify({ skillMaterializer: typeof workload.skillMaterializer?.materialize }));
	 process.exit(0);
	}
 if (process.env.RUN_CLOSE_INSTALLATION === "true") await conversation.closeDeployment?.();
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
 console.log(JSON.stringify({ databases: [workload.databaseUrl, conversation.databaseUrl, globalThis.wecomDatabase], calls: globalThis.calls, connection: globalThis.connection, snapshot: globalThis.snapshot ? JSON.parse(globalThis.snapshot) : null, installation: globalThis.installation, snapshots: globalThis.snapshots, installations: globalThis.installations, installationConfigured: typeof conversation.connectionInstallation?.authorize === 'function' }));
} catch (error) {
 console.log(JSON.stringify({ error: error.message, calls: globalThis.calls }));
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

it("projects distinct approved consumers and installations by Agent", async () => {
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

it("rejects a per-Agent consumer map without a matching installation map", async () => {
	const configurationPath = join(directory, "configuration.mjs");
	const original = await readFile(configurationPath, "utf8");
	try {
		await writeFile(
			configurationPath,
			`${original}\nexport const connectionConsumerProfilesByAgent = ${JSON.stringify(
				{
					"agent-a": {
						profile: connectionConsumerProfile,
						approval: connectionConsumerApproval,
					},
				},
			)};\n`,
		);
		const result = run();
		expect(result.status).toBe(1);
		expect(JSON.parse(result.stdout)).toEqual({
			error: "CONNECTION_INSTALLATION_SUPPLY_UNAVAILABLE",
			calls: [],
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
});

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
    recordAppliedReceipt: async (receipt) => receipt,
  },
  agentVersion: "agent-version-1",
  actor: { actorId: "deployment-actor", organizationIds: [], isAdministrator: false },
  resolvePackageObject: async () => undefined,
  verifyAdmission: async () => {},
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

it.each([
	"export const connectionInstallation = { configuration: {}, authorize: true };",
	"export const connectionInstallation = { configuration: {}, authorize: () => {}, extra: true };",
])("rejects malformed installation producer configuration", async (entry) => {
	const path = join(directory, "configuration.mjs");
	const original = await readFile(path, "utf8");
	await writeFile(path, `${original}\n${entry}\n`);
	try {
		const result = run();
		expect(result.status).toBe(1);
		expect(JSON.parse(result.stdout)).toEqual({
			error: "CONNECTION_INSTALLATION_UNAVAILABLE",
			calls: [],
		});
	} finally {
		await writeFile(path, original);
	}
});

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

it("assembles the command Store and independent OAuth configurations in per-Agent mode", async () => {
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
	try {
		await writeFile(
			path,
			`${original}
export const connectionConsumerProfilesByAgent=${JSON.stringify({ "agent-a": { profile: connectionConsumerProfile, approval: connectionConsumerApproval }, "agent-b": { profile: profileB, approval: approvalB } })};
export const connectionInstallationSuppliesByAgent=${JSON.stringify({ "agent-a": { ref: "installation-a", revision: "r1" }, "agent-b": { ref: "installation-b", revision: "r1" } })};
export const connectionInstallation=${JSON.stringify({ configurationsByAgent })};
`,
		);
		const result = run({
			RUN_CLOSE_INSTALLATION: "true",
			RUN_INSTALLATION_MAP: "true",
		});
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			hasCommandStore: true,
			configurations: configurationsByAgent,
			workloadReady: true,
			shared: null,
		});
	} finally {
		await writeFile(path, original);
	}
});

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
