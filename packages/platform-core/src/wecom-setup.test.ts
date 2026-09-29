import { expect, it } from "vitest";
import {
	agentConfigurationConformanceRecordV1,
	agentConfigurationCustomImageRecordV1,
} from "./agent-configuration.conformance.js";
import { createWecomSetupV1, type WecomSetupRecordV1 } from "./wecom-setup.js";

it("binds a one-use setup to its Owner, Agent and configuration version before encrypting", async () => {
	let record: WecomSetupRecordV1 | null = null;
	let encrypted = 0;
	let revision = 1;
	let selfManaged = false;
	let exposeSetupBinding = false;
	let now = new Date();
	const usecase = createWecomSetupV1({
		now: () => now,
		authority: async (agentId, actorId) =>
			["owner", "other-owner"].includes(actorId)
				? {
						configuration: {
							...(selfManaged
								? agentConfigurationCustomImageRecordV1
								: agentConfigurationConformanceRecordV1),
							agentId,
							revision,
							...(exposeSetupBinding && record
								? {
										channels: [
											{
												kind: "wecom_bot" as const,
												bindingReference: record.sessionId,
											},
										],
										channelRevision: "setup-channel",
									}
								: {}),
						},
						authorizationRevision: "a1",
					}
				: null,
		store: {
			async activeBinding(agentId, reference) {
				return (
					exposeSetupBinding &&
					agentId === "agent" &&
					reference === record?.sessionId
				);
			},
			async create(value) {
				record = value;
			},
			async read() {
				return record;
			},
			async consume(value) {
				if (record?.status !== "awaiting_input") return false;
				record = {
					...record,
					status: "verifying",
					botId: value.botId,
					encryptedCredential: value.encryptedCredential,
				};
				return true;
			},
			async cancel() {
				return false;
			},
		},
		encrypt: async () => {
			encrypted++;
			return { fixture: "ciphertext" };
		},
	});
	selfManaged = true;
	await expect(usecase.begin("agent", "owner")).rejects.toThrow("unavailable");
	selfManaged = false;
	const setup = await usecase.begin("agent", "owner");
	exposeSetupBinding = true;
	await expect(usecase.current("agent", "other-owner")).resolves.toEqual({
		status: "disconnected",
	});
	await expect(usecase.current("agent", "not-owner")).rejects.toThrow(
		"unavailable",
	);
	const input = {
		agentId: "agent",
		sessionId: setup.sessionId,
		state: setup.state,
		botId: "bot",
		secret: "fixture-secret",
		takeoverConfirmed: true,
	};
	await expect(usecase.submit(input, "other-owner")).rejects.toThrow(
		"unavailable",
	);
	await expect(
		usecase.submit({ ...input, agentId: "other-agent" }, "owner"),
	).rejects.toThrow("unavailable");
	await expect(
		usecase.submit({ ...input, state: "wrong" }, "owner"),
	).rejects.toThrow("unavailable");
	await expect(
		usecase.submit({ ...input, takeoverConfirmed: false }, "owner"),
	).rejects.toThrow("confirmation_required");
	const original = now;
	now = new Date(Date.now() + 600000);
	await expect(usecase.submit(input, "owner")).rejects.toThrow("unavailable");
	now = original;
	expect(encrypted).toBe(0);
	revision = 2;
	await expect(usecase.submit(input, "owner")).rejects.toThrow("stale");
	revision = 1;
	await expect(usecase.submit(input, "owner")).resolves.toMatchObject({
		status: "verifying",
	});
	await expect(usecase.submit(input, "owner")).rejects.toThrow("unavailable");
	expect(encrypted).toBe(1);
	expect(JSON.stringify(record)).not.toContain("fixture-secret");
});

