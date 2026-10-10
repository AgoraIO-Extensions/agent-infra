import { expect, it, vi } from "vitest";
import { createRuntimeFileBridgeFactoryV1 } from "./runtime-file-exchange.js";

const binding = {
	actorId: "actor-1",
	channelId: "web",
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	sessionGeneration: 1,
	grantId: "grant-1",
	expiresAt: Date.now() + 60_000,
	inputFileIds: ["input-1"],
} as const;

const grant = {
	schemaVersion: 1 as const,
	format: "compact-jws" as const,
	token: "a.b.c",
};

function response(
	file: Record<string, unknown>,
	path = "/api/v1/conversations/conversation-1/files/file-1/content",
) {
	return new Response(
		JSON.stringify({
			schemaVersion: 1,
			accessId: "access-1",
			file,
			path,
			expiresAt: "2099-01-01T00:00:00Z",
			grant,
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

it("exchanges V4 binding for a bounded input stream without exposing the grant", async () => {
	const fetcher = vi.fn(
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("runtime-exchange"))
				return response({
					schemaVersion: 1,
					fileId: "input-1",
					kind: "attachment",
					descriptor: {
						name: "input.png",
						mediaType: "image/png",
						sizeBytes: 3,
						sha256: "a".repeat(64),
					},
					status: "available",
					createdAt: "2026-01-01T00:00:00Z",
					expiresAt: "2099-01-01T00:00:00Z",
				});
			if (url.endsWith("/content"))
				return new Response(new Uint8Array([1, 2, 3]), {
					status: 200,
					headers: { "content-type": "image/png", "content-length": "3" },
				});
			throw new Error(
				`unexpected request ${url} ${JSON.stringify(init?.headers)}`,
			);
		},
	);
	const factory = createRuntimeFileBridgeFactoryV1({
		origin: "https://files.example.test",
		serviceToken: "s".repeat(32),
		fetch: fetcher,
	});
	const input = await factory(binding).readInput("input-1");
	expect(new Uint8Array(await new Response(input.body).arrayBuffer())).toEqual(
		new Uint8Array([1, 2, 3]),
	);
	const exchange = fetcher.mock.calls[0]?.[1];
	expect(JSON.stringify(exchange)).not.toContain("a.b.c");
	expect(fetcher).toHaveBeenCalledTimes(2);
});

it("rejects a file outside the execution binding before network access", async () => {
	const fetcher = vi.fn();
	const factory = createRuntimeFileBridgeFactoryV1({
		origin: "https://files.example.test",
		serviceToken: "s".repeat(32),
		fetch: fetcher,
	});
	await expect(factory(binding).readInput("other-file")).rejects.toThrow(
		"RUNTIME_FILE_INPUT_NOT_AUTHORIZED",
	);
	expect(fetcher).not.toHaveBeenCalled();
});
