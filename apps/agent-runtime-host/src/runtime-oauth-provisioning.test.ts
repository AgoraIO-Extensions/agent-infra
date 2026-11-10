import * as requireFs from "node:fs";
import {
	chmod,
	link,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runtimeTlsFixture } from "../../../tests/runtime-tls-fixture.js";
import {
	provisionRuntimeOAuthFiles,
	validateRuntimeOAuthProvisioning,
} from "./runtime-oauth-provisioning.js";

const protection = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock("./standard-mcp-protection.js", () => ({
	assertStandardMcpProcessProtection: protection.check,
}));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	protection.check.mockReset();
	for (const f of cleanup.splice(0).reverse()) await f();
});
async function fixture() {
	const tls = await runtimeTlsFixture({
		dnsNames: ["sandbox-a.workload-test.svc"],
	});
	cleanup.push(tls.cleanup);
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "oauth-provision-")),
	);
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const source = join(root, "source");
	const memory = join(root, "memory");
	for (const p of [source, memory]) await mkdir(p, { mode: 0o700 });
	await writeFile(join(source, "server.crt"), tls.cert, { mode: 0o440 });
	await writeFile(join(source, "server.key"), tls.key, { mode: 0o440 });
	await writeFile(
		join(source, "callback.auth"),
		"synthetic-callback-only-material",
		{ mode: 0o440 },
	);
	const input = {
		schemaVersion: 1,
		agentId: "agent-a",
		principal: { kind: "user", id: "alice" },
		sandboxId: "a",
		sessionGeneration: 1,
		configuration: {
			schemaVersion: 1,
			ref: "oauth",
			revision: "r1",
			clientId: "client-a",
			issuer: "https://connection.example.test/",
			authorizationEndpoint: "https://connection.example.test/oauth/authorize",
			tokenEndpoint: "https://connection.example.test/oauth/token",
			revocationEndpoint: "https://connection.example.test/oauth/revoke",
			callbackUrl: "https://platform.example.test/callback",
			runtimeOrigin: "https://sandbox-a.workload-test.svc:3443/",
			resource: "https://connection.example.test/mcp",
			scope: "mcp",
			configFingerprint: "a".repeat(64),
			source: { ref: "approved", revision: "r1" },
		},
	};
	const options = {
		dataDirectory: join(root, "runtime"),
		privateDirectory: memory,
		tlsSource: source,
		callbackSource: source,
		configurationBundle: input,
	};
	return { root, source, memory, input, options };
}
it("copies only approved local TLS/callback files as immutable owner-only bootstrap material", async () => {
	const f = await fixture();
	await provisionRuntimeOAuthFiles(f.options);
	for (const [part, names] of [
		["tls", ["server.crt", "server.key", "callback.auth"]],
		["bootstrap", ["configuration.json", "binding.json"]],
	] as const) {
		expect((await stat(join(f.memory, part))).mode & 0o777).toBe(0o700);
		for (const name of names)
			expect((await stat(join(f.memory, part, name))).mode & 0o777).toBe(0o600);
	}
	expect(
		await readFile(join(f.memory, "bootstrap", "configuration.json"), "utf8"),
	).not.toContain("synthetic-callback");
	await provisionRuntimeOAuthFiles(f.options);
	await chmod(join(f.source, "callback.auth"), 0o640);
	await writeFile(
		join(f.source, "callback.auth"),
		"another-synthetic-callback-material",
	);
	await expect(provisionRuntimeOAuthFiles(f.options)).rejects.toBeDefined();
});
it.each([
	"source escape",
	"source directory escape",
	"hardlink",
	"source root drift",
	"writable source",
	"certificate hostname",
	"process protection",
])("rejects %s without producing a bootstrap binding", async (reason) => {
	const f = await fixture();
	if (reason === "source escape") {
		await rm(join(f.source, "server.key"));
		await writeFile(join(f.root, "outside.key"), "synthetic-private-key", {
			mode: 0o600,
		});
		await symlink(join(f.root, "outside.key"), join(f.source, "server.key"));
	}
	if (reason === "source directory escape") {
		const alias = join(f.root, "source-alias");
		await symlink(f.source, alias);
		f.options.tlsSource = alias;
	}
	if (reason === "hardlink")
		await link(join(f.source, "server.key"), join(f.root, "linked.key"));
	if (reason === "source root drift") {
		let calls = 0;
		protection.check.mockImplementation(() => {
			if (++calls === 4) {
				const fs = requireFs;
				fs.renameSync(f.source, `${f.source}-old`);
				fs.mkdirSync(f.source, { mode: 0o700 });
				for (const name of ["server.crt", "server.key", "callback.auth"])
					fs.copyFileSync(join(`${f.source}-old`, name), join(f.source, name));
			}
		});
	}
	if (reason === "writable source")
		await chmod(join(f.source, "server.key"), 0o666);
	if (reason === "certificate hostname")
		f.input.configuration.runtimeOrigin = "https://other.example.test:3443/";
	if (reason === "process protection")
		protection.check.mockImplementation(() => {
			throw Error("protection");
		});
	await expect(provisionRuntimeOAuthFiles(f.options)).rejects.toBeDefined();
	await expect(
		stat(join(f.memory, "bootstrap", "binding.json")),
	).rejects.toBeDefined();
});
it("validates the original Session bundle before the Host reads OAuth configuration", async () => {
	const f = await fixture();
	await provisionRuntimeOAuthFiles(f.options);
	const base = join(
		f.options.dataDirectory,
		"codex-driver.json.native",
		"conversations",
		"standard-mcp-oauth",
	);
	await symlink(join(f.memory, "bootstrap"), join(base, "bootstrap"));
	// Production uses an actual subPath mount. A path alias is deliberately refused.
	await expect(
		validateRuntimeOAuthProvisioning(
			{
				AGENT_INFRA_RUNTIME_CONNECTION_OAUTH_PROVISIONED: "v1",
				AGENT_INFRA_RUNTIME_CONNECTION_OAUTH_FILE: join(
					base,
					"bootstrap",
					"configuration.json",
				),
			},
			f.options.dataDirectory,
		),
	).rejects.toBeDefined();
	await rm(join(base, "bootstrap"));
	await mkdir(join(base, "bootstrap"), { mode: 0o700 });
	for (const name of ["binding.json", "configuration.json"])
		await writeFile(
			join(base, "bootstrap", name),
			await readFile(join(f.memory, "bootstrap", name)),
			{ mode: 0o600 },
		);
	const environment = {
		AGENT_INFRA_RUNTIME_CONNECTION_OAUTH_PROVISIONED: "v1",
		AGENT_INFRA_RUNTIME_CONNECTION_OAUTH_FILE: join(
			base,
			"bootstrap",
			"configuration.json",
		),
		AGENT_INFRA_RUNTIME_AGENT_ID: "agent-a",
		AGENT_INFRA_RUNTIME_PRINCIPAL: JSON.stringify(f.input.principal),
		AGENT_INFRA_RUNTIME_SANDBOX_ID: "a",
		AGENT_INFRA_RUNTIME_SESSION_GENERATION: "1",
	};
	await validateRuntimeOAuthProvisioning(environment, f.options.dataDirectory);
	for (const drift of [
		{
			AGENT_INFRA_RUNTIME_PRINCIPAL: JSON.stringify({
				kind: "user",
				id: "bob",
			}),
		},
		{ AGENT_INFRA_RUNTIME_SANDBOX_ID: "b" },
		{ AGENT_INFRA_RUNTIME_SESSION_GENERATION: "2" },
		{ AGENT_INFRA_RUNTIME_AGENT_ID: "agent-b" },
	])
		await expect(
			validateRuntimeOAuthProvisioning(
				{ ...environment, ...drift },
				f.options.dataDirectory,
			),
		).rejects.toBeDefined();
});
