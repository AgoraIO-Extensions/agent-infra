import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FakeRuntimeDriver,
	FileRuntimeStore,
	RuntimeHost,
} from "@agent-infra/agent-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
	runtimeGrantFixture,
	verificationForRuntimeGrant,
} from "../../../packages/agent-runtime/src/grant-fixture.test-support.js";
import { createRuntimeHostApp } from "../../agent-runtime-host/src/app.js";
import { createWorkerRuntimeModelDirectoryClientV1 } from "../../platform-worker/src/runtime-model-directory-client.js";
import { createRuntimeModelSelectionReaderV1 } from "./runtime-model-selection-reader.js";

const directories: string[] = [];

const identity = {
	schemaVersion: 1 as const,
	userId: "actor-model-chain",
	displayName: "Model Chain User",
	accountStatus: "active" as const,
	organizationIds: ["org-model-chain"],
	roles: ["employee" as const],
	authorizationRevision: "auth-model-chain",
};

const binding = {
	agentId: "agent-model-chain",
	actorId: identity.userId,
	channelId: "web" as const,
	conversationId: "conversation-model-chain",
	executionId: "execution-model-chain",
	turnId: "turn-model-chain",
	sessionGeneration: 1,
	traceId: "trace-model-chain",
};

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "agent-infra-model-chain-"));
	directories.push(directory);
	const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
	const host = await RuntimeHost.open({
		store: await FileRuntimeStore.open(join(directory, "host.json")),
		driver,
		grantValidation: {
			expectedIssuer: "agent-platform",
			now: () => "2026-08-28T10:00:00Z",
		},
	});
	const app = createRuntimeHostApp({
		host,
		serviceToken: "runtime-service-model-chain",
		verifyGrant: verificationForRuntimeGrant,
	});
	const submitGrant = runtimeGrantFixture(binding, ["turn.submit"]);
	const submitted = await host.submitTurn(
		{
			schemaVersion: 1,
			requestId: "request-model-chain-submit",
			...binding,
			deliveryFence: 1,
			grant: submitGrant,
			input: { text: "synthetic model directory chain", attachments: [] },
		},
		verificationForRuntimeGrant(submitGrant),
	);
	const readRequest = {
		schemaVersion: 1 as const,
		requestId: "request-model-chain-read",
		...binding,
		deliveryFence: 1,
		hostSessionRef: submitted.hostSessionRef,
		grant: runtimeGrantFixture(binding, ["model-directory.read"]),
	};
	const fetcher: typeof fetch = async (input, init) =>
		app.fetch(new Request(String(input), init));
	const transport = createWorkerRuntimeModelDirectoryClientV1({
		baseUrl: "http://runtime-model-chain",
		serviceToken: "runtime-service-model-chain",
		fetch: fetcher,
	});
	const reader = createRuntimeModelSelectionReaderV1({
		resolveRequest: async (request) => {
			if (
				request.identity.userId !== identity.userId ||
				request.conversationId !== binding.conversationId
			)
				return null;
			return readRequest;
		},
		transport,
	});
	return { app, reader, readRequest, transport };
}

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true })),
	);
});

describe("API → Worker → RuntimeHost model-directory chain", () => {
	it("projects a bound RuntimeHost response through the authenticated Worker client", async () => {
		const { reader } = await setup();

		await expect(
			reader.read(identity, binding.conversationId),
		).resolves.toMatchObject({
			agentId: binding.agentId,
			source: "custom-platform-adapter",
			available: true,
			currentModelOptionId: "model-option-primary",
			currentReasoningLevel: "high",
		});
	});

	it("fails closed when the Worker service proof cannot enter RuntimeHost", async () => {
		const { app, reader, readRequest } = await setup();
		const transport = createWorkerRuntimeModelDirectoryClientV1({
			baseUrl: "http://runtime-model-chain",
			serviceToken: "foreign-runtime-service",
			fetch: async (input, init) => app.fetch(new Request(String(input), init)),
		});
		const deniedReader = createRuntimeModelSelectionReaderV1({
			resolveRequest: async () => readRequest,
			transport,
		});

		await expect(
			deniedReader.read(identity, binding.conversationId),
		).resolves.toBeNull();
		await expect(
			reader.read(identity, binding.conversationId),
		).resolves.toBeDefined();
	});

	it("fails closed when the RuntimeHost response crosses the execution binding", async () => {
		const { app, readRequest } = await setup();
		const transport = createWorkerRuntimeModelDirectoryClientV1({
			baseUrl: "http://runtime-model-chain",
			serviceToken: "runtime-service-model-chain",
			fetch: async (input, init) => {
				const response = await app.fetch(new Request(String(input), init));
				const body = (await response.json()) as Record<string, unknown>;
				return new Response(
					JSON.stringify({ ...body, executionId: "foreign-execution" }),
					{
						status: response.status,
						headers: { "content-type": "application/json" },
					},
				);
			},
		});
		const deniedReader = createRuntimeModelSelectionReaderV1({
			resolveRequest: async () => readRequest,
			transport,
		});

		await expect(
			deniedReader.read(identity, binding.conversationId),
		).resolves.toBeNull();
	});
});
