import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { buildSync } from "esbuild";

function bundle(entry) {
	const output = buildSync({
		...(entry.startsWith("\n")
			? { stdin: { contents: entry, resolveDir: process.cwd(), loader: "ts" } }
			: { entryPoints: [entry] }),
		bundle: true,
		platform: "node",
		target: "node24",
		format: "cjs",
		write: false,
		logLevel: "error",
		alias: {
			"@agent-infra/contracts/runtime": resolve(
				"packages/contracts/src/runtime/index.ts",
			),
			"@agent-infra/contracts": resolve("packages/contracts/src/index.ts"),
			"@agent-infra/contracts/files": resolve(
				"packages/contracts/src/files.ts",
			),
			"@agent-infra/platform-core": resolve(
				"packages/platform-core/src/index.ts",
			),
		},
	});
	const module = { exports: {} };
	new Function("require", "module", "exports", output.outputFiles[0].text)(
		createRequire(import.meta.url),
		module,
		module.exports,
	);
	return module.exports;
}
const { createTemplateExecutionRenewal } = bundle(
	"deploy/ack/template-execution-renewal.mts",
);
const hostRuntime = bundle(`
export { RuntimeHost } from './packages/agent-runtime/src/runtime-host.ts';
export { FileRuntimeStore } from './packages/agent-runtime/src/file-runtime-store.ts';
export { FakeRuntimeDriver } from './packages/agent-runtime/src/fake-runtime-driver.ts';
export { createRuntimeExecutionGrantVerifierV2 } from './packages/agent-runtime/src/grant-v2.ts';
export { createRuntimeExecutionGrantValidatorV4 } from './packages/agent-runtime/src/grant-v4.ts';
export { createWorkerRuntimeGrantSignerV4 } from './apps/platform-worker/src/runtime-grant-signer-v4.ts';
`);
const keys = generateKeyPairSync("ed25519");

function baseRequest() {
	return {
		schemaVersion: 4,
		requestId: "request",
		traceId: "trace",
		principal: { kind: "application", id: "app" },
		executionSource: "eval",
		channelId: "isolated-template-validation",
		agentId: "agent",
		conversationId: "conversation",
		executionId: "execution",
		turnId: "turn",
		sessionGeneration: 1,
		hostSessionRef: "host",
		operation: {
			kind: "execution",
			id: "execution",
			deliveryFence: 1,
			executionDeliveryFence: 1,
		},
		keyBinding: {
			purpose: "agent-default",
			subjectId: "agent",
			ciphertextRef: "ciphertext",
			version: 1,
		},
		input: { text: "READY", attachments: [] },
		selection: {
			schemaVersion: 1,
			modelOptionId: "model-option-primary",
			reasoningLevel: "high",
		},
	};
}

test("renews through V3-compatible Grant V2 and binds the accepted execution", async () => {
	let now = 1_800_000_000_000;
	const calls = [];
	const renew = createTemplateExecutionRenewal({
		request: baseRequest(),
		hostSessionRef: "host",
		authorizationRecordId: "authorization",
		initialExpiresAt: now + 30_000,
		signing: {
			issuer: "issuer",
			workerId: "worker",
			keyId: "key",
			privateKey: keys.privateKey,
			now: () => now,
		},
		signal: new AbortController().signal,
		waitForHostGrant: async () => {},
		post: async (path, body) => {
			calls.push({ path, body });
			return {
				schemaVersion: 3,
				executionId: "execution",
				expiresAt: now + 30_000,
			};
		},
	});
	now += 15_000;
	await renew();
	assert.equal(calls.length, 1);
	assert.equal(calls[0].path, "/internal/runtime/v3/authorizations/renew");
	assert.equal(calls[0].body.schemaVersion, 3);
	assert.equal(calls[0].body.hostSessionRef, "host");
	assert.equal(calls[0].body.executionId, "execution");
	assert.equal(calls[0].body.operation.executionDeliveryFence, 1);
});

