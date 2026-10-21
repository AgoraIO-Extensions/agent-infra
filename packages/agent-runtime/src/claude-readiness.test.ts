import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { claudeNativeFixture } from "./claude-native.test-support.js";
import * as nativeQuery from "./claude-query.js";
import { ClaudeRuntimeDriver } from "./claude-runtime-driver.js";

it("probes the keyless Claude native handshake without a model call or business Session", async () => {
	const f = await claudeNativeFixture();
	await f.driver.close();
	const authorizeModelAction = vi.fn(async () => undefined);
	const driver = await ClaudeRuntimeDriver.open({
		...f.options,
		modelOptions: f.options.modelOptions.map(
			({ credential: _, ...option }) => option,
		),
		authorizeModelAction,
	});
	try {
		const before = await readFile(join(f.path, "index.json"), "utf8");
		await expect(
			driver.probeReadiness(new AbortController().signal),
		).resolves.toMatchObject({
			modelSelection: true,
			attachments: true,
			resultFiles: true,
		});
		expect(f.calls).toHaveLength(0);
		expect(authorizeModelAction).not.toHaveBeenCalled();
		expect(await readFile(join(f.path, "index.json"), "utf8")).toBe(before);
	} finally {
		await driver.close();
		await f.close();
	}
}, 20_000);

it.each(["cancel", "close"])(
	"retires a Claude readiness child and temporary directory on %s",
	async (action) => {
		const f = await claudeNativeFixture();
		const original = nativeQuery.claudeQuery;
		const started = Promise.withResolvers<void>();
		let exited: Promise<void> | undefined;
		let temporaryRoot: string | undefined;
		const spy = vi
			.spyOn(nativeQuery, "claudeQuery")
			.mockImplementation((options, message) => {
				expect(message).toBeUndefined();
				expect(options.persistSession).toBe(false);
				const native = original(options, message);
				exited = native.exited;
				temporaryRoot = dirname(options.cwd ?? "");
				const initialize = native.query.initializationResult.bind(native.query);
				native.query.initializationResult = async () => {
					await initialize();
					started.resolve();
					return new Promise(() => {});
				};
				return native;
			});
		const controller = new AbortController();
		try {
			const pending = f.driver.probeReadiness(controller.signal);
			const rejected = expect(pending).rejects.toThrow();
			await started.promise;
			const closing = action === "close" ? f.driver.close() : undefined;
			if (action === "cancel") controller.abort();
			await rejected;
			await closing;
			await exited;
			if (!temporaryRoot) throw new Error("probe did not start");
			await expect(access(temporaryRoot)).rejects.toMatchObject({
				code: "ENOENT",
			});
			expect(f.calls).toHaveLength(0);
		} finally {
			controller.abort();
			spy.mockRestore();
			await f.close();
		}
	},
	20_000,
);
