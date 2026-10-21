import { expect, it, vi } from "vitest";
import {
	createFileLimitDeclarationReaderV1,
	FileLimitDeclarationErrorV1,
	type FileLimitDeclarationRecordV1,
	type FileLimitDeclarationStoreV1,
	type FileLimitDeclarationSubjectV1,
	fileLimitDeclarationToLimitsV1,
	normalizeFileLimitDeclarationV1,
	readFileLimitDeclarationV1,
	writeFileLimitDeclarationV1,
} from "./file-limit-declarations.js";
import { resolveFileLimitsV1 } from "./file-limits.js";

const now = new Date("2026-10-21T00:00:00Z");

function record(
	revision: number,
	overrides: Partial<FileLimitDeclarationRecordV1> = {},
): FileLimitDeclarationRecordV1 {
	return {
		scope: "agent",
		agentId: "agent",
		channelId: null,
		revision,
		expiresAt: "2026-11-21T00:00:00.000Z",
		mediaTypes: ["text/plain"],
		maxBytes: 1024,
		updatedAt: "2026-10-21T00:00:00.000Z",
		updatedBy: "owner",
		...overrides,
	};
}

function store(records: {
	deployment?: FileLimitDeclarationRecordV1 | null;
	agent?: FileLimitDeclarationRecordV1 | null;
	channel?: FileLimitDeclarationRecordV1 | null;
	configurationRevision?: number | null;
}) {
	const read = vi.fn(async (subject: FileLimitDeclarationSubjectV1) =>
		subject.scope === "deployment"
			? (records.deployment ?? null)
			: subject.scope === "agent"
				? (records.agent ?? null)
				: (records.channel ?? null),
	);
	const write = vi.fn(async () => record(1));
	const readAgentConfigurationRevision = vi.fn(
		async () => records.configurationRevision ?? 7,
	);
	return {
		read,
		write,
		readAgentConfigurationRevision,
	} satisfies FileLimitDeclarationStoreV1;
}

it("canonicalizes a declaration and rejects invalid ones", () => {
	expect(
		normalizeFileLimitDeclarationV1(
			{
				expiresAt: "2026-11-01T08:00:00+08:00",
				mediaTypes: ["text/plain", "text/plain", "image/png"],
				maxBytes: 2048,
			},
			now,
		),
	).toEqual({
		expiresAt: "2026-11-01T00:00:00.000Z",
		mediaTypes: ["image/png", "text/plain"],
		maxBytes: 2048,
	});
	for (const invalid of [
		{
			expiresAt: "2026-10-20T23:59:59Z",
			mediaTypes: ["text/plain"],
			maxBytes: 1,
		},
		{ expiresAt: "2026-11-01T00:00:00Z", mediaTypes: [], maxBytes: 1 },
		{ expiresAt: "2026-11-01T00:00:00Z", mediaTypes: ["PLAIN"], maxBytes: 1 },
		{
			expiresAt: "2026-11-01T00:00:00Z",
			mediaTypes: ["text/plain"],
			maxBytes: 0,
		},
		{
			expiresAt: "not-a-time",
			mediaTypes: ["text/plain"],
			maxBytes: 1,
		},
	])
		expect(() => normalizeFileLimitDeclarationV1(invalid, now)).toThrow(
			FileLimitDeclarationErrorV1,
		);
});

it("only writes after the current authorization allows the subject", async () => {
	const declarations = store({});
	await expect(
		writeFileLimitDeclarationV1({
			store: declarations,
			subject: { scope: "agent", agentId: "agent" },
			declaration: {
				expiresAt: "2026-11-01T00:00:00Z",
				mediaTypes: ["text/plain"],
				maxBytes: 1024,
			},
			expectedRevision: null,
			idempotencyKey: "Command.Aa-01",
			actorId: "owner",
			now,
			authorize: async () => false,
		}),
	).rejects.toMatchObject({ code: "forbidden" });
	expect(declarations.write).not.toHaveBeenCalled();

	await writeFileLimitDeclarationV1({
		store: declarations,
		subject: { scope: "agent", agentId: "agent" },
		declaration: {
			expiresAt: "2026-11-01T00:00:00Z",
			mediaTypes: ["text/plain"],
			maxBytes: 1024,
		},
		expectedRevision: 3,
		idempotencyKey: "Command.Aa-01",
		actorId: "owner",
		now,
		authorize: async () => true,
	});
	expect(declarations.write).toHaveBeenCalledOnce();
	expect(declarations.write).toHaveBeenCalledWith(
		expect.objectContaining({
			expectedRevision: 3,
			idempotencyKey: "Command.Aa-01",
			requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
			declaration: {
				expiresAt: "2026-11-01T00:00:00.000Z",
				mediaTypes: ["text/plain"],
				maxBytes: 1024,
			},
		}),
	);
});

