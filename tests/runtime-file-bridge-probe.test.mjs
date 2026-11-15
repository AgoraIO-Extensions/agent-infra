import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
	fileBridgeDriversForRole,
	runtimeImageRole,
	validateFileBridgeProbe,
} from "../deploy/release/runtime-probe.mjs";
import { sessionSandboxFileExchangeTokenV1 } from "../packages/platform-core/dist/index.mjs";
import { syntheticFileBridgeResult } from "./support/runtime-file-bridge-evidence.mjs";
import {
	fileBridgeProbeEnvironment,
	fileBridgeProbeIsolation,
	fileBridgeProbeModelConfiguration,
	fileBridgeProbeOrigin,
	fileExchangeStartupRejections,
	sessionSandboxProbeTokens,
} from "./support/runtime-file-bridge-probe.mjs";

const digest = (value) =>
	`sha256:${createHash("sha256").update(value).digest("hex")}`;
const manifest = (overrides = {}) =>
	JSON.stringify({
		schemaVersion: 1,
		interactionMode: "platform-adapter",
		protocol: "acp",
		service: { port: 3003 },
		health: { path: "/healthz" },
		capabilities: {
			modelSelection: true,
			attachments: true,
			resultFiles: true,
			connection: false,
			supplementaryInstruction: false,
		},
		...overrides,
	});

test("FileBridge role comes from the image labels, never a repository name", () => {
	const runtime = { "io.agora.agent.runtime.manifest": manifest() };
	assert.equal(runtimeImageRole(runtime), "runtimeHost");
	for (const template of ["codex", "claude", "opencode", "pi"])
		assert.equal(
			runtimeImageRole({
				...runtime,
				"io.agora.agent.standard-template": template,
			}),
			template,
		);
	assert.deepEqual(fileBridgeDriversForRole("runtimeHost"), [
		"codex",
		"claude",
		"acp",
		"pi",
	]);
	assert.deepEqual(fileBridgeDriversForRole("opencode"), ["acp"]);
	assert.deepEqual(fileBridgeDriversForRole("codex"), ["codex"]);
	for (const [labels, message] of [
		[{}, /manifest label is invalid/],
		[
			{ "io.agora.agent.runtime.manifest": "not-json" },
			/manifest label is invalid/,
		],
		[
			{
				"io.agora.agent.runtime.manifest": manifest({
					interactionMode: "self-managed",
				}),
			},
			/not a platform FileBridge consumer/,
		],
		[
			{
				"io.agora.agent.runtime.manifest": manifest({
					capabilities: { attachments: false, resultFiles: true },
				}),
			},
			/does not declare file capabilities/,
		],
		[
			{ ...runtime, "io.agora.agent.standard-template": "agent-runtime-codex" },
			/template role is invalid/,
		],
	])
		assert.throws(() => runtimeImageRole(labels), message);
	assert.throws(() => fileBridgeDriversForRole("custom"), /role is invalid/);
});

test("the probe assembles the Worker's Session and Agent FileBridge inputs", () => {
	const namespace = "agent-infra-d-ws-1103";
	const deploymentServiceToken = "d".repeat(48);
	const grantPublicKey = generateKeyPairSync("ed25519")
		.publicKey.export({ type: "spki", format: "pem" })
		.toString();
	const modelConfiguration = fileBridgeProbeModelConfiguration(
		"claude",
		"http://127.0.0.1:1",
	);
	const origin = "http://agent-infra-api.agent-infra-d-ws-1103.svc:3000";
	assert.equal(fileBridgeProbeOrigin(namespace), origin);
	assert.throws(() => fileBridgeProbeOrigin("Bad_Namespace"), /invalid/);
	const session = fileBridgeProbeEnvironment({
		assembly: "session-sandbox",
		driver: "claude",
		base: {
			PATH: "/usr/bin",
			AGENT_INFRA_RUNTIME_INSTALLED_SKILL: "workspace-summary-v1",
			AGENT_INFRA_RUNTIME_DATA_DIR: "/var/lib/agent-runtime",
			AGENT_INFRA_RUNTIME_FILE_EXCHANGE_ORIGIN: "http://foreign:1",
		},
		namespace,
		deploymentServiceToken,
		grantPublicKey,
		modelConfiguration,
		dataDirectory: "/workspace/runtime",
	});
	// The derived value is the one Platform API recomputes for this allocation.
	assert.equal(
		session.fileExchangeToken,
		sessionSandboxFileExchangeTokenV1(deploymentServiceToken, {
			namespace,
			sandboxId: "synthetic-sandbox-1",
			generation: 1,
			resourceFence: 1,
		}),
	);
	assert.match(session.fileExchangeToken, /^[A-Za-z0-9_-]{43}$/);
	assert.notEqual(session.fileExchangeToken, session.transportToken);
	assert.equal(
		session.environment.AGENT_INFRA_RUNTIME_FILE_EXCHANGE_ORIGIN,
		origin,
	);
	assert.equal(
		session.environment.AGENT_INFRA_RUNTIME_FILE_EXCHANGE_SERVICE_TOKEN,
		session.fileExchangeToken,
	);
	assert.equal(
		session.environment.AGENT_INFRA_RUNTIME_SERVICE_TOKEN,
		session.transportToken,
	);
	assert.ok(
		!Object.values(session.environment).includes(deploymentServiceToken),
	);
	assert.equal(
		session.environment.AGENT_INFRA_RUNTIME_INSTALLED_SKILL,
		"workspace-summary-v1",
	);
	assert.equal(
		session.environment.AGENT_INFRA_RUNTIME_DATA_DIR,
		"/workspace/runtime",
	);
	assert.equal(
		session.environment.AGENT_INFRA_RUNTIME_WORKER_ID,
		"synthetic-worker",
	);
	const workload = fileBridgeProbeEnvironment({
		assembly: "agent-workload",
		driver: "codex",
		namespace,
		deploymentServiceToken,
		grantPublicKey,
		modelConfiguration: fileBridgeProbeModelConfiguration(
			"codex",
			"http://127.0.0.1:1",
		),
		dataDirectory: "/var/lib/agent-runtime/runtime",
		imageDigest: digest("image"),
	});
	// workload-runtime-auth.ts: both variables reference the runtime-auth Secret.
	assert.equal(
		workload.environment.AGENT_INFRA_RUNTIME_FILE_EXCHANGE_SERVICE_TOKEN,
		deploymentServiceToken,
	);
	assert.equal(
		workload.environment.AGENT_INFRA_RUNTIME_SERVICE_TOKEN,
		deploymentServiceToken,
	);
	assert.deepEqual(
		JSON.parse(workload.environment.AGENT_INFRA_RUNTIME_READINESS_BINDING),
		{
			workerId: "synthetic-worker",
			agentId: "synthetic-file-agent",
			workloadRevision: 1,
			fence: 1,
			imageDigest: digest("image"),
		},
	);
	assert.equal(workload.environment.AGENT_INFRA_RUNTIME_WORKER_ID, undefined);
	assert.equal(
		workload.environment.AGENT_INFRA_RUNTIME_ISOLATION_MODE,
		"container-boundary",
	);
	assert.deepEqual(fileBridgeProbeIsolation("codex"), {
		sessionSandbox: "session-executor",
		agentWorkload: "container-boundary",
	});
	assert.deepEqual(fileBridgeProbeIsolation("pi"), {
		sessionSandbox: "driver-default",
		agentWorkload: "driver-default",
	});
	assert.throws(
		() =>
			fileBridgeProbeEnvironment({
				assembly: "agent-workload",
				driver: "pi",
				namespace,
				deploymentServiceToken,
				grantPublicKey,
				modelConfiguration,
				dataDirectory: "/var/lib/agent-runtime/runtime",
				imageDigest: "mutable:tag",
			}),
		/digest is invalid/,
	);
	const tokens = sessionSandboxProbeTokens({
		deploymentServiceToken,
		namespace,
		sandbox: "other-sandbox",
	});
	assert.notEqual(tokens.fileExchange, session.fileExchangeToken);
});

