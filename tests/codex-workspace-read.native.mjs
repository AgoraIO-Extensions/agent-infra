// Run inside the pinned Runtime image. The provider, Host current authority and
// V5 text-input port are controlled; Codex and file IO are real. This is not
// Platform/LDAP or real-model acceptance evidence.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { gunzipSync, zstdDecompressSync } from "node:zlib";

const { CodexRuntimeDriver, verifyCodexPilotInstallation } = await import(
	"/app/node_modules/@agent-infra/agent-runtime/dist/index.mjs"
);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const provenance = await verifyCodexPilotInstallation("workspace-summary-v1");
const manifestBytes = await readFile(
	"/opt/codex/agent-infra-skills/workspace-summary.manifest.json",
);
const manifest = JSON.parse(manifestBytes);
const build = JSON.parse(
	await readFile("/opt/codex/share/workspace-summary-build.json", "utf8"),
);
assert.equal(hash(manifestBytes), build.manifestSha256);
const installedSkill = {
	schemaVersion: 1,
	manifestSha256: build.manifestSha256,
	manifest,
	deployment: {
		configVersion: "controlled-workspace-read-v1",
		imageSourceRevision: build.sourceRevision,
	},
};
const directory = await mkdtemp("/tmp/codex-workspace-native-");
const path = join(directory, "driver.json");
const marker = `file-only-${randomUUID()}`;
const inputId = "controlled-input";
const inputPath = ".agent-infra-inputs/controlled-skill/00.txt";
const inputBytes = Buffer.from(`controlled native Skill input ${marker}`);
const inputFacts = {
	bytes: inputBytes,
	sha256: hash(inputBytes),
	byteLength: inputBytes.byteLength,
	mediaType: "text/plain",
};
const callId = "controlled-workspace-read";
let requests = 0;
let completedTool = false;
let providerError;
let authorizations = 0;
let driver;
let finished = false;
let ack;
let workspacePath;

function events(response, items) {
	response.writeHead(200, { "content-type": "text/event-stream" });
	const id = `controlled-response-${requests}`;
	response.write(
		`data: ${JSON.stringify({ type: "response.created", response: { id, status: "in_progress", output: [] } })}\n\n`,
	);
	for (const [index, item] of items.entries()) {
		response.write(
			`data: ${JSON.stringify({ type: "response.output_item.done", output_index: index, item })}\n\n`,
		);
	}
	response.end(
		`data: ${JSON.stringify({ type: "response.completed", response: { id, status: "completed", output: items, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`,
	);
}

const provider = createServer(async (request, response) => {
	try {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		let bytes = Buffer.concat(chunks);
		if (request.headers["content-encoding"] === "gzip")
			bytes = gunzipSync(bytes);
		if (request.headers["content-encoding"] === "zstd")
			bytes = zstdDecompressSync(bytes);
		const body = JSON.parse(bytes);
		requests++;
		assert.equal(request.headers.authorization, "Bearer controlled-credential");
		if (requests === 1) {
			// Phase A only creates the Conversation Thread and its reader snapshot.
			assert.ok(!JSON.stringify(body).includes(marker));
			events(response, [
				{
					type: "message",
					id: "controlled-prepared",
					role: "assistant",
					status: "completed",
					content: [
						{
							type: "output_text",
							text: "controlled workspace prepared",
							annotations: [],
						},
					],
				},
			]);
			return;
		}
		if (requests === 2) {
			// The V5 input is on disk and only its server-derived relative path is
			// visible to the model; its bytes must not be inlined into the request.
			assert.ok(!JSON.stringify(body).includes(marker));
			assert.ok(JSON.stringify(body).includes(inputPath));
			assert.ok(
				JSON.stringify(body.tools ?? []).includes("read_text_file") ||
					JSON.stringify(body.input).includes("read_text_file"),
			);
			const root = join(`${path}.native`, "conversations");
			const conversations = await readdir(root);
			assert.equal(conversations.length, 1);
			workspacePath = join(root, conversations[0], "workspace");
			const info = await stat(join(workspacePath, inputPath));
			assert.equal(info.mode & 0o777, 0o600);
			events(response, [
				{
					type: "function_call",
					id: "controlled-item",
					call_id: callId,
					namespace: "workspace",
					name: "read_text_file",
					arguments: JSON.stringify({ path: inputPath }),
				},
			]);
			return;
		}
		assert.equal(requests, 3, "unexpected provider retry");
		const output = body.input.find(
			(item) => item.type === "function_call_output" && item.call_id === callId,
		);
		assert.ok(output, "missing actual native client-tool output");
		assert.ok(JSON.stringify(output.output).includes(marker));
		completedTool = true;
		events(response, [
			{
				type: "message",
				id: "controlled-answer",
				role: "assistant",
				status: "completed",
				content: [
					{
						type: "output_text",
						text: "controlled summary completed",
						annotations: [],
					},
				],
			},
		]);
	} catch (error) {
		providerError = error;
		response.writeHead(500).end();
	}
});