test("renewal abort fails closed and does not report success", async () => {
	const controller = new AbortController();
	let posts = 0;
	const renew = createTemplateExecutionRenewal({
		request: baseRequest(),
		hostSessionRef: "host",
		authorizationRecordId: "authorization",
		initialExpiresAt: 1_800_000_030_000,
		signing: {
			issuer: "issuer",
			workerId: "worker",
			keyId: "key",
			privateKey: keys.privateKey,
			now: () => 1_800_000_015_000,
		},
		signal: controller.signal,
		waitForHostGrant: async () => controller.abort(),
		post: async () => {
			posts++;
			return {
				schemaVersion: 3,
				executionId: "execution",
				expiresAt: 1_800_000_045_000,
			};
		},
	});
	await assert.rejects(renew);
	assert.equal(posts, 0);
});

test("renewal timeout cancels the attempt before posting", async () => {
	let posts = 0;
	const renew = createTemplateExecutionRenewal({
		request: baseRequest(),
		hostSessionRef: "host",
		authorizationRecordId: "authorization",
		initialExpiresAt: 1_800_000_030_000,
		signing: {
			issuer: "issuer",
			workerId: "worker",
			keyId: "key",
			privateKey: keys.privateKey,
			now: () => 1_800_000_015_000,
		},
		signal: new AbortController().signal,
		timeoutMs: 10,
		waitForHostGrant: async () => new Promise(() => {}),
		post: async () => {
			posts++;
			return {};
		},
	});
	await assert.rejects(renew, /TEMPLATE_EXECUTION_RENEWAL_TIMEOUT/);
	assert.equal(posts, 0);
});

test("renewal rejects wrong execution and expired response", async () => {
	let now = 1_800_000_000_000;
	for (const response of [
		{
			schemaVersion: 3,
			executionId: "other-execution",
			expiresAt: now + 30_000,
		},
		{ schemaVersion: 3, executionId: "execution", expiresAt: now },
	]) {
		const renew = createTemplateExecutionRenewal({
			request: baseRequest(),
			hostSessionRef: "host",
			authorizationRecordId: "authorization",
			initialExpiresAt: now + 30_000,
			signing: {
				issuer: "issuer",
				workerId: "worker",
				keyId: "key",
				privateKey: keys.privateKey,
				now: () => now,
			},
			signal: new AbortController().signal,
			waitForHostGrant: async () => {},
			post: async () => response,
		});
		now += 15_000;
		await assert.rejects(renew);
	}
});

