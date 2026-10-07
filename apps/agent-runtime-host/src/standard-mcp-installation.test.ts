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
	unlink,
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
import { createProtectedStandardMcpInput } from "./standard-mcp-input.js";
import { receiveProtectedStandardMcpInstallation } from "./standard-mcp-installation.js";
import { writeStandardMcpExport } from "./standard-mcp-installation.test-support.js";

const faults = vi.hoisted(() => ({
	failure: "" as string,
	renamed: false,
	materialOpens: 0,
	events: [] as string[],
	mutate: undefined as (() => Promise<void>) | undefined,
	protection: vi.fn(),
}));
vi.mock("./standard-mcp-protection.js", () => ({
	assertStandardMcpProcessProtection: faults.protection,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...fs,
		open: async (...args: Parameters<typeof fs.open>) => {
			const path = String(args[0]);
			const file = await fs.open(...args);
			if (path.includes("standard-mcp-export") && path.endsWith(".token")) {
				faults.materialOpens++;
				await faults.mutate?.();
			}
			const sync = file.sync.bind(file);
			file.sync = async () => {
				let event = "";
				if (
					path.includes("standard-mcp-input/materials") &&
					path.endsWith(".token")
				)
					event = "material-sync";
				else if (path.includes(".stage-")) event = "metadata-sync";
				else if (path.endsWith("standard-mcp-input/bindings"))
					event = faults.renamed
						? "metadata-directory-sync"
						: "initial-directory-sync";
				else if (path.endsWith("/conversations"))
					event = "parent-directory-sync";
				else if (path.endsWith("/.receive.lock")) event = "lock-sync";
				if (event) faults.events.push(event);
				if (event && faults.failure === event)
					throw new Error("synthetic-private-diagnostic");
				return sync();
			};
			return file;
		},
		rename: async (...args: Parameters<typeof fs.rename>) => {
			faults.events.push("metadata-rename");
			if (faults.failure === "metadata-rename")
				throw new Error("synthetic-private-diagnostic");
			await fs.rename(...args);
			faults.renamed = true;
		},
	};
});
const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	faults.protection.mockReset();
	faults.failure = "";
	faults.renamed = false;
	faults.materialOpens = 0;
	faults.events.length = 0;
	faults.mutate = undefined;
	for (const path of directories.splice(0))
		await rm(path, { recursive: true, force: true });
	await closeStandardMcpFixtures();
});

async function setup() {
	const fixture = await standardMcpFixture();
	const dataDirectory = await realpath(
		await mkdtemp(join(tmpdir(), "protected-installation-")),
	);
	directories.push(dataDirectory);
	const source = await writeStandardMcpExport(dataDirectory, fixture.target, [
		fixture.input,
	]);
	const options = {
		dataDirectory,
		agentId: reference.agentId,
		target: fixture.target,
		revision: source.revision,
	};
	const original = {
		principal: fixture.input.principal,
		scope: fixture.input.scope,
	};
	const store = {
		resolveOriginalExecutionBinding: vi.fn(async () =>
			structuredClone(original),
		),
	};
	return { fixture, source, options, store };
}

it("publishes durable separated input and resolves only its authenticated original binding", async () => {
	const env = await setup();
	const receipt = await receiveProtectedStandardMcpInstallation(env.options);
	expect(receipt.status).toBe("available");
	const input = await createProtectedStandardMcpInput({
		...env.options,
		store: env.store,
		delivery: receipt,
	});
	expect(
		await input?.resolveInput(reference, new AbortController().signal),
	).toEqual(env.fixture.input);
	const record = env.source.record;
	expect(
		(
			await stat(
				join(
					env.source.inputDirectory,
					"materials",
					`${record.material}.token`,
				),
			)
		).mode & 0o777,
	).toBe(0o400);
	expect(
		await readFile(
			join(env.source.inputDirectory, "bindings", `${record.key}.json`),
			"utf8",
		),
	).not.toContain(token);
	expect(faults.events.indexOf("material-sync")).toBeLessThan(
		faults.events.indexOf("metadata-sync"),
	);
	expect(faults.events.indexOf("metadata-sync")).toBeLessThan(
		faults.events.indexOf("metadata-rename"),
	);
	expect(faults.events.indexOf("metadata-rename")).toBeLessThan(
		faults.events.indexOf("metadata-directory-sync"),
	);
	expect(await receiveProtectedStandardMcpInstallation(env.options)).toEqual(
		receipt,
	);
});