try {
	await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
	driver = await CodexRuntimeDriver.open({
		path,
		nativeLane: "official-model-only",
		configVersion: installedSkill.deployment.configVersion,
		defaultModelOptionId: "controlled",
		defaultReasoningLevel: "medium",
		modelOptions: [
			{
				modelOptionId: "controlled",
				model: "gpt-5.6-sol",
				reasoningLevels: ["medium"],
				endpoint: `http://127.0.0.1:${provider.address().port}/v1`,
				credential: "controlled-credential",
			},
		],
		installedSkill,
		authorizeExternalAction: async () => {
			authorizations++;
			return { revalidate() {} };
		},
	});
	const setupCommand = {
		schemaVersion: 1,
		kind: "submit-turn",
		operationId: "controlled-setup",
		agentId: "controlled-agent",
		conversationId: "controlled-conversation",
		executionId: "controlled-setup",
		turnId: "controlled-setup-turn",
		sessionGeneration: 1,
		input: {
			text: "Prepare the controlled workspace.",
			attachments: [],
		},
	};
	const setup = await driver.execute(setupCommand);
	assert.equal(setup.result.outcome, "accepted");
	const waitFor = async (nativeSessionRef, executionId) => {
		const deadline = Date.now() + 60_000;
		for (;;) {
			if (providerError) throw providerError;
			const status = await driver.getStatus(nativeSessionRef, executionId);
			if (status === "completed" || status === "failed") return status;
			if (Date.now() >= deadline) return status;
			await delay(50);
		}
	};
	assert.equal(
		await waitFor(setup.nativeSessionRef, setupCommand.executionId),
		"completed",
	);

	const binding = {
		principal: { kind: "user", id: "controlled-reader" },
		scope: {
			agentId: setupCommand.agentId,
			conversationId: setupCommand.conversationId,
			executionId: setupCommand.executionId,
			sessionGeneration: setupCommand.sessionGeneration,
		},
	};
	const abort = new AbortController();
	const projection = await driver.discoverNativeSkills({
		nativeSessionRef: setup.nativeSessionRef,
		signal: abort.signal,
		expiresAt: Date.now() + 60_000,
		assertCurrent: () => binding,
		revalidate: async () => binding,
	});
	const capability = projection.capabilities.find(
		(entry) => entry.kind === "skill" && entry.name === "workspace-summary",
	);
	assert.ok(capability, "missing installed Skill capability");
	const parameters = "summarize the controlled input";
	const skillBase = driver.createNativeSkillCommand({
		schemaVersion: 1,
		kind: "native-capability",
		operationId: "controlled-skill",
		agentId: setupCommand.agentId,
		conversationId: setupCommand.conversationId,
		executionId: "controlled-skill",
		turnId: "controlled-skill-turn",
		sessionGeneration: setupCommand.sessionGeneration,
		nativeSessionRef: setup.nativeSessionRef,
		capabilityId: capability.id,
		directoryRevision: projection.revision,
		packageDigest: manifest.packageDigest.sha256,
		manifestDigest: build.manifestSha256,
		parameters,
		parametersDigest: hash(parameters),
		capabilityName: capability.name,
		capabilitySourceVersion: capability.source.version,
	});
	const skillCommand = {
		...skillBase,
		input: { ...skillBase.input, attachments: [inputId] },
	};
	const fileBridge = {
		readNativeTextInput: async (attachmentId) => {
			assert.equal(attachmentId, inputId);
			return inputFacts;
		},
		readInput: async () => {
			throw new Error("unexpected image input read");
		},
		revalidate: () => {},
		writeResult: async () => {
			throw new Error("unexpected result write");
		},
	};
	const accepted = await driver.execute(skillCommand, { fileBridge });
	assert.equal(accepted.result.outcome, "accepted");
	ack = (async () => {
		while (!finished) {
			const batch = await driver.replayEvents(
				accepted.nativeSessionRef,
				skillCommand.executionId,
			);
			if (batch.at(-1)?.cursor)
				await driver.acknowledgeEvents(
					accepted.nativeSessionRef,
					skillCommand.executionId,
					batch.at(-1).cursor,
				);
			await delay(10);
		}
	})();
	assert.equal(
		await waitFor(accepted.nativeSessionRef, skillCommand.executionId),
		"completed",
	);
	assert.equal(completedTool, true);
	assert.equal(requests, 3);
	const replay = await driver.replayEvents(
		accepted.nativeSessionRef,
		skillCommand.executionId,
	);
	const tools = replay
		.filter((event) => event.type === "operation")
		.map((event) => event.payload)
		.filter((fact) => fact.toolId === "workspace.read_text_file");
	assert.deepEqual(
		tools.map((fact) => fact.phase),
		["intent", "started", "completed"],
	);
	assert.ok(workspacePath, "missing Driver-created workspace");
	const cleanupDeadline = Date.now() + 5_000;
	for (;;) {
		try {
			await stat(join(workspacePath, ".agent-infra-inputs"));
		} catch {
			break;
		}
		if (Date.now() >= cleanupDeadline) break;
		await delay(25);
	}
	await assert.rejects(
		stat(join(workspacePath, ".agent-infra-inputs")),
		(error) => error.code === "ENOENT",
	);
	let durable = await readFile(path, "utf8");
	try {
		for (const entry of await readdir(`${path}.journals`, {
			recursive: true,
			withFileTypes: true,
		})) {
			if (entry.isFile())
				durable += await readFile(join(entry.parentPath, entry.name), "utf8");
		}
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	assert.ok(!durable.includes(marker));
	assert.ok(!durable.includes(inputPath));
	assert.ok(!durable.includes(inputId));
	console.info(
		JSON.stringify({
			status: "passed",
			check: "pinned-native-skill-text-input-workspace-read",
			codexVersion: provenance.codexVersion,
			imageSourceRevision: build.sourceRevision,
			provider: "controlled-loopback",
			hostAuthorization: "controlled",
			textInput: "controlled-v5-port",
			providerRequests: requests,
			authorizations,
			fileOnlyMarkerReturnedByTool: completedTool,
			materializedInputCleaned: true,
			durablePayloadAbsent: true,
		}),
	);
} finally {
	finished = true;
	await ack;
	await driver?.close();
	provider.closeAllConnections();
	await new Promise((resolve) => provider.close(resolve));
	await rm(directory, { recursive: true, force: true });
}
