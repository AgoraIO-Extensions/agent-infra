import { createHash } from "node:crypto";
import {
	chmod,
	mkdir,
	mkdtemp,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const protection = vi.hoisted(() => vi.fn());
vi.mock("./process-protection.js", () => ({
	assertRuntimeProcessProtection: protection,
}));

import {
	createIndependentConnectionClientInput,
	readConnectionClientProfile,
} from "./connection-client-input.js";

const directories: string[] = [];
const profile = {
	profileRef: "local",
	serviceRef: "connection-local",
	issuer: "https://connection.example.test",
	resource: "https://connection.example.test/mcp",
};
const binding = {
	principal: { kind: "user" as const, id: "original-user" },
	scope: {
		agentId: "agent-1",
		conversationId: "conversation-1",
		sessionGeneration: 1,
		executionId: "execution-1",
	},
};
const client = {
	service: {
		serviceRef: profile.serviceRef,
		issuer: profile.issuer,
		resource: profile.resource,
	},
	connectionIdentity: {
		principal: { type: "user", key: "connection-subject" },
		actorId: "registered-agent",
		consumerId: "consumer",
		clientId: "client",
	},
	credential: {
		revision: "revision-1",
		expiresAt: 1_900_000_000_000,
		accessToken: "synthetic-private-token",
	},
};
const delivered = {
	principal: binding.principal,
	agentId: binding.scope.agentId,
	client,
};

afterEach(async () => {
	protection.mockReset();
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

async function fixture() {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "independent-client-")),
	);
	directories.push(directory);
	const inputDirectory = join(directory, "independent-client-input");
	await mkdir(inputDirectory, { mode: 0o700 });
	const hash = createHash("sha256")
		.update(
			JSON.stringify([
				binding.principal.kind,
				binding.principal.id,
				binding.scope.agentId,
				profile.profileRef,
			]),
		)
		.digest("hex");
	const file = join(inputDirectory, `${hash}.json`);
	const write = (value: unknown) =>
		writeFile(file, JSON.stringify(value), { mode: 0o600 });
	await write(delivered);
	const resolveOriginalBinding = vi.fn(async () => structuredClone(binding));
	const input = createIndependentConnectionClientInput({
		dataDirectory: directory,
		profile,
		resolveOriginalBinding,
	});
	return {
		directory,
		inputDirectory,
		file,
		write,
		resolveOriginalBinding,
		input,
		read: () =>
			input.resolveOriginalClient(binding.scope, new AbortController().signal),
	};
}

