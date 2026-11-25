import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { productionChartValues as enabled } from "./fixtures/ack-chart-values.ts";
import { renderAckChart as render } from "./support/ack-chart.ts";

const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

function env(rendered, deployment, name) {
	const document = rendered.stdout
		.split(/^---$/mu)
		.find(
			(part) =>
				part.includes("kind: Deployment") &&
				part.includes(`name: ${deployment}\n`),
		);
	assert.ok(document, deployment);
	return document.match(
		new RegExp(`- \\{name: ${name}, value: ("(?:[^"\\\\]|\\\\.)*")\\}`, "u"),
	)?.[1];
}

function workerModule(rendered, key = "configuration.mjs") {
	const document = rendered.stdout
		.split(/^---$/mu)
		.find((part) => part.includes("name: agent-infra-worker-configuration-"));
	const encoded = document?.match(
		new RegExp(`"${key.replaceAll(".", "\\.")}": "([A-Za-z0-9+/=]+)"`, "u"),
	)?.[1];
	assert.ok(encoded, "worker configuration Secret");
	return Buffer.from(encoded, "base64").toString("utf8");
}

test("default values render no exception route", () => {
	const rendered = render();
	assert.equal(rendered.status, 0, rendered.stderr);
	assert.doesNotMatch(
		rendered.stdout,
		/AGENT_INFRA_CONNECTION_EXCEPTION_APPROVAL|connection-install|connectionInstall/u,
	);
});