it("preserves the absent source state without any protection or material access", async () => {
	const env = await setup();
	expect(
		await receiveProtectedStandardMcpInstallation({
			...env.options,
			revision: undefined,
		}),
	).toEqual({ status: "unconfigured" });
	expect(faults.protection).not.toHaveBeenCalled();
	expect(faults.materialOpens).toBe(0);
});

it.each(["parent-directory-sync", "initial-directory-sync", "lock-sync"])(
	"cannot publish after %s fails on first reception",
	async (failure) => {
		const env = await setup();
		faults.failure = failure;
		expect(await receiveProtectedStandardMcpInstallation(env.options)).toEqual({
			status: "unavailable",
		});
		expect(faults.materialOpens).toBe(0);
		expect(faults.renamed).toBe(false);
	},
);

it.each([
	"missing",
	"invalid-selector",
	"protection",
	"foreign-agent",
	"foreign-principal",
	"foreign-profile",
	"foreign-consumer",
	"foreign-audience",
	"foreign-source",
	"unknown-field",
	"expired",
	"symlink",
	"hardlink",
	"permissions",
	"oversize",
])("rejects %s before opening material", async (failure) => {
	const env = await setup();
	const record = env.source.record;
	if (failure === "missing") await unlink(env.source.manifestPath);
	if (failure === "invalid-selector")
		env.options.revision = '["../../source","r1"]';
	if (failure === "protection")
		faults.protection.mockImplementation(() => {
			throw new Error("synthetic-private-diagnostic");
		});
	const fields: Record<string, unknown> = {
		"foreign-agent": { agentId: "another-agent" },
		"foreign-principal": { principal: { kind: "user", id: "another-user" } },
		"foreign-profile": { configFingerprint: "wrong" },
		"foreign-consumer": { consumerId: "another-consumer" },
		"foreign-audience": { audience: "another-resource" },
		"foreign-source": { source: { ref: "foreign", revision: "r1" } },
		"unknown-field": { token },
		expired: { expiresAt: 1 },
	};
	if (fields[failure])
		await writeFile(
			record.metadataPath,
			JSON.stringify({ ...record.metadata, ...(fields[failure] as object) }),
		);
	if (failure === "permissions") await chmod(record.metadataPath, 0o644);
	if (failure === "oversize")
		await writeFile(record.metadataPath, "x".repeat(65_537));
	if (failure === "hardlink")
		await link(
			record.metadataPath,
			join(env.options.dataDirectory, "second-link"),
		);
	if (failure === "symlink") {
		const other = join(env.options.dataDirectory, "metadata-alias");
		await writeFile(other, JSON.stringify(record.metadata), { mode: 0o600 });
		await unlink(record.metadataPath);
		await symlink(other, record.metadataPath);
	}
	expect(await receiveProtectedStandardMcpInstallation(env.options)).toEqual({
		status: "unavailable",
	});
	expect(faults.materialOpens).toBe(0);
});

it("rejects changed source metadata across the material read", async () => {
	const env = await setup();
	const record = env.source.record;
	faults.mutate = async () => {
		await writeFile(
			record.metadataPath,
			JSON.stringify({ ...record.metadata, credentialRevision: "changed" }),
		);
	};
	expect(await receiveProtectedStandardMcpInstallation(env.options)).toEqual({
		status: "unavailable",
	});
	expect(faults.renamed).toBe(false);
});

