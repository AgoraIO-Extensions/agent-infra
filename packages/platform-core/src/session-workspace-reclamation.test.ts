import { describe, expect, it, vi } from "vitest";
import {
	createSessionWorkspaceReclamationV1,
	isWorkspaceRetainedV1,
} from "./session-workspace-reclamation.js";

const target = {
	sessionGeneration: 1,
	resourceFence: 2,
	agentId: "agent",
	sessionId: "session",
	sandboxId: "sandbox",
	namespace: "test",
	name: "sandbox-sandbox",
	uid: "uid",
	resourceVersion: "1",
};
const policy = {
	namespace: "test",
	minimumStoppedMs: 1,
	retainedAgentIds: [],
	retainedSessionIds: [],
	retainedSandboxIds: [],
};
describe("deployment workspace reclamation", () => {
	it("protects acceptance and synthetic samples plus exact deployment retention", () => {
		for (const agentId of [
			"agent_api_031fb123",
			"agent_ade388123",
			"agent_a50d49bb123",
			"agent_api_fea4123",
			"agent_api_bbbe123",
		])
			expect(isWorkspaceRetainedV1(policy, { ...target, agentId })).toBe(true);
		expect(
			isWorkspaceRetainedV1(
				{ ...policy, retainedSessionIds: ["session"] },
				target,
			),
		).toBe(true);
	});
	it("never completes charge release on deletion acknowledgement without absence", async () => {
		const store = {
			candidates: vi.fn(),
			prepare: vi.fn().mockResolvedValue("prepared"),
			complete: vi.fn(),
		};
		const pvc = {
			read: vi.fn().mockResolvedValue({ uid: "uid", resourceVersion: "1" }),
			delete: vi.fn(),
		};
		await expect(
			createSessionWorkspaceReclamationV1(store, pvc).execute(target),
		).rejects.toThrow("UNCONFIRMED");
		expect(store.complete).not.toHaveBeenCalled();
	});
	it("rejects replaced PVC before persisting intent or deleting", async () => {
		const store = { candidates: vi.fn(), prepare: vi.fn(), complete: vi.fn() };
		const pvc = {
			read: vi
				.fn()
				.mockResolvedValue({ uid: "replacement", resourceVersion: "1" }),
			delete: vi.fn(),
		};
		await expect(
			createSessionWorkspaceReclamationV1(store, pvc).execute(target),
		).rejects.toThrow("CONFLICT");
		expect(store.prepare).not.toHaveBeenCalled();
		expect(pvc.delete).not.toHaveBeenCalled();
	});
	it("retries a durable intent after absent PVC then releases exactly through complete", async () => {
		const store = {
			candidates: vi.fn(),
			prepare: vi.fn().mockResolvedValue("prepared"),
			complete: vi.fn(),
		};
		const pvc = { read: vi.fn().mockResolvedValue(null), delete: vi.fn() };
		await expect(
			createSessionWorkspaceReclamationV1(store, pvc).execute(target),
		).resolves.toBe("completed");
		expect(pvc.delete).not.toHaveBeenCalled();
		expect(store.complete).toHaveBeenCalledWith(target);
	});
});