test("startup negatives keep the formal origin and token rules", () => {
	const cases = new Map(fileExchangeStartupRejections("probe", "t".repeat(43)));
	assert.equal(cases.size, 14);
	assert.deepEqual(cases.get("origin-with-path"), {
		AGENT_INFRA_RUNTIME_FILE_EXCHANGE_ORIGIN:
			"http://agent-infra-api.probe.svc:3000/files",
		AGENT_INFRA_RUNTIME_FILE_EXCHANGE_SERVICE_TOKEN: "t".repeat(43),
	});
	assert.equal(
		cases.get("cleartext-ipv4-origin").AGENT_INFRA_RUNTIME_FILE_EXCHANGE_ORIGIN,
		"http://127.0.0.1:3000",
	);
	assert.deepEqual(Object.keys(cases.get("origin-without-token")), [
		"AGENT_INFRA_RUNTIME_FILE_EXCHANGE_ORIGIN",
	]);
	assert.deepEqual(Object.keys(cases.get("token-without-origin")), [
		"AGENT_INFRA_RUNTIME_FILE_EXCHANGE_SERVICE_TOKEN",
	]);
});

async function fileBridgeResult(
	driver,
	architecture = "amd64",
	overrides = {},
) {
	return {
		...syntheticFileBridgeResult(driver, { architecture }),
		stopExitCodes: { sessionSandbox: 0, agentWorkload: 143 },
		...overrides,
	};
}

test("FileBridge evidence requires every check of the role's real Driver", async () => {
	for (const driver of ["codex", "claude", "acp", "pi"]) {
		const value = await fileBridgeResult(driver);
		assert.deepEqual(
			validateFileBridgeProbe(value, driver, "agent-infra-probe", "amd64"),
			value,
		);
	}
	const valid = await fileBridgeResult("codex");
	for (const value of [
		{ ...valid, driver: "claude" },
		{ ...valid, origin: "http://127.0.0.1:3000" },
		{ ...valid, status: "failed" },
		{ ...valid, capability: "official-model-only" },
		{ ...valid, checks: valid.checks.slice(1) },
		{
			...valid,
			checks: valid.checks.filter(
				(check) => check !== "session-executor-rejects-file-bridge-input",
			),
		},
		{ ...valid, isolation: fileBridgeProbeIsolation("pi") },
		{ ...valid, exchange: { ...valid.exchange, violations: 1 } },
		{ ...valid, exchange: { ...valid.exchange, results: 3 } },
		{ ...valid, exchange: { ...valid.exchange, reads: 6 } },
		{ ...valid, externalModelRequests: 1 },
		{ ...valid, localModelRequests: 1 },
		{ ...valid, stopExitCodes: { sessionSandbox: 1, agentWorkload: 0 } },
		{
			...valid,
			installation: { ...valid.installation, architecture: "arm64" },
		},
		{
			...valid,
			installation: { ...valid.installation, codexReleaseSha256: "mutable" },
		},
		{ ...valid, rawOutput: "synthetic-private-value" },
	])
		assert.throws(
			() =>
				validateFileBridgeProbe(value, "codex", "agent-infra-probe", "amd64"),
			/FileBridge origin probe evidence is invalid/,
		);
	const claude = await fileBridgeResult("claude");
	assert.throws(
		() => validateFileBridgeProbe(claude, "claude", "other-namespace", "amd64"),
		/evidence is invalid/,
	);
});