test("enabled values render one projection to the API and the Worker", () => {
	const rendered = render(enabled());
	assert.equal(rendered.status, 0, rendered.stderr);
	for (const name of [
		"AGENT_INFRA_CONNECTION_EXCEPTION_APPROVAL",
		"AGENT_INFRA_CONNECTION_MANUAL_CLIENT_NAME",
		"AGENT_INFRA_CONNECTION_SYSTEM_ACCESS",
		"AGENT_INFRA_CONNECTION_SYSTEM_ACCESS_APPROVAL",
		"AGENT_INFRA_CONNECTION_CONFIG_VERSION",
	]) {
		const api = env(rendered, "agent-infra-api", name);
		assert.ok(api, name);
		assert.equal(env(rendered, "agent-infra-worker", name), api, name);
	}
	assert.deepEqual(
		JSON.parse(
			JSON.parse(
				env(
					rendered,
					"agent-infra-worker",
					"AGENT_INFRA_CONNECTION_EXCEPTION_APPROVAL",
				),
			),
		),
		enabled().connectionManualInstallation.exceptionApproval,
	);
	assert.match(
		rendered.stdout,
		/- \{name: PLATFORM_API_CONNECTION_CALLBACK_AUTH_FILE, /u,
	);

	const module = workerModule(rendered);
	const bootstrap = JSON.parse(
		module.match(
			/^export const connectionInstallBootstrap=\{\.\.\.(\{.*?\}),tlsSecretForSandbox/mu,
		)[1],
	);
	assert.deepEqual(bootstrap, {
		port: 9443,
		workerOrigin:
			"https://agent-infra-worker-connection-install.agent-infra.svc:9444/",
		apiSelector: {
			"app.kubernetes.io/component": "platform-api",
			"app.kubernetes.io/name": "agent-infra",
		},
		// The same Secret the API mounts as PLATFORM_API_CONNECTION_CALLBACK_AUTH_FILE.
		callbackAuthSecretRef: {
			name: "fixture-callback-auth",
			key: "callback.auth",
		},
		workerCaSecretRef: { name: "fixture-worker-ca", key: "ca.crt" },
	});
	assert.match(
		module,
		/^export const connectionInstallWorker=\{\.\.\.\{"hostCaFile":"\/var\/run\/agent-infra\/connection-install\/host-ca\/ca\.crt",/mu,
	);
	const directory = mkdtempSync(
		join(tmpdir(), "connection-manual-installation-module-"),
	);
	try {
		writeFileSync(join(directory, "configuration.mjs"), module);
		const checked = spawnSync(
			process.execPath,
			["--check", join(directory, "configuration.mjs")],
			{ encoding: "utf8" },
		);
		assert.equal(checked.status, 0, checked.stderr);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}

	for (const volume of [
		"connection-install-host-ca",
		"connection-install-readback-tls",
		"connection-install-keyring",
	])
		assert.match(
			rendered.stdout,
			new RegExp(
				`- name: ${volume}\\n {10}secret:\\n {12}secretName: "[^"]+"\\n {12}defaultMode: 288\\n`,
				"u",
			),
		);
	assert.match(
		rendered.stdout,
		/kind: Service\nmetadata:\n {2}name: agent-infra-worker-connection-install\n(?:.*\n)*? {2}ports: \[\{name: readback, protocol: TCP, port: 9444, targetPort: 9444\}\]/u,
	);
	assert.match(
		rendered.stdout,
		/kind: NetworkPolicy\nmetadata:\n {2}name: agent-infra-worker-connection-install\n(?:.*\n)*? {14}agent-infra\.agora\.io\/managed: session-sandbox-v1\n(?:.*\n)*? {6}ports: \[\{protocol: TCP, port: 9444\}\]/u,
	);
	// #4157 AC-5: no per-Agent Consumer or credential in the rendered deployment.
	assert.doesNotMatch(
		rendered.stdout,
		/consumerId|ByAgent|connectionConsumerProfile|AGENT_INFRA_CONNECTION_PROFILE|clientSecret|PRIVATE KEY/u,
	);
});

const refused = [
	[
		"the chart does not own the configuration modules",
		{ ...enabled(), configuration: { enabled: false } },
		/needs configuration\.enabled/u,
	],
	[
		"system access is off",
		enabled({ platformApi: { connectionSystemAccess: { enabled: false } } }),
		/needs platformApi\.connectionSystemAccess\.enabled/u,
	],
	[
		"the callback Secret reference is missing",
		enabled({ platformApi: { connectionCallbackAuthSecretRef: undefined } }),
		/needs platformApi\.connectionCallbackAuthSecretRef/u,
	],
	[
		"the record names another system access",
		enabled({
			manual: {
				exceptionApproval: {
					...enabled().connectionManualInstallation.exceptionApproval,
					systemAccessFingerprint: "0".repeat(64),
				},
			},
		}),
		/systemAccessFingerprint must equal/u,
	],
	[
		"a Worker transport reference is missing",
		enabled({ manual: { hostTlsSecretRef: {} } }),
		/hostTlsSecretRef/u,
	],
	[
		"the readback port is the receiver port",
		enabled({ manual: { readbackPort: 9443 } }),
		/readbackPort must differ/u,
	],
	[
		"the Worker module reads system access itself",
		enabled({ worker: "export const connectionSystemAccess = {};\n" }),
		/configuration\.worker configuration\.mjs exports connectionSystemAccess/u,
	],
	[
		"the Worker module already declares the transport",
		enabled({ worker: "export const connectionInstallWorker = undefined;\n" }),
		/configuration\.worker configuration\.mjs exports connectionInstallWorker/u,
	],
	[
		"only the API module carries an approval record",
		{
			configuration: {
				enabled: true,
				api: {
					"configuration.mjs": b64(
						`export const connectionConsistencyExceptionApproval = {"connectionRelease":"${enabled().connectionManualInstallation.exceptionApproval.connectionRelease}"};\n`,
					),
				},
				worker: { "configuration.mjs": b64("export const fixture = 1;\n") },
			},
		},
		/configuration\.api configuration\.mjs exports connectionConsistencyExceptionApproval/u,
	],
];

for (const [name, values, message] of refused) {
	test(`the render fails when ${name}`, () => {
		const rendered = render(values);
		assert.notEqual(rendered.status, 0);
		assert.match(rendered.stderr, message);
		assert.doesNotMatch(
			rendered.stderr,
			new RegExp(
				`${enabled().connectionManualInstallation.exceptionApproval.connectionRelease}|${enabled().platformApi.connectionSystemAccess.approval.configFingerprint}`,
				"u",
			),
		);
	});
}

test("Worker configuration composes Connection transport and executor V2 approvals", () => {
	const approvals = [
		{
			schemaVersion: 2,
			imageDigest:
				"ghcr.io/agoraio-extensions/agent-infra/agent-runtime-codex@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			verificationRef: "fixture-reviewed-v2",
		},
	];
	const values = {
		...enabled(),
		worker: {
			executorDrain: { enabled: true, startupTimeoutMs: 120000 },
			executorInstanceStartupApprovals: approvals,
			executorInstanceStartupApprovedImages: approvals.map(
				(entry) => entry.imageDigest,
			),
		},
	};
	const rendered = render(values);
	assert.equal(rendered.status, 0, rendered.stderr);
	const module = workerModule(rendered);
	const base = workerModule(rendered, "executor-base-configuration.mjs");
	assert.match(base, /export const connectionInstallBootstrap=/u);
	assert.match(base, /export const connectionInstallWorker=/u);
	assert.match(module, /export const workloadInput=/u);
	assert.deepEqual(
		JSON.parse(module.match(/executorInstanceStartupApprovals:(\[.*\])/u)[1]),
		approvals,
	);
	assert.doesNotMatch(
		module,
		/export const executorInstanceStartupApprovals=/u,
	);
});

// #4199 C2 reader: the approved dynamic publication contract reaches only the Worker.
const contract = {
	serviceRef: "connection-mcp",
	contract: {
		ref: "connection-mcp-publication",
		revision: "1",
		serverInfo: { name: "connection", version: "1.0.0" },
		tools: [
			{ name: "list_actions", succeededResultSchema: { type: "object" } },
		],
	},
	toolDeclarations: [
		{
			name: "list_actions",
			description:
				enabled().connectionManualInstallation.exceptionApproval
					.connectionRelease,
			inputSchema: { type: "object", maxProperties: 1000000 },
		},
	],
};
const published = (value = contract, manual = {}) =>
	enabled({
		manual: { publication: { enabled: true, contract: value }, ...manual },
	});

test("default values and an enabled route without publication render no contract", () => {
	for (const values of [undefined, enabled()]) {
		const rendered = render(values);
		assert.equal(rendered.status, 0, rendered.stderr);
		assert.doesNotMatch(
			rendered.stdout,
			/AGENT_INFRA_CONNECTION_MANUAL_PUBLICATION_CONTRACT/u,
		);
	}
});

test("an enabled publication renders the contract to the Worker only", () => {
	const rendered = render(published());
	assert.equal(rendered.status, 0, rendered.stderr);
	assert.deepEqual(
		JSON.parse(
			JSON.parse(
				env(
					rendered,
					"agent-infra-worker",
					"AGENT_INFRA_CONNECTION_MANUAL_PUBLICATION_CONTRACT",
				),
			),
		),
		contract,
	);
	assert.equal(
		env(
			rendered,
			"agent-infra-api",
			"AGENT_INFRA_CONNECTION_MANUAL_PUBLICATION_CONTRACT",
		),
		undefined,
	);
	assert.equal(
		rendered.stdout.match(
			/AGENT_INFRA_CONNECTION_MANUAL_PUBLICATION_CONTRACT/gu,
		).length,
		1,
	);
});

const change = (edit) => {
	const value = structuredClone(contract);
	edit(value);
	return value;
};
const refusedPublication = [
	["the exception route is off", published(contract, { enabled: false })],
	["the contract is missing", published({})],
	[
		"the contract names another descriptor revision",
		published(
			change((v) => {
				v.contract.revision = "2";
			}),
		),
	],
	[
		"the contract revision is not a string",
		published(
			change((v) => {
				v.contract.revision = 1;
			}),
		),
	],
	[
		"a tool has no declaration",
		published(
			change((v) => {
				v.toolDeclarations = [];
			}),
		),
	],
	[
		"a declaration names no contract tool",
		published(
			change((v) => {
				v.toolDeclarations[0].name = "other";
			}),
		),
	],
	[
		"a declaration has an extra field",
		published(
			change((v) => {
				v.toolDeclarations[0].extra = true;
			}),
		),
	],
	[
		"a description is longer than 1024",
		published(
			change((v) => {
				v.toolDeclarations[0].description = "x".repeat(1025);
			}),
		),
	],
	[
		"two tools share a name",
		published(
			change((v) => {
				v.contract.tools.push({ name: "list_actions" });
				v.toolDeclarations.push({ ...v.toolDeclarations[0] });
			}),
		),
	],
	[
		"the serviceRef is not an identifier",
		published(
			change((v) => {
				v.serviceRef = "bad ref";
			}),
		),
	],
	[
		"the contract is larger than 64 KiB",
		published(
			change((v) => {
				v.contract.tools[0].succeededResultSchema = {
					padding: "x".repeat(65536),
				};
			}),
		),
	],
];

for (const [name, values] of refusedPublication) {
	test(`the render fails when the publication is on and ${name}`, () => {
		const rendered = render(values);
		assert.notEqual(rendered.status, 0);
		assert.match(rendered.stderr, /connectionManualInstallation\.publication/u);
		assert.doesNotMatch(
			rendered.stderr,
			new RegExp(
				`${enabled().connectionManualInstallation.exceptionApproval.connectionRelease}|list_actions|${enabled().platformApi.connectionSystemAccess.approval.configFingerprint}`,
				"u",
			),
		);
	});
}
