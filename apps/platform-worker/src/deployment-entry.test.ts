import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, transform } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vitest";

let directory: string;
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
	await writeFile(join(directory, "package.json"), '{"type":"module"}');
	await writeFile(join(directory, "deployment.mjs"), code);
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
export const createProductionWorkloadWorkerOptionsV1 = async (input) => { globalThis.calls.push('workload'); globalThis.snapshot = input.policy.connectionConsumerSnapshot; globalThis.installation = input.policy.connectionInstallationRevision; return input; };
`,
	);
	await writeFile(
		join(directory, "workload-runtime.js"),
		`export const workloadResourceConfigurationHashV1 = () => 'synthetic-hash';`,
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
 const workload = await entry.createPlatformWorkloadWorkerOptionsV1(signal);
	const conversation = await entry.createPlatformConversationWorkerOptionsV2(signal);
	if (process.env.RUN_INVALID_PROFILE === 'true') {
	 const control = await conversation.resolveRuntimeHost({ purpose: 'control' });
	 let business;
	 try { await conversation.resolveRuntimeHost({ purpose: 'business' }); } catch (error) { business = error.message; }
	 console.log(JSON.stringify({ control, business, snapshot: globalThis.snapshot, installation: globalThis.installation }));
	 process.exit(0);
	}
 console.log(JSON.stringify({ databases: [workload.databaseUrl, conversation.databaseUrl, globalThis.wecomDatabase], calls: globalThis.calls, connection: globalThis.connection, snapshot: JSON.parse(globalThis.snapshot), installation: globalThis.installation, installationConfigured: typeof conversation.connectionInstallation?.authorize === 'function' }));
} catch (error) {
 console.log(JSON.stringify({ error: error.message, calls: globalThis.calls }));
 process.exitCode = 1;
}
`,
	);
});
afterAll(async () => {
	if (directory) await rm(directory, { recursive: true, force: true });
});

const database = "postgresql://database.example.test/platform";
function run(overrides: Record<string, string | undefined> = {}) {
	return spawnSync(process.execPath, [join(directory, "run.mjs")], {
		encoding: "utf8",
		timeout: 5000,
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
