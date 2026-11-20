import { describe, expect, it, vi } from "vitest";
import { createProtectedConnectionHostSupplyV1 } from "./connection-host-supply.js";

const attemptId = "474482aa-0326-4d11-831f-92b111cbdd8a";

describe("protected Connection Host supply adapter", () => {
	const canaryCredential = "conn_consumer_canary-4206";

	function assertNoCanary(value: unknown) {
		expect(JSON.stringify(value)).not.toContain(canaryCredential);
	}

	it("passes credential bytes only to the Host port and clears them after return", async () => {
		let received: Uint8Array | undefined;
		const port = {
			materialize: vi.fn(async (input: { credential: Uint8Array }) => {
				received = input.credential;
				return {
					agentId: "agent-a",
					associationRevision: 3,
					attemptId,
					ref: "agent-a",
					revision: "association-3",
				};
			}),
			revoke: vi.fn(async () => {}),
		};
		const supply = createProtectedConnectionHostSupplyV1(port);

		await expect(
			supply.materialize({
				agentId: "agent-a",
				associationRevision: 3,
				attemptId,
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
				materialize: vi.fn(async () => ({
					agentId: "agent-a",
					associationRevision: 7,
					attemptId,
					ref: "agent-a",
					revision: "r1",
				})),
				revoke: vi.fn(async () => {}),
			};
			const supply = createProtectedConnectionHostSupplyV1(port);
			await expect(
				supply.materialize({
					...input,
					attemptId,
					serviceCredential: "conn_consumer_0123456789",
				}),
			).rejects.toThrow("CONNECTION_HOST_SUPPLY_INPUT_INVALID");
			expect(port.materialize).not.toHaveBeenCalled();
		},
	);

	it("rejects invalid receipts and never returns a credential-shaped value", async () => {
		const port = {
			materialize: vi.fn(async () => ({
				agentId: "agent-a",
				associationRevision: 1,
				attemptId,
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
				attemptId,
				serviceCredential: "conn_consumer_0123456789",
			}),
		).rejects.toThrow("CONNECTION_HOST_SUPPLY_UNAVAILABLE");
	});

	it.each([
		{ agentId: "agent-b" },
		{ associationRevision: 2 },
		{ attemptId: "fe2852f0-90fb-4571-9d45-e0467914c092" },
		{ ref: canaryCredential },
		{ revision: canaryCredential },
	])(
		"rejects a mismatched or sensitive Host receipt (%#)",
		async (overrides) => {
			const supply = createProtectedConnectionHostSupplyV1({
				materialize: async () => ({
					agentId: "agent-a",
					associationRevision: 3,
					attemptId,
					ref: "agent-a",
					revision: "r3",
					...overrides,
				}),
				revoke: async () => {},
			});
			await expect(
				supply.materialize({
					agentId: "agent-a",
					associationRevision: 3,
					attemptId,
					serviceCredential: canaryCredential,
				}),
			).rejects.toThrow("CONNECTION_HOST_SUPPLY_UNAVAILABLE");
		},
	);

	it("keeps revoke scoped to the Agent and association revision", async () => {
		const port = {
			materialize: async () => ({
				agentId: "agent-a",
				associationRevision: 7,
				attemptId,
				ref: "agent-a",
				revision: "r1",
			}),
			revoke: vi.fn(async () => {}),
		};
		const supply = createProtectedConnectionHostSupplyV1(port);
		await supply.revoke({
			agentId: "agent-a",
			associationRevision: 7,
			attemptId,
		});
		expect(port.revoke).toHaveBeenCalledWith({
			agentId: "agent-a",
			associationRevision: 7,
			attemptId,
		});
	});

	it.each([
		["Host write failure", "host-write-failed"],
		["CAS conflict", "CONNECTION_HOST_SUPPLY_CAS_CONFLICT"],
		["stale association", "CONNECTION_HOST_SUPPLY_STALE_ASSOCIATION"],
	])(
		"keeps the credential canary out of %s errors and public artifacts",
		async (_label, failureCode) => {
			const logs: string[] = [];
			const persisted: Record<string, unknown>[] = [];
			const port = {
				materialize: vi.fn(async () => {
					throw new Error(`${failureCode}:${canaryCredential}`);
				}),
				revoke: vi.fn(async () => {}),
			};
			const supply = createProtectedConnectionHostSupplyV1(port);
			const originalError = console.error;
			console.error = (...args: unknown[]) => logs.push(args.join(" "));
			try {
				let thrown: unknown;
				try {
					await supply.materialize({
						agentId: "agent-a",
						associationRevision: 4,
						attemptId,
						serviceCredential: canaryCredential,
					});
				} catch (error) {
					thrown = error;
				}
				const env = { AGENT_INFRA_CONNECTION_HOST_SUPPLY: "unavailable" };
				const argv = ["--connection-host-supply", "unavailable"];
				const artifacts = {
					thrown: String(thrown),
					persisted,
					logs,
					env,
					argv,
				};
				expect(String(thrown)).toBe(
					"Error: CONNECTION_HOST_SUPPLY_UNAVAILABLE",
				);
				assertNoCanary(artifacts);
			} finally {
				console.error = originalError;
			}
		},
	);

	it("keeps a canary out of revoke errors, receipt JSON, env, argv and logs", async () => {
		const logs: string[] = [];
		const port = {
			materialize: vi.fn(async () => ({
				agentId: "agent-a",
				associationRevision: 4,
				attemptId,
				ref: "agent-a",
				revision: "r4",
			})),
			revoke: vi.fn(async () => {
				throw new Error(`revoke-failed:${canaryCredential}`);
			}),
		};
		const supply = createProtectedConnectionHostSupplyV1(port);
		const originalError = console.error;
		console.error = (...args: unknown[]) => logs.push(args.join(" "));
		try {
			const receipt = await supply.materialize({
				agentId: "agent-a",
				associationRevision: 4,
				attemptId,
				serviceCredential: canaryCredential,
			});
			let thrown: unknown;
			try {
				await supply.revoke({
					agentId: "agent-a",
					associationRevision: 4,
					attemptId,
				});
			} catch (error) {
				thrown = error;
			}
			const artifacts = {
				receipt,
				persisted: JSON.stringify(receipt),
				env: { AGENT_INFRA_CONNECTION_HOST_SUPPLY: receipt.ref },
				argv: ["--connection-host-supply", receipt.ref],
				logs,
				thrown: String(thrown),
			};
			expect(String(thrown)).toBe("Error: CONNECTION_HOST_SUPPLY_UNAVAILABLE");
			assertNoCanary(artifacts);
		} finally {
			console.error = originalError;
		}
	});
});
