import {
	createNativeCapabilityAdmissionUseCaseV1,
	type FileLimitsV1,
	type FileRecordV1,
	type NativeCapabilityAdmissionRequestV2,
	type NativeCapabilityMetadataRevalidationPortV1,
	nativeCapabilityAdmissionRequestDigestV1,
	nativeCapabilityAdmissionRequestDigestV2,
} from "@agent-infra/platform-core";
import { FakeNativeCapabilityMetadataRevalidationV1 } from "@agent-infra/platform-core/testing";
import { describe, expect, it } from "vitest";
import {
	type FakeNativeCapabilityAdmissionStoreOptionsV1,
	FakeNativeCapabilityAdmissionStoreV1,
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
		conversationId: conversation.conversationId,
		fileId,
		objectRef: `object-${fileId}`,
		kind: "attachment",
		idempotencyKey: `intent-${fileId}`,
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
		expiresAt: "2099-01-01T00:00:00Z",
		updatedAt: "2026-10-13T00:00:00.000Z",
		revision: 1,
		...overrides,
	};
}

function createHarness(
	options: Partial<FakeNativeCapabilityAdmissionStoreOptionsV1> = {},
	metadata: NativeCapabilityMetadataRevalidationPortV1 = new FakeNativeCapabilityMetadataRevalidationV1(
		{ projection, hostScopeRef: conversation.hostSessionRef },
	),
	limits: FileLimitsV1 | null = textLimits,
) {
	const store = new FakeNativeCapabilityAdmissionStoreV1({
		conversation,
		...options,
	});
	const useCase = createNativeCapabilityAdmissionUseCaseV1({
		authorization: {
			async authorize() {
				return { outcome: "allowed", authority };
			},
		},
		metadata,
		transaction: store,
		inputLimits: {
			async read() {
				return limits;
			},
		},
		now: () => new Date("2026-10-13T00:00:00.000Z"),
		newId: (() => {
			let next = 0;
			return () => `generated-${++next}`;
		})(),
	});
	return { metadata, store, useCase };
}

