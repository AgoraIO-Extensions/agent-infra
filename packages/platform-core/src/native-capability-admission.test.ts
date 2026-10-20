import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeNativeCapabilityMetadataRevalidationV1 } from "./fake-native-capability-admission.ts";
import type { FileLimitsV1, FileRecordV1 } from "./file-authority.ts";
import {
	createNativeCapabilityAdmissionUseCaseV1,
	type NativeCapabilityAdmissionRequestV2,
	type NativeCapabilityAdmissionStateV1,
	type NativeCapabilityAdmissionTransactionPortV1,
	type NativeCapabilityInputLimitsPortV1,
	type NativeCapabilityMetadataRevalidationPortV1,
	nativeCapabilityAdmissionRequestDigest,
	nativeCapabilityAdmissionRequestDigestV2,
	parseNativeCapabilityAdmissionRequest,
	parseNativeCapabilityAdmissionRequestV1,
	parseNativeCapabilityAdmissionRequestV2,
} from "./native-capability-admission.ts";

const authority = {
	schemaVersion: 1 as const,
	actorId: "actor-1",
	agentId: "agent-1",
	channelId: "web",
	authorizationRevision: "auth-1",
	supportsSupplementaryInstruction: false,
};

const conversation = {
	schemaVersion: 1 as const,
	conversationId: "conversation-1",
	agentId: "agent-1",
	actorId: "actor-1",
	channelId: "web",
	status: "ready" as const,
	sessionGeneration: 3,
	hostSessionRef: "host-session-1",
	authorizationRevision: "auth-1",
	lastConversationCursor: 0,
	selectedModelOptionId: null,
	selectedReasoningLevel: null,
	createdAt: new Date("2026-10-13T00:00:00.000Z"),
	updatedAt: new Date("2026-10-13T00:00:00.000Z"),
};

const capabilityId = "a".repeat(64);
const directoryRevision = "b".repeat(64);
const request = {
	schemaVersion: 1 as const,
	conversationId: "conversation-1",
	capabilityId,
	directoryRevision,
	parameters: "summary of the workspace",
	idempotencyKey: "invoke-1",
	requestId: "request-1",
	traceId: "trace-1",
};

const projection = {
	selector: "skills" as const,
	revision: directoryRevision,
	capabilities: [
		{
			id: capabilityId,
			kind: "skill" as const,
			name: "workspace-summary",
			description: "Summarize the current workspace",
			source: { name: "skillhub", version: "1.0.0" },
			availability: "discovered" as const,
		},
	],
};

const commandRequest = {
	...request,
	capabilityId: "c".repeat(64),
	directoryRevision: "d".repeat(64),
	parameters: "",
};

const commandProjection = {
	selector: "commands" as const,
	revision: commandRequest.directoryRevision,
	capabilities: [
		{
			id: commandRequest.capabilityId,
			kind: "command" as const,
			name: "查看原生会话状态",
			description: "读取当前原生会话状态",
			source: { name: "Codex", version: "0.153.0" },
			availability: "available" as const,
		},
	],
};

function transaction(
	state: NativeCapabilityAdmissionStateV1,
): NativeCapabilityAdmissionTransactionPortV1 {
	return {
		async admitNativeCapability(_request, decide, _isCurrent, _isAuthorized) {
			const decision = await decide(state);
			if ("outcome" in decision) return decision;
			return {
				outcome: "accepted",
				result: decision.result,
				plan: decision,
			};
		},
	};
}

function useCase(
	metadata: NativeCapabilityMetadataRevalidationPortV1 = new FakeNativeCapabilityMetadataRevalidationV1(
		{ projection },
	),
	state: NativeCapabilityAdmissionStateV1 = {
		conversation,
		activeExecution: null,
		authorizationRevision: "auth-1",
		inputFiles: null,
	},
	inputLimits?: NativeCapabilityInputLimitsPortV1,
) {
	return createNativeCapabilityAdmissionUseCaseV1({
		authorization: {
			async authorize() {
				return { outcome: "allowed", authority };
			},
		},
		metadata,
		transaction: transaction(state),
		...(inputLimits ? { inputLimits } : {}),
		now: () => new Date("2026-10-13T00:00:00.000Z"),
		newId: (() => {
			let next = 0;
			return () => `generated-${++next}`;
		})(),
	});
}

