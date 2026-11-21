import { connectionManualPublicationContractV1 } from "@agent-infra/platform-store";
import { describe, expect, it } from "vitest";
import { parseRuntimeOAuthDynamicPublicationContractV1 } from "../../agent-runtime-host/src/runtime-oauth-dynamic-publication.js";
import type { SessionSandboxConnectionInstallBootstrapV1 } from "./connection-install-bootstrap.js";
import {
	connectionManualPublicationDescriptorV1,
	connectionManualPublicationProofMatchesV1,
	connectionManualPublicationProofV1,
	parseConnectionManualPublicationContractV1,
	withConnectionManualPublicationV1,
} from "./connection-manual-publication.js";

const descriptor = { ref: "connection-mcp-publication", revision: "1" };
const valid = {
	serviceRef: "connection-mcp",
	contract: {
		ref: descriptor.ref,
		revision: descriptor.revision,
		serverInfo: { name: "connection", version: "1.0.0" },
		tools: [
			{ name: "list_actions", succeededResultSchema: {} },
			{ name: "run_action", succeededResultSchema: {}, failedResultSchema: {} },
		],
	},
	toolDeclarations: [
		{
			name: "list_actions",
			description: "List actions.",
			inputSchema: { type: "object" },
		},
		{
			name: "run_action",
			description: "Run an action.",
			inputSchema: { type: "object" },
		},
	],
};
const variant = (change: (value: typeof valid) => unknown) =>
	JSON.stringify(change(structuredClone(valid)));

/** Rejected by the Host parser itself; the Worker must reject each one as well. */
const hostInvalid = [
	"{",
	"[]",
	variant(({ toolDeclarations: _, ...rest }) => rest),
	variant((v) => ({ ...v, extra: true })),
	variant((v) => ({ ...v, serviceRef: "bad ref" })),
	variant((v) => ({ ...v, contract: { ...v.contract, tools: [] } })),
	variant((v) => ({
		...v,
		contract: {
			...v.contract,
			tools: Array.from({ length: 33 }, (_, i) => ({ name: `tool-${i}` })),
		},
	})),
	variant((v) => ({
		...v,
		contract: {
			...v.contract,
			tools: [v.contract.tools[0], v.contract.tools[0]],
		},
	})),
	variant((v) => ({ ...v, toolDeclarations: [v.toolDeclarations[0]] })),
	variant((v) => ({
		...v,
		toolDeclarations: [
			v.toolDeclarations[0],
			{ ...v.toolDeclarations[1], name: "other" },
		],
	})),
	variant((v) => ({
		...v,
		toolDeclarations: [
			v.toolDeclarations[0],
			{ ...v.toolDeclarations[1], description: "x".repeat(1025) },
		],
	})),
	variant((v) => ({
		...v,
		contract: { ...v.contract, serverInfo: { name: "connection" } },
	})),
	JSON.stringify({ ...valid, padding: "x".repeat(65_536) }),
];