describe("independent Connection credential delivery", () => {
	it("accepts only an explicit nonsecret HTTPS MCP profile", () => {
		expect(readConnectionClientProfile(undefined)).toBeUndefined();
		expect(readConnectionClientProfile(JSON.stringify(profile))).toEqual(
			profile,
		);
		for (const value of [
			"",
			"null",
			JSON.stringify({ ...profile, accessToken: "synthetic-private-token" }),
			...[
				{ resource: "http://connection.example.test/mcp" },
				{ resource: "https://user:password@connection.example.test/mcp" },
				{
					resource:
						"https://connection.example.test/mcp?token=synthetic-private-token",
				},
				{ resource: "https://connection.example.test/another" },
				{ profileRef: "../../other-client" },
			].map((patch) => JSON.stringify({ ...profile, ...patch })),
		]) {
			expect(() => readConnectionClientProfile(value)).toThrow(
				/^RUNTIME_CONFIGURATION_INVALID$/,
			);
		}
	});

	it("selects the original subject and Agent and observes an independent credential rotation", async () => {
		const env = await fixture();
		await expect(env.read()).resolves.toEqual({
			originalBinding: binding,
			...client,
		});
		expect(protection).toHaveBeenCalledTimes(1);
		expect(env.resolveOriginalBinding).toHaveBeenCalledTimes(2);
		const rotated = {
			...client,
			credential: {
				...client.credential,
				revision: "revision-2",
				accessToken: "synthetic-rotated-token",
			},
		};
		await writeFile(
			`${env.file}.replacement`,
			JSON.stringify({ ...delivered, client: rotated }),
			{ mode: 0o600 },
		);
		await rename(`${env.file}.replacement`, env.file);
		await expect(env.read()).resolves.toEqual({
			originalBinding: binding,
			...rotated,
		});
	});

	it("refuses missing, cross-subject, cross-application and cross-Agent deliveries without fallback", async () => {
		const env = await fixture();
		for (const value of [
			{ ...delivered, principal: { kind: "user", id: "other-user" } },
			{
				...delivered,
				principal: { kind: "application", id: binding.principal.id },
			},
			{ ...delivered, agentId: "other-agent" },
			{ ...delivered, owner: "fallback-owner" },
			{
				...delivered,
				client: {
					...client,
					originalBinding: {
						...binding,
						principal: { kind: "user", id: "other-user" },
					},
				},
			},
		]) {
			await env.write(value);
			await expect(env.read()).resolves.toBeUndefined();
		}
		await rm(env.file);
		await expect(env.read()).resolves.toBeUndefined();
	});

	it("rejects readable-by-others files and symlinks before loading their contents", async () => {
		const env = await fixture();
		await chmod(env.file, 0o644);
		await expect(env.read()).resolves.toBeUndefined();
		await chmod(env.file, 0o600);
		await chmod(env.inputDirectory, 0o755);
		await expect(env.read()).resolves.toBeUndefined();
		await chmod(env.inputDirectory, 0o700);
		await rename(env.file, `${env.file}.target`);
		await symlink(`${env.file}.target`, env.file);
		await expect(env.read()).resolves.toBeUndefined();
		await rm(env.file);
		await rename(`${env.file}.target`, env.file);
		await rename(env.inputDirectory, `${env.inputDirectory}.target`);
		await symlink(`${env.inputDirectory}.target`, env.inputDirectory);
		await expect(env.read()).resolves.toBeUndefined();
	});

	it("bounds input and does not echo malformed private data", async () => {
		const env = await fixture();
		for (const text of ["synthetic-private-token", " ".repeat(32_769)]) {
			await writeFile(env.file, text);
			await expect(env.read()).resolves.toBeUndefined();
		}
	});

	it("rechecks original authorization after the credential read", async () => {
		const env = await fixture();
		env.resolveOriginalBinding
			.mockResolvedValueOnce(binding)
			.mockRejectedValueOnce(new Error("authorization revoked"));
		await expect(env.read()).rejects.toThrow("authorization revoked");
		expect(env.resolveOriginalBinding).toHaveBeenCalledTimes(2);
	});

	it("requires protection and a live request before looking up the original identity", async () => {
		const env = await fixture();
		protection.mockImplementationOnce(() => {
			throw new Error("RUNTIME_PROCESS_PROTECTION_INVALID");
		});
		await expect(env.read()).rejects.toThrow(
			"RUNTIME_PROCESS_PROTECTION_INVALID",
		);
		expect(env.resolveOriginalBinding).not.toHaveBeenCalled();
		await expect(
			env.input.resolveOriginalClient(binding.scope, AbortSignal.abort()),
		).rejects.toThrow();
		expect(env.resolveOriginalBinding).not.toHaveBeenCalled();
	});
});

describe("query-only independent Connection input", () => {
	it("uses original query provenance after business expiry, checks scope and cancellation, and observes rotation", async () => {
		const env = await fixture();
		env.resolveOriginalBinding.mockRejectedValue(
			new Error("expired business grant"),
		);
		const reference = { ...binding.scope, nativeSessionRef: "native-original" };
		const controller = new AbortController();
		const read = {
			signal: controller.signal,
			expiresAt: 1_900_000_000_000,
			assertCurrent: () => {
				controller.signal.throwIfAborted();
				return binding;
			},
			commit: async <T>(write: () => Promise<T>) => write(),
		};
		expect(
			await env.input.resolveReadOnlyClient?.(
				reference,
				read,
				controller.signal,
			),
		).toEqual({ originalBinding: binding, ...client });
		expect(env.resolveOriginalBinding).not.toHaveBeenCalled();
		expect(
			await env.input.resolveReadOnlyClient?.(
				{ ...reference, executionId: "other-execution" },
				read,
				controller.signal,
			),
		).toBeUndefined();
		await env.write({
			...delivered,
			client: {
				...client,
				credential: { ...client.credential, revision: "rotated" },
			},
		});
		expect(
			await env.input.resolveReadOnlyClient?.(
				reference,
				read,
				controller.signal,
			),
		).toMatchObject({ credential: { revision: "rotated" } });
		controller.abort();
		await expect(
			env.input.resolveReadOnlyClient?.(reference, read, controller.signal),
		).rejects.toThrow();
	});
});
