import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	options: undefined as Record<string, unknown> | undefined,
}));

vi.mock("./wecom-worker.js", () => ({
	createPlatformWecomWorkerV1: (options: Record<string, unknown>) => {
		mocks.options = options;
		return {
			reconcile: async () => {},
			dispatch: async () => false,
			close: async () => {},
			channelAuthorizationCurrent: async () => false,
		};
	},
}));

import { createWecomDeploymentCoordinatorV1 } from "./wecom-deployment.js";

function configuration(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		identity: {
			resolveSender: async () => null,
			activeUsers: async () => [],
		},
		observe: () => {},
		sender: { send: async () => "failed" },
		connections: {
			bindings: async () => [],
			protectReply: async () => "route",
			revealReply: async () => null,
		},
		setup: {
			decryptor: { decrypt: async () => null },
			directory: { resolveUser: async () => null },
		},
		...overrides,
	};
}

afterEach(() => {
	mocks.options = undefined;
	vi.clearAllMocks();
});

it("passes a valid deployment media resolver through unchanged", async () => {
	const mediaResolver = { resolve: async () => ["file-1"] as const };
	const coordinator = createWecomDeploymentCoordinatorV1({
		databaseUrl: "postgres://fixture",
		configuration: configuration({ mediaResolver }),
	});
	const worker = coordinator.start(new AbortController().signal);
	try {
		expect(mocks.options?.mediaResolver).toBe(mediaResolver);
	} finally {
		await worker.close();
	}
});

it.each([{ mediaResolver: {} }, { mediaResolver: { resolve: "invalid" } }])(
	"rejects malformed deployment media resolver: %j",
	(overrides) => {
		const coordinator = createWecomDeploymentCoordinatorV1({
			databaseUrl: "postgres://fixture",
			configuration: configuration(overrides),
		});
		expect(() => coordinator.start(new AbortController().signal)).toThrow(
			"WeCom Worker deployment dependencies are unavailable",
		);
	},
);