describe("#4199 C2 Worker publication contract input", () => {
	it("proves one decision for one Sandbox incarnation under the deployment key", () => {
		const binding = {
			namespace: "workload-test",
			sandboxId: "sandbox-a",
			generation: 2,
			resourceFence: 3,
			contract: JSON.stringify(valid),
		};
		const proof = connectionManualPublicationProofV1("key-a", binding);
		expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(
			connectionManualPublicationProofMatchesV1(proof, "key-a", binding),
		).toBe(true);
		const { contract: _contract, ...none } = binding;
		for (const [key, other] of [
			["key-b", binding],
			["key-a", none],
			[
				"key-a",
				{
					...binding,
					contract: variant((v) => ({ ...v, serviceRef: "other" })),
				},
			],
			["key-a", { ...binding, namespace: "other" }],
			["key-a", { ...binding, sandboxId: "sandbox-b" }],
			["key-a", { ...binding, generation: 3 }],
			["key-a", { ...binding, resourceFence: 4 }],
		] as const)
			expect(connectionManualPublicationProofMatchesV1(proof, key, other)).toBe(
				false,
			);
		expect(
			connectionManualPublicationProofMatchesV1(undefined, "key-a", binding),
		).toBe(false);
	});

	it("binds to the same descriptor contract as the exception gate", () => {
		expect(connectionManualPublicationDescriptorV1).toEqual(
			connectionManualPublicationContractV1,
		);
	});

	it("accepts exactly what the Host parser accepts, bound to the descriptor contract", () => {
		const raw = JSON.stringify(valid);
		expect(parseRuntimeOAuthDynamicPublicationContractV1(raw)).toEqual(valid);
		expect(parseConnectionManualPublicationContractV1(raw, descriptor)).toEqual(
			{ status: "valid", contract: raw },
		);
		for (const raw of hostInvalid) {
			expect(() =>
				parseRuntimeOAuthDynamicPublicationContractV1(raw),
			).toThrow();
			expect(
				parseConnectionManualPublicationContractV1(raw, descriptor),
			).toEqual({ status: "invalid" });
		}
		// The Host refuses another descriptor contract only when it publishes; the Worker
		// refuses it up front so no Session declares tools its Host would never publish.
		const other = variant((v) => ({
			...v,
			contract: { ...v.contract, revision: "2" },
		}));
		expect(parseRuntimeOAuthDynamicPublicationContractV1(other)).toBeDefined();
		expect(
			parseConnectionManualPublicationContractV1(other, descriptor),
		).toEqual({ status: "invalid" });
		for (const raw of [undefined, ""])
			expect(
				parseConnectionManualPublicationContractV1(raw, descriptor),
			).toEqual({ status: "absent" });
	});

	it("adds the contract only to running Session renders of an associated Agent", async () => {
		const bootstrap = {
			installToken: "fixture",
		} as unknown as SessionSandboxConnectionInstallBootstrapV1;
		const contract = JSON.stringify(valid);
		const reads: string[] = [];
		const publication = {
			contract,
			associated: async (agentId: string) => {
				reads.push(agentId);
				return agentId === "agent-associated";
			},
		};
		const unavailable = (): never => {
			throw new Error("unavailable");
		};
		const running = {
			desiredState: "running",
			requireCurrentTemplateTrust: true,
		} as const;
		const key = "fixture-deployment-token";
		const where = {
			namespace: "workload-test",
			sandboxId: "sandbox-a",
			generation: 2,
			resourceFence: 3,
		};
		const projected = await withConnectionManualPublicationV1(
			{
				...where,
				agentId: "agent-associated",
				connectionInstallBootstrap: bootstrap,
			},
			publication,
			running,
			unavailable,
			key,
		);
		expect(projected.connectionInstallBootstrap?.publicationContract).toBe(
			contract,
		);
		// The decision proof binds this contract to this Sandbox incarnation.
		expect(projected.connectionInstallBootstrap?.publicationProof).toBe(
			connectionManualPublicationProofV1(key, { ...where, contract }),
		);
		expect(bootstrap).not.toHaveProperty("publicationContract");
		for (const [allocation, render] of [
			[
				{
					...where,
					agentId: "agent-other",
					connectionInstallBootstrap: bootstrap,
				},
				running,
			],
			[{ ...where, agentId: "agent-associated" }, running],
			[
				{
					...where,
					agentId: "agent-associated",
					connectionInstallBootstrap: bootstrap,
				},
				{ desiredState: "stopped", requireCurrentTemplateTrust: true },
			],
			[
				{
					...where,
					agentId: "agent-associated",
					connectionInstallBootstrap: bootstrap,
				},
				{ desiredState: "running", requireCurrentTemplateTrust: false },
			],
		] as const) {
			const result = await withConnectionManualPublicationV1(
				allocation,
				publication,
				render,
				unavailable,
				key,
			);
			expect(
				(
					result as {
						connectionInstallBootstrap?: { publicationContract?: string };
					}
				).connectionInstallBootstrap?.publicationContract,
			).toBe(undefined);
		}
		expect(reads).toEqual(["agent-associated", "agent-other"]);
		await expect(
			withConnectionManualPublicationV1(
				{
					...where,
					agentId: "agent-associated",
					connectionInstallBootstrap: bootstrap,
				},
				{
					contract,
					associated: async () => {
						throw new Error("database down");
					},
				},
				running,
				unavailable,
				key,
			),
		).rejects.toThrow("unavailable");
		const untouched = {
			...where,
			agentId: "agent-associated",
			connectionInstallBootstrap: bootstrap,
		};
		expect(
			await withConnectionManualPublicationV1(
				untouched,
				undefined,
				running,
				unavailable,
				key,
			),
		).toBe(untouched);
	});
});