it("rejects different material or instance under the same credential revision", async () => {
	const env = await setup();
	expect(
		(await receiveProtectedStandardMcpInstallation(env.options)).status,
	).toBe("available");
	const record = env.source.record;
	await chmod(record.materialPath, 0o600);
	await writeFile(record.materialPath, "synthetic-conflicting-credential");
	expect(await receiveProtectedStandardMcpInstallation(env.options)).toEqual({
		status: "unavailable",
	});
	expect(
		await readFile(
			join(env.source.inputDirectory, "materials", `${record.material}.token`),
			"utf8",
		),
	).toBe(token);
	await writeFile(record.materialPath, token);
	await writeFile(
		record.metadataPath,
		JSON.stringify({ ...record.metadata, instanceRef: "foreign-instance" }),
	);
	expect(await receiveProtectedStandardMcpInstallation(env.options)).toEqual({
		status: "unavailable",
	});
});

it.each([
	"material-sync",
	"metadata-sync",
	"metadata-rename",
	"metadata-directory-sync",
])(
	"keeps unavailable after %s, distinguishing switch uncertainty",
	async (failure) => {
		const env = await setup();
		expect(
			(await receiveProtectedStandardMcpInstallation(env.options)).status,
		).toBe("available");
		const replacement = {
			...env.fixture.input,
			credentialRevision: "r2",
			token: "synthetic-replacement-credential",
		};
		const next = await writeStandardMcpExport(
			env.options.dataDirectory,
			env.fixture.target,
			[replacement],
			"r2",
		);
		faults.renamed = false;
		faults.failure = failure;
		const receipt = await receiveProtectedStandardMcpInstallation({
			...env.options,
			revision: next.revision,
		});
		expect(receipt).toEqual({ status: "unavailable" });
		const stored = JSON.parse(
			await readFile(
				join(
					env.source.inputDirectory,
					"bindings",
					`${env.source.record.key}.json`,
				),
				"utf8",
			),
		);
		expect(stored.credentialRevision).toBe(
			failure === "metadata-directory-sync"
				? "r2"
				: env.fixture.input.credentialRevision,
		);
		const client = await createProtectedStandardMcpInput({
			...env.options,
			store: env.store,
			delivery: receipt,
		});
		await expect(
			client?.resolveInput(reference, new AbortController().signal),
		).rejects.toMatchObject({ code: "CONNECTION_STANDARD_CLIENT_UNAVAILABLE" });
		faults.failure = "";
		expect(
			(
				await receiveProtectedStandardMcpInstallation({
					...env.options,
					revision: next.revision,
				})
			).status,
		).toBe("available");
	},
);

it("does not select a removed installation or a mutated receipt set", async () => {
	const env = await setup();
	expect(
		(await receiveProtectedStandardMcpInstallation(env.options)).status,
	).toBe("available");
	const foreign = {
		...env.fixture.input,
		principal: { kind: "user" as const, id: "user-b" },
		token: "synthetic-user-b-credential",
	};
	const source = await writeStandardMcpExport(
		env.options.dataDirectory,
		env.fixture.target,
		[foreign],
		"r2",
	);
	const receipt = await receiveProtectedStandardMcpInstallation({
		...env.options,
		revision: source.revision,
	});
	const client = await createProtectedStandardMcpInput({
		...env.options,
		store: env.store,
		delivery: receipt,
	});
	if (receipt.status !== "available")
		throw new Error("Missing controlled receipt");
	(receipt.installationKeys as Set<string>).add(env.source.record.key);
	await expect(
		client?.resolveInput(reference, new AbortController().signal),
	).rejects.toMatchObject({ code: "CONNECTION_STANDARD_CLIENT_UNAVAILABLE" });
});

it("keeps an unknown reception lock unavailable without deleting another writer's lock", async () => {
	const env = await setup();
	await mkdir(env.source.inputDirectory, { mode: 0o700 });
	const lock = join(env.source.inputDirectory, ".receive.lock");
	await writeFile(lock, "", { mode: 0o600 });
	expect(await receiveProtectedStandardMcpInstallation(env.options)).toEqual({
		status: "unavailable",
	});
	expect(await readFile(lock, "utf8")).toBe("");
	expect(faults.materialOpens).toBe(0);
});
