import type { LookupFunction } from "node:net";
import type { ConnectionInstallReadbackRequestV1 } from "@agent-infra/contracts/runtime";
import { expect, it, vi } from "vitest";
import { runtimeTlsFixture } from "../../../tests/runtime-tls-fixture.js";
import { createConnectionInstallReadbackClientV1 } from "../../agent-runtime-host/src/connection-install-readback-client.js";
import {
	createConnectionInstallReadbackServerV1,
	sessionSandboxConnectionInstallTokenV1,
} from "./connection-install-readback-server.js";
import { sessionSandboxServiceTokenV1 } from "./session-workload-adapter.js";

const workerHost = "install-worker.agents.svc";
const namespace = "agents";
const sandbox = "sandbox-a";
const deploymentServiceToken = "synthetic-worker-root";
const deploymentIdentity = "agents/release-a";
const lookup: LookupFunction = (_host, options, done) => {
	if (typeof options === "object" && options?.all) {
		(
			done as (
				error: null,
				addresses: { address: string; family: number }[],
			) => void
		)(null, [{ address: "127.0.0.1", family: 4 }]);
	} else {
		done(null, "127.0.0.1", 4);
	}
};

const scope = {
	purpose: "supply",
	target: {
		deploymentIdentity,
		hostRef: "host-a",
		sandboxId: sandbox,
		podUid: "pod-a",
		sessionGeneration: 1,
		resourceFence: 1,
		runtimeOrigin: "https://sandbox-sandbox-a.agents.svc:4443/",
	},
	principal: { kind: "user", id: "user-a" },
	reference: {
		agentId: "agent-a",
		conversationId: "conversation-a",
		executionId: "execution-a",
		sessionGeneration: 1,
	},
	authorizationId: "authorization-a",
	confirmationRevision: "revision-a",
	templateDigest: "a".repeat(64),
	supply: { ref: "supply-a", revision: "supply-r1", attemptId: "attempt-a" },
} satisfies Omit<
	ConnectionInstallReadbackRequestV1,
	"schemaVersion" | "nonce" | "issuedAt" | "expiresAt"
>;

it("authenticates scoped install readback over TLS before consulting the authority", async () => {
	const tls = await runtimeTlsFixture({ dnsNames: [workerHost] });
	const readback = vi.fn(async () => "allowed" as const);
	const server = createConnectionInstallReadbackServerV1({
		...tls,
		port: 0,
		host: "127.0.0.1",
		deploymentServiceToken,
		namespace,
		deploymentIdentity,
		readback,
	});
	const port = await server.listen();
	const token = sessionSandboxConnectionInstallTokenV1(
		deploymentServiceToken,
		namespace,
		sandbox,
	);
	const origin = `https://${workerHost}:${port}/`;
	const client = createConnectionInstallReadbackClientV1({
		origin,
		ca: tls.ca,
		installToken: token,
		lookup,
	});
	try {
		await expect(
			client.readback(scope, new AbortController().signal),
		).resolves.toBe("allowed");
		expect(readback).toHaveBeenCalledTimes(1);
		expect(readback).toHaveBeenCalledWith(
			expect.objectContaining(scope),
			expect.any(AbortSignal),
		);

		const anotherRelease = {
			...scope,
			target: { ...scope.target, deploymentIdentity: "agents/release-b" },
		};
		await expect(
			client.readback(anotherRelease, new AbortController().signal),
		).resolves.toBe("unavailable");

		const business = createConnectionInstallReadbackClientV1({
			origin,
			ca: tls.ca,
			lookup,
			installToken: sessionSandboxServiceTokenV1(
				deploymentServiceToken,
				namespace,
				sandbox,
			),
		});
		await expect(
			business.readback(scope, new AbortController().signal),
		).resolves.toBe("unavailable");
		expect(readback).toHaveBeenCalledTimes(1);
	} finally {
		await server.close();
		await tls.cleanup();
	}
});