it("stages application credentials only for the current Owner and verified setup state", async () => {
	let record: WecomSetupRecordV1 | null = null;
	let revision = 1;
	let authorizationRevision = "a1";
	let now = new Date();
	let encrypted = 0;
	let exposedApplication = false;
	let originalOwnerActive = true;
	const usecase = createWecomSetupV1({
		now: () => now,
		authority: async (agentId, actorId) =>
			(actorId === "owner" && originalOwnerActive) || actorId === "new-owner"
				? {
						configuration: {
							...agentConfigurationConformanceRecordV1,
							agentId,
							revision,
							...(exposedApplication && record
								? {
										channels: [
											{
												kind: "wecom_app" as const,
												bindingReference: record.sessionId,
											},
										],
									}
								: {}),
						},
						authorizationRevision,
					}
				: null,
		store: {
			async activeBinding(agentId, reference) {
				return (
					exposedApplication &&
					agentId === "agent" &&
					reference === record?.sessionId
				);
			},
			async create(value) {
				record = value;
			},
			async read() {
				return record;
			},
			async pendingApplication() {
				return record?.status === "verifying" ? record : null;
			},
			async consume(input) {
				if (record?.status !== "awaiting_input") return false;
				record = {
					...record,
					status: "verifying",
					botId: input.botId,
					application: input.application,
					encryptedCredential: input.encryptedCredential,
					encryptedCallback: input.encryptedCallback,
				};
				return true;
			},
			async cancel() {
				return false;
			},
		},
		encrypt: async () => {
			throw new Error("Bot encryptor must not run");
		},
		encryptApplication: async () => {
			encrypted++;
			return {
				encryptedCredential: { fixture: "application-ciphertext" },
				encryptedCallback: { fixture: "callback-ciphertext" },
			};
		},
	});
	const setup = await usecase.begin("agent", "owner", "wecom_app");
	const input = {
		agentId: "agent",
		sessionId: setup.sessionId,
		state: setup.state,
		corporationId: "corp",
		applicationId: "7",
		secret: "fixture-secret",
		token: "fixture-token",
		encodingAesKey: "A".repeat(43),
		takeoverConfirmed: true,
	};
	await expect(usecase.submitApplication(input, "other-owner")).rejects.toThrow(
		"unavailable",
	);
	await expect(
		usecase.submitApplication({ ...input, agentId: "other-agent" }, "owner"),
	).rejects.toThrow("unavailable");
	await expect(
		usecase.submitApplication({ ...input, state: "wrong" }, "owner"),
	).rejects.toThrow("unavailable");
	await expect(
		usecase.submitApplication({ ...input, takeoverConfirmed: false }, "owner"),
	).rejects.toThrow("confirmation_required");
	await expect(
		usecase.submit(
			{
				agentId: "agent",
				sessionId: setup.sessionId,
				state: setup.state,
				botId: "bot",
				secret: "fixture-secret",
				takeoverConfirmed: true,
			},
			"owner",
		),
	).rejects.toThrow("unavailable");
	now = new Date(Date.now() + 600_000);
	await expect(usecase.submitApplication(input, "owner")).rejects.toThrow(
		"unavailable",
	);
	now = new Date();
	revision++;
	await expect(usecase.submitApplication(input, "owner")).rejects.toThrow(
		"stale",
	);
	revision--;
	authorizationRevision = "a2";
	await expect(usecase.submitApplication(input, "owner")).rejects.toThrow(
		"stale",
	);
	authorizationRevision = "a1";
	await expect(
		usecase.submitApplication(input, "owner"),
	).resolves.toMatchObject({
		status: "verifying",
	});
	await expect(usecase.submitApplication(input, "owner")).rejects.toThrow(
		"unavailable",
	);
	expect(encrypted).toBe(1);
	expect(JSON.stringify(record)).not.toContain("fixture-secret");
	expect(await usecase.current("agent", "owner", "wecom_app")).toEqual({
		status: "verifying",
		sessionId: setup.sessionId,
	});
	expect(await usecase.current("other-agent", "owner", "wecom_app")).toEqual({
		status: "not_configured",
	});
	expect(await usecase.callback(setup.sessionId)).toMatchObject({
		sessionId: setup.sessionId,
		kind: "wecom_app",
	});
	expect(await usecase.acceptMessages(setup.sessionId)).toBe(false);
	exposedApplication = true;
	expect(await usecase.current("agent", "owner", "wecom_app")).toEqual({
		status: "verifying",
		sessionId: setup.sessionId,
	});
	const existing = await usecase.callback(setup.sessionId);
	if (!existing) throw new Error("Missing setup record");
	record = {
		...existing,
		status: "active",
		callbackVerifiedAt: now.toISOString(),
		connectionStatus: "connected",
	};
	expect(await usecase.current("agent", "owner", "wecom_app")).toEqual({
		status: "connected",
		sessionId: setup.sessionId,
	});
	expect(await usecase.acceptMessages(setup.sessionId)).toBe(true);
	record = { ...record, connectionStatus: "disconnected" };
	expect(await usecase.current("agent", "owner", "wecom_app")).toEqual({
		status: "disconnected",
		sessionId: setup.sessionId,
	});
	record = { ...record, connectionStatus: "auth_failed" };
	expect(await usecase.current("agent", "owner", "wecom_app")).toEqual({
		status: "auth_failed",
		sessionId: setup.sessionId,
	});
	record = { ...record, connectionStatus: "disconnected" };
	authorizationRevision = "a2";
	expect(await usecase.callback(setup.sessionId)).toMatchObject({
		status: "active",
	});
	originalOwnerActive = false;
	expect(await usecase.callback(setup.sessionId)).toMatchObject({
		status: "active",
	});
	expect(await usecase.acceptMessages(setup.sessionId)).toBe(true);
	expect(await usecase.current("agent", "new-owner", "wecom_app")).toEqual({
		status: "disconnected",
		sessionId: setup.sessionId,
	});
	exposedApplication = false;
	expect(await usecase.callback(setup.sessionId)).toBeNull();
	expect(await usecase.acceptMessages(setup.sessionId)).toBe(false);
});
