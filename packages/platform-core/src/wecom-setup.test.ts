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
	await expect(usecase.current("agent", "other-owner")).rejects.toThrow(
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