describe("native capability admission Store seam", () => {
	it("replays the same key and rejects changed parameters without another plan", async () => {
		const harness = createHarness();
		const first = await harness.useCase.admit(request);
		const replay = await harness.useCase.admit({
			...request,
			requestId: "request-2",
		});
		const conflict = await harness.useCase.admit({
			...request,
			parameters: "different parameters",
			requestId: "request-3",
		});
		expect(first.outcome).toBe("accepted");
		expect(replay.outcome).toBe("replayed");
		if (first.outcome !== "accepted") throw new Error("Expected acceptance");
		expect(first.plan.outbox.payload.parameters).toBe(request.parameters);
		expect(first.plan.outbox.payload.parametersDigest).toBe(
			first.plan.parametersDigest,
		);
		expect(conflict).toEqual({
			outcome: "conflict",
			reason: "idempotency_conflict",
		});
		expect(harness.store.plans).toHaveLength(1);
	});

	it.each(["omitted", "changed", "digest-mismatched"] as const)(
		"rejects a native plan with %s persisted parameters",
		async (failure) => {
			const source = createHarness();
			const accepted = await source.useCase.admit(request);
			if (accepted.outcome !== "accepted")
				throw new Error("Expected acceptance");
			const malformed = structuredClone(accepted.plan) as unknown as {
				outbox: { payload: Record<string, unknown> };
			};
			if (failure === "omitted") delete malformed.outbox.payload.parameters;
			if (failure === "changed")
				malformed.outbox.payload.parameters = "changed";
			if (failure === "digest-mismatched")
				malformed.outbox.payload.parametersDigest = "0".repeat(64);
			const store = new FakeNativeCapabilityAdmissionStoreV1({ conversation });
			await expect(
				store.admitNativeCapability(
					{
						command: request,
						authority,
						requestDigest: nativeCapabilityAdmissionRequestDigestV1(request),
					},
					async () => malformed as never,
					() => true,
					async () => true,
				),
			).rejects.toThrow("Native capability admission plan is invalid");
		},
	);

	it("rechecks authorization before returning a queued replay", async () => {
		let authorizationCalls = 0;
		const store = new FakeNativeCapabilityAdmissionStoreV1({ conversation });
		const metadata = new FakeNativeCapabilityMetadataRevalidationV1({
			projection,
		});
		const useCase = createNativeCapabilityAdmissionUseCaseV1({
			authorization: {
				async authorize() {
					authorizationCalls += 1;
					return authorizationCalls < 5
						? { outcome: "allowed" as const, authority }
						: { outcome: "denied" as const };
				},
			},
			metadata,
			transaction: store,
			newId: (() => {
				let next = 0;
				return () => `generated-${++next}`;
			})(),
		});
		expect((await useCase.admit(request)).outcome).toBe("accepted");
		expect(
			await useCase.admit({ ...request, requestId: "request-replay" }),
		).toEqual({
			outcome: "denied",
			reason: "authorization_lost",
		});
	});

	it("rechecks Store revision after replay authorization awaits", async () => {
		const harness = createHarness();
		const accepted = await harness.useCase.admit(request);
		if (accepted.outcome !== "accepted") throw new Error("Expected acceptance");
		let release = () => {};
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const replay = harness.store.admitNativeCapability(
			{
				command: request,
				authority,
				requestDigest: nativeCapabilityAdmissionRequestDigestV1(request),
			},
			async () => accepted.plan,
			() => true,
			async () => {
				await pending;
				return true;
			},
		);
		harness.store.setAuthorizationRevision("auth-revoked");
		release();
		expect(await replay).toEqual({
			outcome: "denied",
			reason: "authorization_lost",
		});
	});

	it("fails closed for stale or disabled metadata", async () => {
		const staleMetadata = new FakeNativeCapabilityMetadataRevalidationV1({
			projection,
		});
		const stale = createHarness({}, staleMetadata);
		staleMetadata.setProjection({ ...projection, revision: "c".repeat(64) });
		expect((await stale.useCase.admit(request)).outcome).toBe("stale");

		const disabledMetadata = new FakeNativeCapabilityMetadataRevalidationV1({
			projection,
		});
		const disabled = createHarness({}, disabledMetadata);
		disabledMetadata.setProjection({
			...projection,
			capabilities: projection.capabilities.map((capability) => ({
				...capability,
				availability: "available" as const,
			})),
		});
		expect((await disabled.useCase.admit(request)).outcome).toBe("disabled");
	});

	it("returns busy for active and unknown executions before creating a plan", async () => {
		for (const status of ["submitted", "unknown"] as const) {
			const harness = createHarness({
				activeExecution: { executionId: "execution-existing", status },
			});
			expect(await harness.useCase.admit(request)).toEqual({ outcome: "busy" });
			expect(harness.store.plans).toHaveLength(0);
		}
	});

	it("serializes same-key and different-key concurrent admissions", async () => {
		const sameKey = createHarness();
		const sameResults = await Promise.all([
			sameKey.useCase.admit(request),
			sameKey.useCase.admit({ ...request, requestId: "request-2" }),
		]);
		expect(sameResults.map((result) => result.outcome).sort()).toEqual([
			"accepted",
			"replayed",
		]);

		const differentKey = createHarness();
		const differentResults = await Promise.all([
			differentKey.useCase.admit(request),
			differentKey.useCase.admit({
				...request,
				idempotencyKey: "invoke-2",
				requestId: "request-2",
			}),
		]);
		expect(differentResults.map((result) => result.outcome).sort()).toEqual([
			"accepted",
			"busy",
		]);
		expect(differentKey.store.plans).toHaveLength(1);
	});

	it("rejects a revision revocation while metadata admission is pending", async () => {
		let release = () => {};
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const delayedMetadata = {
			async revalidate(
				input: Parameters<
					NativeCapabilityMetadataRevalidationPortV1["revalidate"]
				>[0],
			) {
				await pending;
				return new FakeNativeCapabilityMetadataRevalidationV1({
					projection,
				}).revalidate(input);
			},
			isCurrent: () => true,
		};
		const harness = createHarness({}, delayedMetadata);
		const admission = harness.useCase.admit(request);
		await Promise.resolve();
		harness.store.setAuthorizationRevision("auth-revoked");
		release();
		expect(await admission).toEqual({
			outcome: "denied",
			reason: "authorization_lost",
		});
		expect(harness.store.plans).toHaveLength(0);
	});

	it("rejects occupancy added while metadata admission is pending", async () => {
		let release = () => {};
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const delayedMetadata = {
			async revalidate(
				input: Parameters<
					NativeCapabilityMetadataRevalidationPortV1["revalidate"]
				>[0],
			) {
				await pending;
				return new FakeNativeCapabilityMetadataRevalidationV1({
					projection,
				}).revalidate(input);
			},
			isCurrent: () => true,
		};
		const harness = createHarness({}, delayedMetadata);
		const admission = harness.useCase.admit(request);
		await Promise.resolve();
		harness.store.setActiveExecution({
			executionId: "late-execution",
			status: "unknown",
		});
		release();
		expect(await admission).toEqual({ outcome: "busy" });
		expect(harness.store.plans).toHaveLength(0);
	});

	it("rechecks metadata currency at the Store commit boundary", async () => {
		let checks = 0;
		const fake = new FakeNativeCapabilityMetadataRevalidationV1({ projection });
		const metadata = {
			async revalidate(
				input: Parameters<
					NativeCapabilityMetadataRevalidationPortV1["revalidate"]
				>[0],
			) {
				return fake.revalidate(input);
			},
			isCurrent: () => {
				checks += 1;
				return checks === 1;
			},
		};
		const harness = createHarness({}, metadata);
		expect(await harness.useCase.admit(request)).toEqual({
			outcome: "stale",
		});
		expect(checks).toBe(2);
		expect(harness.store.plans).toHaveLength(0);
	});

	it("rejects authorization loss before replay or metadata reads", async () => {
		const harness = createHarness();
		harness.store.setAuthorizationRevision("auth-revoked");
		expect(await harness.useCase.admit(request)).toEqual({
			outcome: "denied",
			reason: "authorization_lost",
		});
		expect(harness.store.plans).toHaveLength(0);
	});

	it("rejects an empty Skill parameter while admitting command empty parameters", async () => {
		const skill = createHarness();
		expect(
			(await skill.useCase.admit({ ...request, parameters: "" })).outcome,
		).toBe("invalid_parameters");

		const commandProjection = {
			selector: "commands" as const,
			revision: directoryRevision,
			capabilities: [
				{
					id: capabilityId,
					kind: "command" as const,
					name: "status",
					description: "Read status",
					source: { name: "codex", version: "1.0.0" },
					availability: "available" as const,
				},
			],
		};
		const commandMetadata = new FakeNativeCapabilityMetadataRevalidationV1({
			projection,
		});
		const command = createHarness({}, commandMetadata);
		commandMetadata.setProjection(commandProjection);
		expect(
			(await command.useCase.admit({ ...request, parameters: "" })).outcome,
		).toBe("accepted");
	});
});