describe("native capability admission contract", () => {
	it.each([
		{ command: commandRequest, metadata: commandProjection },
		{ command: request, metadata: projection },
		{
			command: { ...request, parameters: '请汇总工作区\n"文件"\\路径 🧪' },
			metadata: projection,
		},
	])(
		"hashes the admitted raw UTF-8 parameters for Runtime V4 (#2950)",
		async ({ command, metadata }) => {
			const decision = await useCase(
				new FakeNativeCapabilityMetadataRevalidationV1({
					projection: metadata,
				}),
			).admit(command);
			if (decision.outcome !== "accepted")
				throw new Error("Expected acceptance");
			const expected = createHash("sha256")
				.update(command.parameters, "utf8")
				.digest("hex");
			expect(decision.plan.parameters).toBe(command.parameters);
			expect(decision.plan.parametersDigest).toBe(expected);
			expect(decision.plan.outbox.payload.parameters).toBe(command.parameters);
			expect(decision.plan.outbox.payload.parametersDigest).toBe(expected);
		},
	);

	it("keeps the fake metadata scope bound for synchronous current checks", async () => {
		const fake = new FakeNativeCapabilityMetadataRevalidationV1({ projection });
		const allowed = await fake.revalidate({
			request,
			authority,
			sessionGeneration: conversation.sessionGeneration,
		});
		if (allowed.outcome !== "allowed") throw new Error("Expected metadata");
		const capability = allowed.capability;
		expect(
			fake.isCurrent({
				request,
				capability,
				scope: allowed.scope,
			}),
		).toBe(true);
		expect(
			fake.isCurrent({
				request,
				capability,
				scope: { ...allowed.scope, hostScopeRef: "foreign-host" },
			}),
		).toBe(false);
	});

	it("strictly snapshots bounded requests and rejects extra fields", () => {
		expect(parseNativeCapabilityAdmissionRequestV1(request)).toEqual(request);
		expect(() =>
			parseNativeCapabilityAdmissionRequestV1({ ...request, extra: true }),
		).toThrow();
		expect(() =>
			parseNativeCapabilityAdmissionRequestV1({
				...request,
				parameters: "x\0",
			}),
		).toThrow();
	});

	it("revalidates the directory before producing a frozen plan", async () => {
		const decision = await useCase().admit(request);
		expect(decision.outcome).toBe("accepted");
		if (decision.outcome !== "accepted") return;
		expect(decision.plan.capability).toMatchObject({
			id: capabilityId,
			kind: "skill",
			directoryRevision,
		});
		expect(Object.isFrozen(decision.plan)).toBe(true);
		expect(Object.isFrozen(decision.plan.capability)).toBe(true);
	});

	it("admits a command plan with an empty bounded parameter payload", async () => {
		const decision = await useCase(
			new FakeNativeCapabilityMetadataRevalidationV1({
				projection: commandProjection,
			}),
		).admit(commandRequest);
		expect(decision.outcome).toBe("accepted");
		if (decision.outcome !== "accepted") return;
		expect(decision.plan.capability).toMatchObject({
			id: commandRequest.capabilityId,
			kind: "command",
			directoryRevision: commandRequest.directoryRevision,
			source: { version: "0.153.0" },
		});
	});

	it("fails closed for a stale directory revision", async () => {
		const metadata = new FakeNativeCapabilityMetadataRevalidationV1({
			projection: { ...projection, revision: "c".repeat(64) },
		});
		const decision = await useCase(metadata).admit(request);
		expect(decision.outcome).toBe("stale");
	});

	it("fails closed for an unknown capability", async () => {
		const unknownId = "d".repeat(64);
		const metadata = new FakeNativeCapabilityMetadataRevalidationV1({
			projection: {
				...projection,
				capabilities: projection.capabilities.map((capability) => ({
					...capability,
					id: unknownId,
				})),
			},
		});
		const decision = await useCase(metadata).admit(request);
		expect(decision.outcome).toBe("unknown");
	});

	it("returns busy before reading metadata for an active or unknown execution", async () => {
		const metadata = new FakeNativeCapabilityMetadataRevalidationV1({
			projection,
		});
		const state = {
			conversation,
			activeExecution: {
				executionId: "execution-1",
				status: "unknown" as const,
			},
			authorizationRevision: "auth-1",
			inputFiles: null,
		};
		const decision = await useCase(metadata, state).admit(request);
		expect(decision).toEqual({ outcome: "busy" });
	});

	it("rejects a metadata response whose scope changed during revalidation", async () => {
		const metadata = {
			async revalidate() {
				const selected = projection.capabilities[0];
				if (!selected) throw new Error("Expected test capability");
				return {
					outcome: "allowed" as const,
					capability: {
						...selected,
						directoryRevision,
					},
					scope: {
						agentId: authority.agentId,
						actorId: "other-actor",
						channelId: authority.channelId,
						conversationId: request.conversationId,
						sessionGeneration: conversation.sessionGeneration,
						authorizationRevision: authority.authorizationRevision,
						hostScopeRef: "host-session-1",
					},
				};
			},
			isCurrent: () => true,
		};
		const decision = await useCase(metadata).admit(request);
		expect(decision).toEqual({
			outcome: "unavailable",
			reason: "metadata_unavailable",
		});
	});

	it("rechecks authorization after metadata revalidation", async () => {
		let calls = 0;
		const decision = await createNativeCapabilityAdmissionUseCaseV1({
			authorization: {
				async authorize() {
					calls += 1;
					return {
						outcome: "allowed" as const,
						authority:
							calls === 1
								? authority
								: { ...authority, authorizationRevision: "auth-2" },
					};
				},
			},
			metadata: new FakeNativeCapabilityMetadataRevalidationV1({ projection }),
			transaction: transaction({
				conversation,
				activeExecution: null,
				authorizationRevision: "auth-1",
				inputFiles: null,
			}),
			newId: () => "generated",
		}).admit(request);
		expect(decision).toEqual({
			outcome: "denied",
			reason: "authorization_lost",
		});
	});

	it("rejects a directory invalidation after the final authorization check", async () => {
		let metadataCalls = 0;
		const fake = new FakeNativeCapabilityMetadataRevalidationV1({ projection });
		const metadata: NativeCapabilityMetadataRevalidationPortV1 = {
			async revalidate(input) {
				metadataCalls += 1;
				if (metadataCalls === 1) return fake.revalidate(input);
				return { outcome: "stale" };
			},
			isCurrent: () => false,
		};
		const decision = await useCase(metadata).admit(request);
		expect(decision).toEqual({ outcome: "stale" });
	});

	it("rejects authorization lost after the final metadata read", async () => {
		let calls = 0;
		const decision = await createNativeCapabilityAdmissionUseCaseV1({
			authorization: {
				async authorize() {
					calls += 1;
					return calls < 3
						? { outcome: "allowed" as const, authority }
						: { outcome: "denied" as const };
				},
			},
			metadata: new FakeNativeCapabilityMetadataRevalidationV1({ projection }),
			transaction: transaction({
				conversation,
				activeExecution: null,
				authorizationRevision: "auth-1",
				inputFiles: null,
			}),
			newId: () => "generated",
		}).admit(request);
		expect(decision).toEqual({
			outcome: "denied",
			reason: "authorization_lost",
		});
	});

	it("maps malformed metadata responses to unavailable", async () => {
		const decision = await useCase({
			async revalidate() {
				return {
					outcome: "allowed" as const,
					capability: { directoryRevision } as never,
					scope: {
						agentId: authority.agentId,
						actorId: authority.actorId,
						channelId: authority.channelId,
						conversationId: request.conversationId,
						sessionGeneration: conversation.sessionGeneration,
						authorizationRevision: authority.authorizationRevision,
						hostScopeRef: "host-session-1",
					},
				};
			},
			isCurrent: () => true,
		}).admit(request);
		expect(decision).toEqual({
			outcome: "unavailable",
			reason: "metadata_unavailable",
		});
	});
});

