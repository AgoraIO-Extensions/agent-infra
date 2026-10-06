import {
	chmod,
	link,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	closeStandardMcpFixtures,
	reference,
	standardMcpFixture,
	token,
} from "../../../packages/agent-runtime/src/standard-mcp.fixture.js";
import {
	createProtectedStandardMcpInput,
	standardMcpInstallationKey,
	standardMcpMaterialKey,
} from "./standard-mcp-input.js";

const protection = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock("./standard-mcp-protection.js", () => ({
	assertStandardMcpProcessProtection: protection.check,
}));
const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	protection.check.mockReset();
	for (const path of directories.splice(0))
		await rm(path, { recursive: true, force: true });
	await closeStandardMcpFixtures();
});

async function setup() {
	const fixture = await standardMcpFixture();
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "standard-mcp-input-")),
	);
	directories.push(directory);
	const base = join(
		directory,
		"codex-driver.json.native",
		"conversations",
		"standard-mcp-input",
	);
	const bindings = join(base, "bindings");
	const materials = join(base, "materials");
	await mkdir(bindings, { recursive: true, mode: 0o700 });
	await mkdir(materials, { mode: 0o700 });
	const key = standardMcpInstallationKey(
		fixture.input.principal,
		reference.agentId,
		fixture.target,
	);
	const metadataPath = join(bindings, `${key}.json`);
	const tokenPath = join(
		materials,
		`${standardMcpMaterialKey(key, fixture.input.credentialRef, fixture.input.credentialRevision)}.token`,
	);
	const { scope: _scope, token: _token, ...metadata } = fixture.input;
	await writeFile(
		metadataPath,
		JSON.stringify({ ...metadata, agentId: reference.agentId }),
		{ mode: 0o600 },
	);
	await writeFile(tokenPath, token, { mode: 0o400 });
	const binding = {
		principal: fixture.input.principal,
		scope: fixture.input.scope,
	};
	const store = {
		resolveOriginalExecutionBinding: vi.fn(async () =>
			structuredClone(binding),
		),
	};
	const options = await createProtectedStandardMcpInput({
		dataDirectory: directory,
		target: fixture.target,
		store,
	});
	if (!options) throw new Error("Missing fixture installation");
	return {
		fixture,
		directory,
		bindings,
		metadataPath,
		tokenPath,
		options,
		store,
	};
}

it("reads separate protected material only for the original approved installation", async () => {
	const env = await setup();
	expect(
		await env.options.resolveInput(reference, new AbortController().signal),
	).toEqual(env.fixture.input);
	expect(env.store.resolveOriginalExecutionBinding).toHaveBeenCalledTimes(2);
	expect(protection.check).toHaveBeenCalledTimes(4);
});

it("does not configure a client from a snapshot without a dedicated installation", async () => {
	const fixture = await standardMcpFixture();
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "standard-mcp-absent-")),
	);
	directories.push(directory);
	const resolveOriginalExecutionBinding = vi.fn();
	expect(
		await createProtectedStandardMcpInput({
			dataDirectory: directory,
			target: fixture.target,
			store: { resolveOriginalExecutionBinding },
		}),
	).toBeUndefined();
	expect(resolveOriginalExecutionBinding).not.toHaveBeenCalled();
	expect(protection.check).not.toHaveBeenCalled();
	expect(fixture.trace).toHaveLength(0);
});

it.each(["symlink", "parent-alias", "file", "readable", "owner"])(
	"does not treat %s installation configuration as absent",
	async (kind) => {
		const env = await setup();
		const parent = join(
			env.directory,
			"codex-driver.json.native",
			"conversations",
		);
		const base = join(parent, "standard-mcp-input");
		if (kind === "parent-alias") {
			await rm(parent, { recursive: true });
			await symlink(join(env.directory, "missing-directory"), parent);
		} else if (kind === "symlink" || kind === "file") {
			await rm(base, { recursive: true });
			if (kind === "file")
				await writeFile(base, "synthetic-invalid-installation", {
					mode: 0o600,
				});
			else {
				const external = join(env.directory, "other-installation");
				await mkdir(external, { mode: 0o700 });
				await symlink(external, base);
			}
		} else if (kind === "readable") await chmod(base, 0o755);
		else if (process.getuid)
			vi.spyOn(process, "getuid").mockReturnValue(process.getuid() + 1);
		const configured = await createProtectedStandardMcpInput({
			dataDirectory: env.directory,
			target: env.fixture.target,
			store: env.store,
		});
		expect(configured).toBeDefined();
		await expect(
			configured?.resolveInput(reference, new AbortController().signal),
		).rejects.toMatchObject({ code: "CONNECTION_STANDARD_CLIENT_UNAVAILABLE" });
		expect(env.store.resolveOriginalExecutionBinding).not.toHaveBeenCalled();
		expect(env.fixture.trace).toHaveLength(0);
	},
);

it("does not touch materials when actual process protection is unavailable", async () => {
	const env = await setup();
	protection.check.mockImplementation(() => {
		throw new Error("protection-sentinel");
	});
	await rm(env.tokenPath);
	await expect(
		env.options.resolveInput(reference, new AbortController().signal),
	).rejects.toMatchObject({
		code: "CONNECTION_STANDARD_CLIENT_UNAVAILABLE",
		message: "Standard Connection installation is unavailable",
	});
	expect(env.store.resolveOriginalExecutionBinding).not.toHaveBeenCalled();
});

it.each(["principal", "agent", "profile", "expired", "inline-token"])(
	"denies %s metadata without leaking or accepting material",
	async (kind) => {
		const env = await setup();
		const metadata = JSON.parse(await readFile(env.metadataPath, "utf8"));
		if (kind === "principal")
			metadata.principal = { kind: "user", id: "user-b" };
		if (kind === "agent") metadata.agentId = "agent-b";
		if (kind === "profile") metadata.configFingerprint = "0".repeat(64);
		if (kind === "expired") metadata.expiresAt = Date.now() - 1;
		if (kind === "inline-token") metadata.token = token;
		await writeFile(env.metadataPath, JSON.stringify(metadata));
		await expect(
			env.options.resolveInput(reference, new AbortController().signal),
		).rejects.toThrow("installation is unavailable");
		expect(env.store.resolveOriginalExecutionBinding).toHaveBeenCalledTimes(1);
	},
);

it.each(["symlink", "hardlink", "readable"])(
	"rejects %s material",
	async (kind) => {
		const env = await setup();
		if (kind === "symlink") {
			await rm(env.tokenPath);
			const external = join(env.directory, "outside-token");
			await writeFile(external, token, { mode: 0o400 });
			await symlink(external, env.tokenPath);
		}
		if (kind === "hardlink")
			await link(env.tokenPath, `${env.tokenPath}.alias`);
		if (kind === "readable") await chmod(env.tokenPath, 0o644);
		await expect(
			env.options.resolveInput(reference, new AbortController().signal),
		).rejects.toMatchObject({ code: "CONNECTION_STANDARD_CLIENT_UNAVAILABLE" });
	},
);

it("rejects original authority change after a material read", async () => {
	const env = await setup();
	env.store.resolveOriginalExecutionBinding
		.mockImplementationOnce(async () => ({
			principal: env.fixture.input.principal,
			scope: env.fixture.input.scope,
		}))
		.mockImplementationOnce(async () => ({
			principal: { kind: "user", id: "user-b" },
			scope: env.fixture.input.scope,
		}));
	await expect(
		env.options.resolveInput(reference, new AbortController().signal),
	).rejects.toThrow("installation is unavailable");
});