test("real Host rejects the expired execution lease then accepts after V3 renewal", async (t) => {
	const directory = await (await import("node:fs/promises")).mkdtemp(
		"/tmp/ack-real-renew-",
	);
	const store = await hostRuntime.FileRuntimeStore.open(
		`${directory}/host.json`,
	);
	const driver = await hostRuntime.FakeRuntimeDriver.open(
		`${directory}/driver.json`,
	);
	const keys = generateKeyPairSync("ed25519");
	let clock = 1_800_000_000_000;
	const signing = {
		issuer: "fixture-issuer",
		workerId: "fixture-worker",
		keyId: "fixture",
		privateKey: keys.privateKey,
		now: () => clock,
	};
	const signerV4 = hostRuntime.createWorkerRuntimeGrantSignerV4(signing);
	const publicKeys = new Map([["fixture", keys.publicKey]]);
	const validation = {
		expectedIssuer: signing.issuer,
		expectedWorkerId: signing.workerId,
		now: () => clock,
	};
	const host = await hostRuntime.RuntimeHost.open({
		store,
		driver,
		grantValidation: { expectedIssuer: signing.issuer },
		grantValidationV2: validation,
		validateGrantV4: hostRuntime.createRuntimeExecutionGrantValidatorV4(
			publicKeys,
			validation,
		),
		allowLegacyBusiness: false,
	});
	t.after(async () => {
		await host.close();
		await store.close();
		await (await import("node:fs/promises")).rm(directory, {
			recursive: true,
			force: true,
		});
	});
	const request = {
		...baseRequest(),
		requestId: "real-submit",
		traceId: "real-trace",
		executionId: "real-execution",
		turnId: "real-turn",
		agentId: "real-agent",
		conversationId: "real-conversation",
		principal: { kind: "application", id: "real-app" },
		keyBinding: { ...baseRequest().keyBinding, subjectId: "real-agent" },
		operation: { ...baseRequest().operation, id: "real-execution" },
		hostSessionRef: null,
		grant: {
			schemaVersion: 4,
			format: "runtime-execution-jws",
			token: "unsigned.unsigned.unsigned",
		},
	};
	const grant = signerV4.sign(request, "real-authorization");
	const claims = signerV4.verify(grant);
	const {
		schemaVersion: _schemaVersion,
		input: _input,
		selection: _selection,
		grant: _requestGrant,
		...requestContext
	} = request;
	const transport = {
		businessRequest: { ...request, grant },
		privateKeyField: {
			schemaVersion: 1,
			context: {
				...requestContext,
				grantId: claims.grantId,
				requestDigest: claims.requestDigest,
			},
			keyDelivery: { relayKey: "real-pinned-relay-key" },
		},
	};
	const accepted = await host.submitTurnV4(transport);
	const readBody = () => ({
		schemaVersion: 4,
		requestId: `read-${clock}`,
		traceId: request.traceId,
		principal: request.principal,
		executionSource: request.executionSource,
		channelId: request.channelId,
		agentId: request.agentId,
		conversationId: request.conversationId,
		executionId: request.executionId,
		turnId: request.turnId,
		sessionGeneration: 1,
		hostSessionRef: accepted.hostSessionRef,
		operation: request.operation,
		keyBinding: request.keyBinding,
		consumer: "platform_worker_persistence",
		afterCursor: null,
		grant: {
			schemaVersion: 2,
			format: "runtime-execution-jws",
			token: "unsigned.unsigned.unsigned",
		},
	});
	const eventGrant = async () => {
		const body = readBody();
		return {
			body,
			grant: await signerV4.signEvent(body, {
				purpose: "business",
				authorizationRecordId: "real-authorization",
			}),
		};
	};
	driver.replayEvents = async () =>
		clock < 1_800_000_052_000
			? []
			: [
					{
						schemaVersion: 2,
						executionId: request.executionId,
						adapterEventKey: "real-event",
						cursor: "real-cursor",
						occurredAt: new Date(clock).toISOString(),
						type: "operation",
						payload: {
							kind: "model",
							operationRef: "real-model",
							attemptRef: "real-attempt",
							phase: "completed",
							startedAt: new Date(1_800_000_000_000).toISOString(),
							finishedAt: new Date(clock).toISOString(),
							durationMs: clock - 1_800_000_000_000,
							model: {
								configVersion: "fixture",
								modelOptionId: "model-option-primary",
								modelId: "fixture-model",
								reasoningLevel: "high",
							},
						},
					},
				];
	clock += 31_000;
	const empty = await eventGrant();
	assert.deepEqual(
		(
			await host
				.readEventsV4(
					{ ...empty.body, grant: empty.grant },
					hostRuntime.createRuntimeExecutionGrantVerifierV2(publicKeys)(
						empty.grant,
					),
				)
				.catch((error) => {
					throw error;
				})
		).events,
		[],
	);
	clock = 1_800_000_052_000;
	const expired = await eventGrant();
	await assert.rejects(
		host.readEventsV4(
			{ ...expired.body, grant: expired.grant },
			hostRuntime.createRuntimeExecutionGrantVerifierV2(publicKeys)(
				expired.grant,
			),
		),
		(error) => error.diagnostic === "event-authority-expired",
	);
	const server = createServer(async (incoming, response) => {
		const chunks = [];
		for await (const chunk of incoming) chunks.push(chunk);
		const body = JSON.parse(Buffer.concat(chunks).toString());
		assert.equal(incoming.url, "/internal/runtime/v3/authorizations/renew");
		const renewed = await host.renewAuthorizationV3(
			body,
			hostRuntime.createRuntimeExecutionGrantVerifierV2(publicKeys)(body.grant),
		);
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify(renewed));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(
		async () =>
			new Promise((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
	);
	const renew = createTemplateExecutionRenewal({
		request,
		hostSessionRef: accepted.hostSessionRef,
		authorizationRecordId: "real-authorization",
		initialExpiresAt: claims.expiresAt,
		signing,
		signal: new AbortController().signal,
		waitForHostGrant: async () => {},
		post: async (path, body) =>
			(
				await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				})
			).json(),
	});
	await renew();
	const recovered = await eventGrant();
	assert.equal(
		(
			await host.readEventsV4(
				{ ...recovered.body, grant: recovered.grant },
				hostRuntime.createRuntimeExecutionGrantVerifierV2(publicKeys)(
					recovered.grant,
				),
			)
		).events.length,
		1,
	);
});
