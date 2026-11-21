import { createHash, type KeyObject } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeBusinessGrantClaimsV2Schema } from "@agent-infra/contracts/runtime";
import { seedNativeCommandState } from "./codex-native-command.test-support.js";
import {
	MetadataDriver,
	MetadataTransport,
} from "./compact-transport.test-support.js";
import { FileRuntimeStore } from "./file-runtime-store.js";
import { createRuntimeExecutionGrantVerifierV2 } from "./grant-v2.js";
import {
	createRuntimeExecutionGrantValidatorV4,
	createRuntimeExecutionGrantValidatorV6,
} from "./grant-v4.js";
import { RuntimeHost } from "./runtime-host.js";

// Real Host, signature validation and fixed Codex bridge; only app-server transport is controlled.
export async function createCompactHostFixture(
	authority: { agentId: string; conversationId: string; actorId: string },
	publicKey: KeyObject,
	baseline: "medium" | "high",
	baselineConfigVersion = "configuration-1-native-fixture",
	baselineModel = "gpt-5.3-codex",
) {
	const directory = await mkdtemp(join(tmpdir(), "compact-host-4335-"));
	const seeded = await seedNativeCommandState(directory, undefined, true);
	let bytes = await readFile(seeded.path, "utf8");
	for (const [from, to] of [
		["agent-1", authority.agentId],
		["conversation-1", authority.conversationId],
		["primary", "model-primary"],
		["config-1", baselineConfigVersion],
		["gpt-5.3-codex", baselineModel],
		["high", baseline],
		[
			createHash("sha256").update("primary").digest("hex"),
			createHash("sha256").update("model-primary").digest("hex"),
		],
	] as const)
		bytes = bytes.split(from).join(to);
	if (baselineConfigVersion !== "configuration-1-native-fixture") {
		const state = JSON.parse(bytes) as {
			sessions: Record<
				string,
				{
					executions: Record<
						string,
						{ executionId: string; nativeTurnId: string }
					>;
				}
			>;
			operations: Record<
				string,
				{ configVersion: string; record: { operationId: string } }
			>;
		};
		const entry = Object.entries(state.operations)[0];
		if (!entry) throw new Error("missing approved Turn fixture");
		const key = JSON.parse(entry[0]) as string[];
		key[4] = "earlier-approved-turn";
		const session = state.sessions["session-private"];
		const baselineExecution = session?.executions["execution-1"];
		if (!session || !baselineExecution)
			throw new Error("missing baseline execution");
		session.executions["earlier-approved-turn"] = {
			...baselineExecution,
			executionId: "earlier-approved-turn",
			nativeTurnId: "native-turn-earlier",
		};
		state.operations = {
			[JSON.stringify(key)]: {
				...entry[1],
				configVersion: "configuration-1-native-fixture",
				record: { ...entry[1].record, operationId: "earlier-approved-turn" },
			},
			...state.operations,
		};
		bytes = JSON.stringify(state);
	}
	await writeFile(seeded.path, bytes);
	const transport = new MetadataTransport();
	const driver = await MetadataDriver.openFixture(seeded.path, transport, {
		configVersion: "configuration-1-native-fixture",
		defaultModelOptionId: "model-primary",
		defaultReasoningLevel: baseline,
		modelOptions: [
			{
				modelOptionId: "model-primary",
				model: "gpt-5.3-codex",
				reasoningLevels: ["medium", "high"],
				endpoint: "http://127.0.0.1:1/approved/v1",
				credential: "synthetic-model-credential",
			},
		],
	});
	const store = await FileRuntimeStore.open(join(directory, "host.json"));
	const clock = Date.now();
	const seed = await store.prepareOperation({
		authorization: RuntimeBusinessGrantClaimsV2Schema.parse({
			schemaVersion: 2,
			issuer: "platform-fixture",
			audience: "runtime_host",
			workerId: "worker-1",
			principal: { kind: "user", id: authority.actorId },
			channelId: "web",
			agentId: authority.agentId,
			conversationId: authority.conversationId,
			executionId: "seed-execution",
			turnId: "seed-turn",
			sessionGeneration: 1,
			traceId: "seed-trace",
			hostSessionRef: null,
			issuedAt: clock,
			expiresAt: clock + 30_000,
			grantId: "seed-grant",
			operation: {
				kind: "execution",
				id: "seed-execution",
				deliveryFence: 1,
				executionDeliveryFence: 1,
			},
			requestDigest: "a".repeat(64),
			purpose: "business",
			authorizationRecordId: "seed-authorization",
			allowedCommands: ["turn.submit"],
			attachments: [],
		}),
		binding: {
			principal: { kind: "user", id: authority.actorId },
			channelId: "web",
			agentId: authority.agentId,
			conversationId: authority.conversationId,
			executionId: "seed-execution",
			turnId: "seed-turn",
			sessionGeneration: 1,
		},
		operationId: "seed-execution",
		kind: "submit-turn",
		scope: "execution:seed-execution",
		deliveryFence: 1,
		requestDigest: "seed-request-digest",
		command: (nativeSessionRef) => ({
			schemaVersion: 1,
			kind: "submit-turn",
			operationId: "seed-execution",
			agentId: authority.agentId,
			conversationId: authority.conversationId,
			executionId: "seed-execution",
			turnId: "seed-turn",
			sessionGeneration: 1,
			...(nativeSessionRef ? { nativeSessionRef } : {}),
			input: { text: "seed", attachments: [] },
		}),
	});
	const seedRecord = {
		result: { outcome: "accepted" as const, status: "completed" as const },
		nativeSessionRef: "session-private",
	};
	await store.resolveOperation(
		seed.session.hostSessionRef,
		seed.operation.operationId,
		seedRecord.result,
		seedRecord.nativeSessionRef,
	);

	const binding = {
		principal: { kind: "user" as const, id: authority.actorId },
		scope: {
			agentId: authority.agentId,
			conversationId: authority.conversationId,
			executionId: "metadata-projection",
			sessionGeneration: 1,
		},
	};
	const projection = await driver.readNativeMetadataV2("commands", {
		nativeSessionRef: "session-private",
		allowUnboundExecution: true,
		signal: new AbortController().signal,
		expiresAt: Date.now() + 30000,
		assertCurrent: () => binding,
		revalidate: async () => binding,
	});
	const capability = projection.capabilities.find((c) => c.name === "compact");
	if (!capability) throw new Error("missing compact");
	const host = await RuntimeHost.open({
		store,
		driver,
		grantValidation: { expectedIssuer: "platform-worker" },
		grantValidationV2: {
			expectedIssuer: "platform-worker",
			expectedWorkerId: "v6-worker",
		},
		validateGrantV4: createRuntimeExecutionGrantValidatorV4(
			new Map([["synthetic", publicKey]]),
			{ expectedIssuer: "platform-worker", expectedWorkerId: "v6-worker" },
		),
		validateGrantV6: createRuntimeExecutionGrantValidatorV6(
			new Map([["synthetic", publicKey]]),
			{ expectedIssuer: "platform-worker", expectedWorkerId: "v6-worker" },
		),
	});
	const verify = createRuntimeExecutionGrantVerifierV2(
		new Map([["synthetic", publicKey]]),
	);
	return {
		verify,
		host,
		driver,
		store,
		transport,
		hostSessionRef: seed.session.hostSessionRef,
		capabilityId: capability.id,
		directoryRevision: projection.revision,
		capabilitySourceVersion: capability.source.version,
		async close() {
			await host.close();
			await store.close();
			await rm(directory, { recursive: true, force: true });
		},
	};
}