describe("native capability Invocation V2 Store seam", () => {
	const v2Request: NativeCapabilityAdmissionRequestV2 = {
		...request,
		schemaVersion: 2,
		attachments: ["file-a", "file-b"],
	};

	it("binds the accepted ordered inputs once and replays them without rebinding", async () => {
		const harness = createHarness({
			files: [textFile("file-a"), textFile("file-b")],
		});
		const accepted = await harness.useCase.admit(v2Request);
		if (accepted.outcome !== "accepted")
			throw new Error("Expected Invocation V2 acceptance");
		expect(
			accepted.plan.attachments?.map((attachment) => attachment.fileId),
		).toEqual(["file-a", "file-b"]);
		expect(accepted.plan.idempotency.requestDigest).toBe(
			nativeCapabilityAdmissionRequestDigestV2(v2Request),
		);
		const firstBinding = harness.store.files.map((file) => ({
			fileId: file.fileId,
			executionId: file.executionId,
			sessionGeneration: file.sessionGeneration,
			messageId: file.messageId,
			revision: file.revision,
		}));
		expect(firstBinding).toEqual([
			{
				fileId: "file-a",
				executionId: accepted.plan.executionId,
				sessionGeneration: conversation.sessionGeneration,
				messageId: null,
				revision: 2,
			},
			{
				fileId: "file-b",
				executionId: accepted.plan.executionId,
				sessionGeneration: conversation.sessionGeneration,
				messageId: null,
				revision: 2,
			},
		]);
		const replay = await harness.useCase.admit({
			...v2Request,
			requestId: "request-2",
		});
		expect(replay.outcome).toBe("replayed");
		if (replay.outcome !== "replayed")
			throw new Error("Expected Invocation V2 replay");
		expect(replay.plan.attachments).toEqual(accepted.plan.attachments);
		expect(harness.store.files).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ fileId: "file-a", revision: 2 }),
				expect.objectContaining({ fileId: "file-b", revision: 2 }),
			]),
		);
	});

	it("never rebinds an input that another Execution already owns", async () => {
		const harness = createHarness({
			files: [textFile("file-a"), textFile("file-b")],
		});
		expect((await harness.useCase.admit(v2Request)).outcome).toBe("accepted");
		harness.store.setActiveExecution(null);
		expect(
			await harness.useCase.admit({
				...v2Request,
				idempotencyKey: "invoke-2",
				requestId: "request-2",
			}),
		).toEqual({ outcome: "denied" });
		expect(harness.store.plans).toHaveLength(1);
	});

	it("fails closed when the persisted plan drops the accepted inputs", async () => {
		const store = new FakeNativeCapabilityAdmissionStoreV1({
			conversation,
			files: [textFile("file-a"), textFile("file-b")],
		});
		const source = createHarness({
			files: [textFile("file-a"), textFile("file-b")],
		});
		const accepted = await source.useCase.admit(v2Request);
		if (accepted.outcome !== "accepted")
			throw new Error("Expected Invocation V2 acceptance");
		const malformed = structuredClone(accepted.plan) as unknown as {
			attachments?: unknown;
			outbox: { payload: Record<string, unknown> };
		};
		delete malformed.attachments;
		delete malformed.outbox.payload.attachments;
		await expect(
			store.admitNativeCapability(
				{
					command: v2Request,
					authority,
					requestDigest: nativeCapabilityAdmissionRequestDigestV2(v2Request),
				},
				async () => malformed as never,
				() => true,
				async () => true,
			),
		).rejects.toThrow("Native capability admission plan is invalid");
	});

	it.each([
		{ label: "no FileLimits", limits: null },
		{
			label: "media type not allowed",
			limits: { ...textLimits, mediaTypes: ["image/png"] },
		},
	])("denies $label before binding", async ({ limits }) => {
		const harness = createHarness(
			{ files: [textFile("file-a"), textFile("file-b")] },
			new FakeNativeCapabilityMetadataRevalidationV1({ projection }),
			limits,
		);
		expect(await harness.useCase.admit(v2Request)).toEqual({
			outcome: "denied",
		});
		expect(harness.store.plans).toHaveLength(0);
		expect(harness.store.files.every((file) => file.executionId === null)).toBe(
			true,
		);
	});
});