const textLimits: FileLimitsV1 = {
	revision: "limits-1",
	expiresAt: "2099-01-01T00:00:00Z",
	mediaTypes: ["text/plain"],
	maxBytes: 4096,
};

function textFile(
	fileId: string,
	overrides: Partial<FileRecordV1> = {},
): FileRecordV1 {
	return {
		actorId: authority.actorId,
		agentId: authority.agentId,
		channelId: authority.channelId,
		conversationId: "conversation-1",
		fileId,
		objectRef: `object-${fileId}`,
		kind: "attachment",
		idempotencyKey: `upload-${fileId}`,
		descriptor: {
			name: `${fileId}.txt`,
			mediaType: "text/plain",
			sizeBytes: 5,
			sha256: "e".repeat(64),
		},
		status: "available",
		executionId: null,
		messageId: null,
		sessionGeneration: null,
		objectVersion: "version-1",
		etag: "etag-1",
		createdAt: "2026-10-13T00:00:00.000Z",
		expiresAt: "2099-01-01T00:00:00.000Z",
		updatedAt: "2026-10-13T00:00:00.000Z",
		revision: 1,
		...overrides,
	};
}

const fileA = "file-a";
const fileB = "file-b";

const v2Request: NativeCapabilityAdmissionRequestV2 = {
	...request,
	schemaVersion: 2,
	attachments: [fileA, fileB],
};

