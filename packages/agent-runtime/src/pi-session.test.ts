import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { openPiSession } from "./pi-session.js";

const { openRpc } = vi.hoisted(() => ({ openRpc: vi.fn() }));
vi.mock("./pi-rpc.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./pi-rpc.js")>()),
	openPiRpc: openRpc,
}));

async function fixture() {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "pi-session-")),
	);
	let exited = false;
	const request = vi.fn(async (type: string) => {
		if (exited) throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
		if (type === "get_state")
			return {
				sessionId: "synthetic-session",
				sessionFile: join(directory, "native", "session.jsonl"),
			};
		if (type === "get_messages") return { messages: [] };
	});
	openRpc.mockImplementationOnce(
		async (...args: Parameters<typeof import("./pi-rpc.js").openPiRpc>) => {
			args[3]({
				type: "extension_ui_request",
				method: "setTitle",
				title: "agent-infra-policy-v1",
			});
			return {
				request,
				reusable: () => !exited,
				async close() {
					exited = true;
					args[4]();
				},
			};
		},
	);
	const session = await openPiSession({
		directory,
		cwd: directory,
		selection: {
			schemaVersion: 1,
			modelOptionId: "primary",
			reasoningLevel: "high",
		},
		admit: async () => {},
		update: async () => {},
		launch: { command: "synthetic", args: [], env: {} },
	});
	await session.checkpoint();
	return { directory, request, session };
}

it("rejects a concurrent prompt before the first binding persistence finishes", async () => {
	const f = await fixture();
	const first = f.session.prompt("first input");
	const second = f.session.prompt("second input");
	const rejected = vi.fn();
	void first.catch(() => {});
	void second.catch(rejected);
	try {
		await Promise.resolve();
		expect(rejected).toHaveBeenCalledExactlyOnceWith(
			new Error("RUNTIME_ACCEPTANCE_UNKNOWN"),
		);
	} finally {
		await f.session.close();
		await Promise.allSettled([first, second]);
		await rm(f.directory, { recursive: true, force: true });
	}
});

it("releases a prompt reservation when binding persistence fails", async () => {
	const f = await fixture();
	const binding = join(f.directory, "native", "prompt-binding.sha256");
	await mkdir(binding);
	let retry: ReturnType<typeof f.session.prompt> | undefined;
	try {
		await expect(f.session.prompt("failed input")).rejects.toThrow();
		expect(f.request.mock.calls.some(([type]) => type === "prompt")).toBe(
			false,
		);
		await rm(binding, { recursive: true });
		retry = f.session.prompt("retry input");
		void retry.catch(() => {});
		await vi.waitFor(() =>
			expect(f.request).toHaveBeenCalledWith("prompt", {
				message: "retry input",
			}),
		);
	} finally {
		await f.session.close();
		await retry?.catch(() => {});
		await rm(f.directory, { recursive: true, force: true });
	}
});

it("does not submit an RPC after exit during binding persistence", async () => {
	const f = await fixture();
	const pending = f.session.prompt("synthetic input");
	const rejected = expect(pending).rejects.toThrow(
		"RUNTIME_ACCEPTANCE_UNKNOWN",
	);
	try {
		await f.session.close();
		await rejected;
		expect(f.request.mock.calls.some(([type]) => type === "prompt")).toBe(
			false,
		);
	} finally {
		await rm(f.directory, { recursive: true, force: true });
	}
});
