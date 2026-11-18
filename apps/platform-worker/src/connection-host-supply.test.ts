import { describe, expect, it, vi } from "vitest";
import { createProtectedConnectionHostSupplyV1 } from "./connection-host-supply.js";

describe("protected Connection Host supply adapter", () => {
	it("passes credential bytes only to the Host port and clears them after return", async () => {
		let received: Uint8Array | undefined;
		const port = {
			materialize: vi.fn(async (input: { credential: Uint8Array }) => {
				received = input.credential;
				return { ref: "agent-a", revision: "association-3" };
			}),
			revoke: vi.fn(async () => {}),
		};
		const supply = createProtectedConnectionHostSupplyV1(port);

		await expect(
			supply.materialize({
				agentId: "agent-a",
				associationRevision: 3,
				serviceCredential: "conn_consumer_0123456789",
			}),
		).resolves.toEqual({ ref: "agent-a", revision: "association-3" });
		expect(received).toBeDefined();
		expect(
			[...((received ?? new Uint8Array()) as Uint8Array)].every(
				(byte) => byte === 0,
			),
		).toBe(true);
		expect(port.materialize).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ agentId: "agent a", associationRevision: 1 },
		{ agentId: "agent-a", associationRevision: 0 },
		{ agentId: "agent-a", associationRevision: 1.5 },
	])(
		"rejects invalid identity before passing material to Host",
		async (input) => {
			const port = {
				materialize: vi.fn(async () => ({ ref: "agent-a", revision: "r1" })),
				revoke: vi.fn(async () => {}),
			};
			const supply = createProtectedConnectionHostSupplyV1(port);
			await expect(
				supply.materialize({
					...input,
					serviceCredential: "conn_consumer_0123456789",
				}),
			).rejects.toThrow("CONNECTION_HOST_SUPPLY_INPUT_INVALID");
			expect(port.materialize).not.toHaveBeenCalled();
		},
	);

	it("rejects invalid receipts and never returns a credential-shaped value", async () => {
		const port = {
			materialize: vi.fn(async () => ({
				ref: "agent-a",
				revision: "r1",
				serviceCredential: "conn_consumer_leak",
			})),
			revoke: vi.fn(async () => {}),
		};
		const supply = createProtectedConnectionHostSupplyV1(port);
		await expect(
			supply.materialize({
				agentId: "agent-a",
				associationRevision: 1,
				serviceCredential: "conn_consumer_0123456789",
			}),
		).rejects.toThrow("CONNECTION_HOST_SUPPLY_UNAVAILABLE");
	});

	it("keeps revoke scoped to the Agent and association revision", async () => {
		const port = {
			materialize: async () => ({ ref: "agent-a", revision: "r1" }),
			revoke: vi.fn(async () => {}),
		};
		const supply = createProtectedConnectionHostSupplyV1(port);
		await supply.revoke({ agentId: "agent-a", associationRevision: 7 });
		expect(port.revoke).toHaveBeenCalledWith({
			agentId: "agent-a",
			associationRevision: 7,
		});
	});
});