function v2UseCase(
	input: {
		readonly files?: readonly FileRecordV1[];
		readonly limits?: FileLimitsV1 | null;
		readonly metadata?: NativeCapabilityMetadataRevalidationPortV1;
		readonly inputFiles?: NativeCapabilityAdmissionStateV1["inputFiles"];
	} = {},
) {
	const files = new Map(
		(input.files ?? [textFile(fileA), textFile(fileB)]).map((file) => [
			file.fileId,
			file,
		]),
	);
	return useCase(
		input.metadata ??
			new FakeNativeCapabilityMetadataRevalidationV1({ projection }),
		{
			conversation,
			activeExecution: null,
			authorizationRevision: "auth-1",
			inputFiles:
				input.inputFiles === undefined
					? { getFile: async (fileId) => files.get(fileId) ?? null }
					: input.inputFiles,
		},
		{
			async read() {
				return input.limits === undefined ? textLimits : input.limits;
			},
		},
	);
}

describe("native capability Invocation V2 text inputs", () => {
	it("persists the ordered resolved inputs into the plan, native payload and idempotency digest", async () => {
		const decision = await v2UseCase().admit(v2Request);
		if (decision.outcome !== "accepted")
			throw new Error("Expected Invocation V2 acceptance");
		const facts = [
			{
				fileId: fileA,
				sha256: "e".repeat(64),
				byteLength: 5,
				mediaType: "text/plain" as const,
			},
			{
				fileId: fileB,
				sha256: "e".repeat(64),
				byteLength: 5,
				mediaType: "text/plain" as const,
			},
		];
		expect(decision.plan.attachments).toEqual(facts);
		expect(decision.plan.outbox.payload.attachments).toEqual(facts);
		expect(decision.plan.idempotency.requestDigest).toBe(
			nativeCapabilityAdmissionRequestDigestV2(v2Request),
		);
		expect(decision.plan.idempotency.requestDigest).toBe(
			nativeCapabilityAdmissionRequestDigest(v2Request),
		);
		expect(decision.plan.idempotency.requestDigest).not.toBe(
			nativeCapabilityAdmissionRequestDigest({
				...v2Request,
				attachments: [fileB, fileA],
			}),
		);
	});

	it.each([1, 2, 3, 4])("accepts %i ordered text files", async (count) => {
		const files = Array.from({ length: count }, (_, index) =>
			textFile(`file-${index}`),
		);
		const decision = await v2UseCase({ files }).admit({
			...v2Request,
			attachments: files.map((file) => file.fileId),
		});
		expect(decision.outcome).toBe("accepted");
		if (decision.outcome !== "accepted") return;
		expect(
			decision.plan.attachments?.map((attachment) => attachment.fileId),
		).toEqual(files.map((file) => file.fileId));
	});

	it("keeps Invocation V1 plans free of attachments", async () => {
		const decision = await useCase().admit(request);
		if (decision.outcome !== "accepted")
			throw new Error("Expected Invocation V1 acceptance");
		expect(decision.plan.attachments).toBeUndefined();
		expect(decision.plan.outbox.payload.attachments).toBeUndefined();
	});

	it("rejects attachments for a command capability", async () => {
		const decision = await v2UseCase({
			metadata: new FakeNativeCapabilityMetadataRevalidationV1({
				projection: commandProjection,
			}),
		}).admit({
			...v2Request,
			capabilityId: commandRequest.capabilityId,
			directoryRevision: commandRequest.directoryRevision,
			parameters: "",
		});
		expect(decision).toEqual({ outcome: "unsupported" });
	});

	it.each([
		{ attachments: [] },
		{ attachments: ["a", "b", "c", "d", "e"] },
		{ attachments: [fileA, fileA] },
		{ schemaVersion: 1, attachments: [fileA] },
	])("rejects an invalid ordered input request %j", (change) => {
		expect(() =>
			parseNativeCapabilityAdmissionRequest({ ...v2Request, ...change }),
		).toThrow();
	});

	it("requires the explicit V2 version for attachments", () => {
		expect(parseNativeCapabilityAdmissionRequestV2(v2Request)).toEqual(
			v2Request,
		);
		expect(() => parseNativeCapabilityAdmissionRequestV1(v2Request)).toThrow();
	});

	it.each([
		{
			label: "oversize file",
			files: [
				textFile(fileA, {
					descriptor: { ...textFile(fileA).descriptor, sizeBytes: 4097 },
				}),
			],
		},
		{
			label: "non-text media",
			files: [
				textFile(fileA, {
					descriptor: { ...textFile(fileA).descriptor, mediaType: "image/png" },
				}),
			],
		},
		{ label: "missing file", files: [textFile(fileA)] },
		{
			label: "foreign actor",
			files: [textFile(fileA, { actorId: "other-actor" })],
		},
		{
			label: "foreign agent",
			files: [textFile(fileA, { agentId: "other-agent" })],
		},
		{
			label: "foreign channel",
			files: [textFile(fileA, { channelId: "other-channel" })],
		},
		{
			label: "foreign conversation",
			files: [textFile(fileA, { conversationId: "other-conversation" })],
		},
		{
			label: "message-bound file",
			files: [textFile(fileA, { messageId: "message-1" })],
		},
		{
			label: "execution-bound file",
			files: [
				textFile(fileA, { executionId: "execution-1", sessionGeneration: 3 }),
			],
		},
		{
			label: "unavailable file",
			files: [textFile(fileA, { status: "pending" })],
		},
	])("denies $label", async ({ files }) => {
		const decision = await v2UseCase({ files }).admit(v2Request);
		expect(decision).toEqual({ outcome: "denied" });
	});

	it.each([
		{
			label: "media type not allowed",
			limits: { ...textLimits, mediaTypes: ["image/png"] },
		},
		{
			label: "byte limit below the file",
			limits: { ...textLimits, maxBytes: 4 },
		},
		{
			label: "expired limits",
			limits: { ...textLimits, expiresAt: "2000-01-01T00:00:00Z" },
		},
		{ label: "missing limits", limits: null },
	])("denies when FileLimits fail closed: $label", async ({ limits }) => {
		const decision = await v2UseCase({ limits }).admit(v2Request);
		expect(decision).toEqual({ outcome: "denied" });
	});

	it("fails closed without a transaction file reader", async () => {
		expect(await v2UseCase({ inputFiles: null }).admit(v2Request)).toEqual({
			outcome: "unavailable",
			reason: "metadata_unavailable",
		});
	});

	it("fails closed without a FileLimits port", async () => {
		const use = createNativeCapabilityAdmissionUseCaseV1({
			authorization: {
				async authorize() {
					return { outcome: "allowed", authority };
				},
			},
			metadata: new FakeNativeCapabilityMetadataRevalidationV1({
				projection,
			}),
			transaction: transaction({
				conversation,
				activeExecution: null,
				authorizationRevision: "auth-1",
				inputFiles: { getFile: async () => textFile(fileA) },
			}),
			now: () => new Date("2026-10-13T00:00:00.000Z"),
		});
		expect(await use.admit(v2Request)).toEqual({
			outcome: "unavailable",
			reason: "metadata_unavailable",
		});
	});
});
