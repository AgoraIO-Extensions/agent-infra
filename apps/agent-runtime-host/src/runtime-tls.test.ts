import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runtimeTlsFixture } from "../../../tests/runtime-tls-fixture.js";
import {
	readRuntimeHostTls,
	runtimeHostServiceDnsNames,
	validateRuntimeHostTls,
} from "./runtime-tls.js";

const mounted = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof import("node:fs/promises")>();
	return {
		...actual,
		readFile: (...args: Parameters<typeof actual.readFile>) =>
			String(args[0]).startsWith("/var/run/agent-infra/runtime-tls/")
				? mounted.read(...args)
				: actual.readFile(...args),
	};
});

const names = runtimeHostServiceDnsNames("agent-test", "platform");
describe("RuntimeHost TLS startup", () => {
	let material: Awaited<ReturnType<typeof runtimeTlsFixture>>;
	beforeAll(async () => {
		material = await runtimeTlsFixture({ dnsNames: names });
	});
	afterAll(async () => {
		await material?.cleanup();
	});
	it("loads only the fixed leaf mount and binds both actual Service names", async () => {
		mounted.read.mockImplementation(async (path: string) =>
			path.endsWith("tls.crt") ? material.cert : material.key,
		);
		const result = await readRuntimeHostTls({
			AGENT_INFRA_RUNTIME_AGENT_ID: "agent-test",
			AGENT_INFRA_RUNTIME_TLS_BINDING: JSON.stringify({
				agentId: "agent-test",
				namespace: "platform",
				serviceDnsNames: names,
			}),
		});
		expect(result.serviceDnsNames).toEqual(names);
		expect(() => validateRuntimeHostTls(result)).not.toThrow();
		expect(mounted.read.mock.calls.map(([path]) => path)).toEqual([
			"/var/run/agent-infra/runtime-tls/tls.crt",
			"/var/run/agent-infra/runtime-tls/tls.key",
		]);
	});
	it.each([
		{
			agentId: "agent-test",
			namespace: "platform",
			serviceDnsNames: runtimeHostServiceDnsNames("foreign-agent", "platform"),
		},
		{
			agentId: "agent-test",
			namespace: "platform",
			serviceDnsNames: [names[0]],
		},
		{ agentId: "other-agent", namespace: "platform", serviceDnsNames: names },
		{
			agentId: "agent-test",
			namespace: "other-namespace",
			serviceDnsNames: names,
		},
		{
			agentId: "agent-test",
			namespace: "platform",
			serviceDnsNames: names,
			keyFile: "/owner/key",
		},
	])(
		"rejects a mismatched or caller-extended binding before reading leaf material",
		async (binding) => {
			mounted.read.mockClear();
			await expect(
				readRuntimeHostTls({
					AGENT_INFRA_RUNTIME_AGENT_ID: "agent-test",
					AGENT_INFRA_RUNTIME_TLS_BINDING: JSON.stringify(binding),
				}),
			).rejects.toThrow("RUNTIME_TLS_CONFIGURATION_INVALID");
			expect(mounted.read).not.toHaveBeenCalled();
		},
	);
	it("rejects a leaf missing the verified-control Service SAN", () => {
		expect(() =>
			validateRuntimeHostTls({
				...material,
				serviceDnsNames: [...names, "wrong-probe.platform.svc"],
			}),
		).toThrow("RUNTIME_TLS_CONFIGURATION_INVALID");
	});
	it.each([
		["expired", { days: -1 }],
		["wrong purpose", { extendedKeyUsage: "clientAuth" }],
		["wildcard", { dnsNames: ["*.platform.svc"] }],
		["CN without SAN", { dnsNames: [], commonName: names[0] }],
	] as const)(
		"rejects %s server material before listening",
		async (_kind, options) => {
			const bad = await runtimeTlsFixture({ dnsNames: names, ...options });
			try {
				expect(() =>
					validateRuntimeHostTls({ ...bad, serviceDnsNames: names }),
				).toThrow("RUNTIME_TLS_CONFIGURATION_INVALID");
			} finally {
				await bad.cleanup();
			}
		},
	);
	it("rejects mismatched keys and malformed chains without exposing their bytes", async () => {
		const other = await runtimeTlsFixture();
		try {
			for (const tls of [
				{ ...material, key: other.key },
				{ ...material, cert: "" },
				{ ...material, cert: `${material.cert}${other.ca}` },
				{ ...material, cert: `${material.cert}unexpected` },
			]) {
				expect(() =>
					validateRuntimeHostTls({ ...tls, serviceDnsNames: names }),
				).toThrow(/^RUNTIME_TLS_CONFIGURATION_INVALID$/);
			}
		} finally {
			await other.cleanup();
		}
	});
});
