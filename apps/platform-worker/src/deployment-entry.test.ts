import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transform } from "esbuild";
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
export const createProductionWorkloadWorkerOptionsV1 = async (input) => { globalThis.calls.push('workload'); return input; };
`,
	);
	await writeFile(
		join(directory, "workload-runtime.js"),
		`export const workloadResourceConfigurationHashV1 = () => 'synthetic-hash';`,
	);
	await writeFile(
		join(directory, "conversation-deployment.js"),
		`
export const createProductionConversationRuntimeResolverV2 = (input) => { globalThis.calls.push('conversation'); globalThis.connection = { profile: input.connectionConsumerProfile, approval: input.connectionConsumerApproval }; };
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
 const signal = new AbortController().signal;
 const workload = await entry.createPlatformWorkloadWorkerOptionsV1(signal);
 const conversation = await entry.createPlatformConversationWorkerOptionsV2(signal);
 console.log(JSON.stringify({ databases: [workload.databaseUrl, conversation.databaseUrl, globalThis.wecomDatabase], calls: globalThis.calls, connection: globalThis.connection }));
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
		calls: ["readiness", "workload", "wecom", "sandbox", "conversation"],
		connection: {
			profile: connectionConsumerProfile,
			approval: connectionConsumerApproval,
		},
	});
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
