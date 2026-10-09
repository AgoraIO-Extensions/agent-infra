import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyChromiumInstallationV1 } from "./browser-installation.js";

const filesystem = vi.hoisted(() => ({ fault: "missing" }));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		lstat: async (path: string) => {
			if (path !== "/opt" && !path.startsWith("/opt/agent-infra"))
				return actual.lstat(path);
			if (filesystem.fault === "missing") throw new Error("ENOENT");
			const file = path.endsWith("/chrome") || path.endsWith("/release.json");
			return {
				uid: 0,
				gid: 0,
				nlink: 1,
				mode: filesystem.fault === "writable" ? 0o777 : 0o555,
				isFile: () => file,
				isDirectory: () => !file,
			};
		},
		realpath: async (path: string) =>
			path.startsWith("/opt")
				? filesystem.fault === "symlink"
					? "/tmp/replaced"
					: path
				: actual.realpath(path),
		readFile: async (path: string, encoding: string) => {
			if (path === "/opt/agent-infra/browser/release.json")
				return actual.readFile(
					new URL("./browser-release.json", import.meta.url),
					"utf8",
				);
			if (
				filesystem.fault === "wrong-version" &&
				path.endsWith("playwright-core/package.json")
			)
				return JSON.stringify({ version: "1.62.0" });
			return actual.readFile(path, encoding as "utf8");
		},
	};
});
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		createReadStream: (path: string) =>
			path.startsWith("/opt/agent-infra/browser/")
				? Readable.from([Buffer.from("tampered browser")])
				: actual.createReadStream(path),
	};
});

describe("Pinned Chromium installation", () => {
	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	beforeEach(() => {
		Object.defineProperty(process, "platform", { value: "linux" });
	});
	afterEach(() => {
		if (platform) Object.defineProperty(process, "platform", platform);
		filesystem.fault = "missing";
	});
	it("rejects absent or unsupported supply without a host browser fallback", async () => {
		await expect(verifyChromiumInstallationV1()).rejects.toThrow(
			"RUNTIME_BROWSER_PROVENANCE_MISMATCH",
		);
	});

	it.each(["writable", "symlink", "tampered", "wrong-version"])(
		"rejects %s supply before browser execution",
		async (fault) => {
			filesystem.fault = fault;
			await expect(verifyChromiumInstallationV1()).rejects.toThrow(
				"RUNTIME_BROWSER_PROVENANCE_MISMATCH",
			);
		},
	);
});
