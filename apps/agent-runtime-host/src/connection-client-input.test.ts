import { createHash } from "node:crypto";
import {
	chmod,
	link,
	mkdir,
	mkdtemp,
	realpath,
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
const authorizedService = {
	serviceRef: profile.serviceRef,
	issuer: profile.issuer,
	resource: profile.resource,
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
	service: authorizedService,
	connectionIdentity: {
		principal: { type: "user" as const, key: "connection-subject" },
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

function inputPath(directory: string) {
	return join(
		directory,
		"independent-client-input",
		`${createHash("sha256")
			.update(
				JSON.stringify([
					binding.principal.kind,
					binding.principal.id,
					binding.scope.agentId,
					profile.profileRef,
				]),
			)
			.digest("hex")}.json`,
	);
}

async function fixture() {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "independent-client-")),
	);
	directories.push(directory);
	const inputDirectory = join(directory, "independent-client-input");
	await mkdir(inputDirectory, { mode: 0o700 });
	const file = inputPath(directory);
	const write = (value: unknown) =>
		writeFile(file, JSON.stringify(value), { mode: 0o600 });
	await write(delivered);
	const resolveOriginalBinding = vi.fn(async () => structuredClone(binding));
	const input = createIndependentConnectionClientInput({
		dataDirectory: directory,
		profile,
		authorizedService,
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

describe("independent Connection input", () => {
	it("accepts only a nonsecret HTTPS /mcp profile", () => {
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
				{ resource: "https://other.example.test/mcp" },
				{ issuer: "https://connection.example.test/issuer" },
				{ profileRef: "../../other-client" },
			].map((patch) => JSON.stringify({ ...profile, ...patch })),
		]) {
			expect(() => readConnectionClientProfile(value)).toThrow(
				/^RUNTIME_CONFIGURATION_INVALID$/,
			);
		}
	});

	it("always carries the deployment-owned service authority", async () => {
		const env = await fixture();
		expect(env.input).toMatchObject({ profile, authorizedService });
		if (process.platform !== "linux") {
			await expect(env.read()).resolves.toBeUndefined();
			return;
		}
		await expect(env.read()).resolves.toEqual({
			originalBinding: binding,
			...client,
		});
		expect(protection).toHaveBeenCalledOnce();
		expect(env.resolveOriginalBinding).toHaveBeenCalledTimes(2);
	});

	it("refuses missing, cross-subject, cross-Agent and malformed deliveries without fallback", async () => {
		const env = await fixture();
		if (process.platform !== "linux") return;
		for (const value of [
			{ ...delivered, principal: { kind: "user", id: "other-user" } },
			{ ...delivered, agentId: "other-agent" },
			{ ...delivered, owner: "fallback-owner" },
			{
				...delivered,
				client: {
					...client,
					service: {
						...client.service,
						resource: "https://other.example.test/mcp",
					},
				},
			},
			{
				...delivered,
				client: {
					...client,
					credential: { ...client.credential, expiresAt: "not-a-timestamp" },
				},
			},
		]) {
			await env.write(value);
			await expect(env.read()).resolves.toBeUndefined();
		}
		await rm(env.file);
		await expect(env.read()).resolves.toBeUndefined();
	});

	it("rejects malformed private input UTF-8", async () => {
		const env = await fixture();
		if (process.platform !== "linux") return;
		await writeFile(env.file, Buffer.from([0xc3, 0x28]));
		await expect(env.read()).resolves.toBeUndefined();
	});

	it("rejects readable-by-others files, hardlinks and symlinks", async () => {
		const env = await fixture();
		if (process.platform !== "linux") return;
		await chmod(env.file, 0o644);
		await expect(env.read()).resolves.toBeUndefined();
		await chmod(env.file, 0o600);
		await link(env.file, `${env.file}.hardlink`);
		await expect(env.read()).resolves.toBeUndefined();
		await rm(`${env.file}.hardlink`);
		await chmod(env.inputDirectory, 0o755);
		await expect(env.read()).resolves.toBeUndefined();
		await chmod(env.inputDirectory, 0o700);
		await symlink(env.file, `${env.file}.symlink`);
		await rm(env.file);
		await symlink(`${env.file}.symlink`, env.file);
		await expect(env.read()).resolves.toBeUndefined();
	});

	it("bounds private input and rechecks authorization after a read", async () => {
		const env = await fixture();
		if (process.platform !== "linux") return;
		await writeFile(env.file, " ".repeat(32_769));
		await expect(env.read()).resolves.toBeUndefined();
		await env.write(delivered);
		env.resolveOriginalBinding.mockClear();
		env.resolveOriginalBinding
			.mockResolvedValueOnce(binding)
			.mockRejectedValueOnce(new Error("authorization revoked"));
		await expect(env.read()).rejects.toThrow("authorization revoked");
		expect(env.resolveOriginalBinding).toHaveBeenCalledTimes(2);
	});

	it("requires process protection and a live request before credential lookup", async () => {
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

	it("checks every original scope on read-only recovery", async () => {
		const env = await fixture();
		const controller = new AbortController();
		const read = {
			signal: controller.signal,
			expiresAt: 1_900_000_000_000,
			assertCurrent: () => binding,
			commit: async <T>(write: () => Promise<T>) => write(),
		};
		if (process.platform === "linux") {
			await expect(
				env.input.resolveReadOnlyClient?.(
					{ ...binding.scope, nativeSessionRef: "native-original" },
					read,
					controller.signal,
				),
			).resolves.toEqual({ originalBinding: binding, ...client });
		}
		await expect(
			env.input.resolveReadOnlyClient?.(
				{ ...binding.scope, executionId: "other-execution" },
				read,
				controller.signal,
			),
		).resolves.toBeUndefined();
		controller.abort();
		await expect(
			env.input.resolveReadOnlyClient?.(binding.scope, read, controller.signal),
		).rejects.toThrow();
	});
});