it("rejects malformed subjects and revisions before touching the store", async () => {
	const declarations = store({});
	await expect(
		writeFileLimitDeclarationV1({
			store: declarations,
			subject: { scope: "channel", agentId: "agent", channelId: "" },
			declaration: {
				expiresAt: "2026-11-01T00:00:00Z",
				mediaTypes: ["text/plain"],
				maxBytes: 1024,
			},
			expectedRevision: null,
			idempotencyKey: "Command.Aa-01",
			actorId: "owner",
			now,
			authorize: async () => true,
		}),
	).rejects.toMatchObject({ code: "invalid_input" });
	await expect(
		writeFileLimitDeclarationV1({
			store: declarations,
			subject: { scope: "agent", agentId: "agent" },
			declaration: {
				expiresAt: "2026-11-01T00:00:00Z",
				mediaTypes: ["text/plain"],
				maxBytes: 1024,
			},
			expectedRevision: 0,
			idempotencyKey: "Command.Aa-01",
			actorId: "owner",
			now,
			authorize: async () => true,
		}),
	).rejects.toMatchObject({ code: "invalid_input" });
	expect(declarations.write).not.toHaveBeenCalled();
});

it("reads only after authorization and returns the persisted declaration", async () => {
	const declarations = store({ agent: record(2) });
	await expect(
		readFileLimitDeclarationV1({
			store: declarations,
			subject: { scope: "agent", agentId: "agent" },
			authorize: async () => false,
		}),
	).rejects.toMatchObject({ code: "forbidden" });
	await expect(
		readFileLimitDeclarationV1({
			store: declarations,
			subject: { scope: "agent", agentId: "agent" },
			authorize: async () => true,
		}),
	).resolves.toEqual(record(2));
});

it("reads the three declaration scopes and reports the persisted configuration revision", async () => {
	const readLimits = createFileLimitDeclarationReaderV1({
		store: store({
			deployment: record(3, {
				scope: "deployment",
				agentId: "",
				maxBytes: 4096,
			}),
			agent: record(4),
			channel: record(5, { scope: "channel", channelId: "web" }),
			configurationRevision: 9,
		}),
	});
	await expect(
		readLimits({
			agentId: "agent",
			channelId: "web",
			configurationRevision: 7,
			kind: "attachment",
		}),
	).resolves.toEqual({
		// The caller's 7 is stale; include the persisted 9 so the assembly rejects it.
		configurationRevision: 9,
		declarations: {
			deployment: fileLimitDeclarationToLimitsV1(
				record(3, { scope: "deployment", agentId: "", maxBytes: 4096 }),
			),
			agent: fileLimitDeclarationToLimitsV1(record(4)),
			channel: fileLimitDeclarationToLimitsV1(
				record(5, { scope: "channel", channelId: "web" }),
			),
		},
	});
});

it("keeps missing declarations null and lets resolution fail closed", async () => {
	const readLimits = createFileLimitDeclarationReaderV1({
		store: store({ configurationRevision: 1 }),
	});
	const declared = await readLimits({
		agentId: "agent",
		channelId: "web",
		configurationRevision: 1,
		kind: "result",
	});
	expect(declared.declarations).toEqual({
		deployment: null,
		agent: null,
		channel: null,
	});
	expect(resolveFileLimitsV1(declared.declarations, now)).toBeNull();
});

it("resolves the intersection of persisted declarations and rejects expiry", async () => {
	const declared = {
		deployment: fileLimitDeclarationToLimitsV1(
			record(1, {
				scope: "deployment",
				agentId: "",
				maxBytes: 4096,
				mediaTypes: ["text/plain", "image/png"],
			}),
		),
		agent: fileLimitDeclarationToLimitsV1(
			record(2, { maxBytes: 2048, mediaTypes: ["text/plain"] }),
		),
		channel: fileLimitDeclarationToLimitsV1(
			record(3, { scope: "channel", channelId: "web", maxBytes: 8192 }),
		),
	};
	expect(resolveFileLimitsV1(declared, now)).toMatchObject({
		maxBytes: 2048,
		mediaTypes: ["text/plain"],
		expiresAt: "2026-11-21T00:00:00.000Z",
	});
	expect(
		resolveFileLimitsV1(declared, new Date("2026-11-22T00:00:00Z")),
	).toBeNull();
	expect(
		resolveFileLimitsV1(
			{ ...declared, agent: { ...declared.agent, revision: "" } },
			now,
		),
	).toBeNull();
});
