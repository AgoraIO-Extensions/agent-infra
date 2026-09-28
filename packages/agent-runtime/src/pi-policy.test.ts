import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import {
	createWriteToolDefinition,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { createPiWorkspaceTools } from "./pi-policy.js";
import type { NativeToolReceipt } from "./session-runtime-driver.js";

it.each(["read", "write", "edit"] as const)(
	"guards the real Pi %s operation after path transformations",
	async (name) => {
		const root = await realpath(
			await mkdtemp(join(tmpdir(), "pi-path-policy-")),
		);
		const workspace = join(root, "workspace");
		await mkdir(workspace);
		const foreign = join(root, "foreign.txt");
		const canary = "prefix SYNTHETIC_FOREIGN_CANARY";
		await writeFile(foreign, canary);
		const tool = createPiWorkspaceTools(
			workspace,
			async () => {},
			async () => {},
		)[name];
		const execute = (path: string) =>
			tool.execute(
				"synthetic-tool-call",
				{
					path,
					content: "replacement",
					edits: [{ oldText: "prefix", newText: "changed" }],
				},
				undefined,
				undefined,
				{ cwd: workspace } as ExtensionContext,
			);
		try {
			const owner = join(workspace, "owner.txt");
			await writeFile(owner, "prefix SYNTHETIC_OWNER_CANARY");
			await expect(execute("owner.txt")).resolves.toHaveProperty("content");
			await symlink(foreign, join(workspace, "escape.txt"));
			await symlink(foreign, join(workspace, "Capture d’écran.txt"));
			await symlink(foreign, join(workspace, "capture\u202fPM.txt"));
			await symlink(foreign, join(workspace, "e\u0301.txt"));
			const attempts = [
				foreign,
				`@${foreign}`,
				pathToFileURL(foreign).href,
				`~/${relative(homedir(), foreign)}`,
				"escape.txt",
			];
			if (name === "read")
				attempts.push("Capture d'écran.txt", "capture PM.txt", "é.txt");
			for (const path of attempts) {
				await expect(execute(path)).rejects.toThrow();
				expect(await readFile(foreign, "utf8")).toBe(canary);
			}
			// Owner access must still work after all rejections.
			await writeFile(owner, "prefix SYNTHETIC_OWNER_CANARY");
			await expect(execute("owner.txt")).resolves.toHaveProperty("content");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);

it("does not report starts for rejected paths, invalid edits or tools still in the native mutation queue", async () => {
	const workspace = await realpath(
		await mkdtemp(join(tmpdir(), "pi-tool-timing-")),
	);
	const phases: NativeToolReceipt[] = [];
	const waiting = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const tools = createPiWorkspaceTools(
		workspace,
		async () => {},
		async (receipt) => {
			phases.push(receipt);
		},
	);
	const queuedWrite = createWriteToolDefinition(workspace, {
		operations: {
			writeFile: async (path, content) => {
				await writeFile(path, content, "utf8");
			},
			mkdir: async (directory) => {
				waiting.resolve();
				await release.promise;
				await mkdir(directory, { recursive: true });
			},
		},
	});
	const context = { cwd: workspace } as ExtensionContext;
	let first: Promise<unknown> | undefined;
	let second: Promise<unknown> | undefined;
	try {
		await expect(
			tools.read.execute(
				"denied",
				{ path: "../foreign.txt" },
				undefined,
				undefined,
				context,
			),
		).rejects.toThrow();
		await expect(
			tools.edit.execute(
				"invalid",
				{ path: "owner.txt", edits: [] },
				undefined,
				undefined,
				context,
			),
		).rejects.toThrow();
		expect(
			phases.map((receipt) => [receipt.toolCallId, receipt.phase]),
		).toEqual([
			["denied", "failed"],
			["invalid", "failed"],
		]);
		for (const receipt of phases) expect(receipt.startedAt).toBeUndefined();
		first = queuedWrite.execute(
			"first",
			{ path: "owner.txt", content: "first" },
			undefined,
			undefined,
			context,
		);
		await waiting.promise;
		second = tools.edit.execute(
			"second",
			{ path: "owner.txt", edits: [{ oldText: "first", newText: "second" }] },
			undefined,
			undefined,
			context,
		);
		await new Promise<void>((done) => setImmediate(done));
		expect(phases.some((receipt) => receipt.toolCallId === "second")).toBe(
			false,
		);
		release.resolve();
		await Promise.all([first, second]);
		expect(await readFile(join(workspace, "owner.txt"), "utf8")).toBe("second");
		expect(
			phases
				.filter((receipt) => receipt.toolCallId === "second")
				.map((receipt) => receipt.phase),
		).toEqual(["started", "completed"]);
	} finally {
		release.resolve();
		await Promise.allSettled([first, second]);
		await rm(workspace, { recursive: true, force: true });
	}
});

it("waits for the durable started receipt before applying a filesystem mutation", async () => {
	const workspace = await realpath(
		await mkdtemp(join(tmpdir(), "pi-start-order-")),
	);
	const startedReceipt = Promise.withResolvers<void>();
	const phases: NativeToolReceipt[] = [];
	const tools = createPiWorkspaceTools(
		workspace,
		async () => {},
		async (receipt) => {
			phases.push(receipt);
			if (receipt.phase === "started") await startedReceipt.promise;
		},
	);
	const path = join(workspace, "ordered.txt");
	const execution = tools.write.execute(
		"ordered-call",
		{ path: "ordered.txt", content: "durable first" },
		undefined,
		undefined,
		{ cwd: workspace } as ExtensionContext,
	);
	try {
		await vi.waitFor(() =>
			expect(phases.map((receipt) => receipt.phase)).toEqual(["started"]),
		);
		await expect(readFile(path, "utf8")).rejects.toThrow();
		startedReceipt.resolve();
		await execution;
		expect(await readFile(path, "utf8")).toBe("durable first");
		expect(phases.map((receipt) => receipt.phase)).toEqual(["started", "completed"]);
	} finally {
		startedReceipt.resolve();
		await Promise.allSettled([execution]);
		await rm(workspace, { recursive: true, force: true });
	}
});

it.each(["read", "write", "edit"] as const)(
	"requires a fresh durable permit in the real %s execute boundary without a tool_call event",
	async (name) => {
		const workspace = await realpath(
			await mkdtemp(join(tmpdir(), "pi-permit-")),
		);
		const file = join(workspace, "owner.txt");
		let allowed = false;
		const permit = vi.fn(async () => {
			if (!allowed) throw new Error("SYNTHETIC_INTENT_UNAVAILABLE");
		});
		const tool = createPiWorkspaceTools(workspace, permit, async () => {})[
			name
		];
		const execute = () =>
			tool.execute(
				"same-native-call",
				{
					path: "owner.txt",
					content: "replacement",
					edits: [{ oldText: "prefix", newText: "changed" }],
				},
				undefined,
				undefined,
				{ cwd: workspace } as ExtensionContext,
			);
		try {
			await writeFile(file, "prefix SYNTHETIC_OWNER_CANARY");
			await expect(execute()).rejects.toThrow();
			expect(await readFile(file, "utf8")).toBe(
				"prefix SYNTHETIC_OWNER_CANARY",
			);
			allowed = true;
			await expect(execute()).resolves.toHaveProperty("content");
			await writeFile(file, "prefix SYNTHETIC_OWNER_CANARY");
			allowed = false;
			await expect(execute()).rejects.toThrow();
			expect(await readFile(file, "utf8")).toBe(
				"prefix SYNTHETIC_OWNER_CANARY",
			);
			expect(permit.mock.calls).toEqual(
				Array.from({ length: 3 }, () => ["same-native-call", name]),
			);
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	},
);
