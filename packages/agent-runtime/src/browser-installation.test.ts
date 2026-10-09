import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyChromiumInstallationV1 } from "./browser-installation.js";

const filesystem = vi.hoisted(() => ({ fault: "valid" }));
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
				mode:
					filesystem.fault === "writable"
						? 0o777
						: filesystem.fault === "root-writable" && file
							? 0o755
							: 0o555,
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
				? Readable.from([Buffer.from("virtual image browser")])
				: actual.createReadStream(path),
	};
});
// Filesystem/crypto are virtual image boundaries here. The Linux image probe
// independently verifies the real binary with the unmodified SHA-256 algorithm.
vi.mock("node:crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:crypto")>();
	return {
		...actual,
		createHash: (algorithm: string) => {
			const hash = actual.createHash(algorithm);
			vi.spyOn(hash, "digest").mockImplementation(() =>
				filesystem.fault === "tampered"
					? "0".repeat(64)
					: process.arch === "x64"
						? "8c599d43aec53f2460a31ae2f4af6bd863f8258b34ff519564bc5d4726bfaa1e"
						: ("839efe5fd8b6a773dd81b2e10afdc15f3c0a17316fb82b5908c0533306c4ed9e" as never),
			);
			return hash;
		},
	};
});

describe("Pinned Chromium installation", () => {
	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	beforeEach(() => {
		Object.defineProperty(process, "platform", { value: "linux" });
		filesystem.fault = "valid";
	});
	afterEach(() => {
		if (platform) Object.defineProperty(process, "platform", platform);
		filesystem.fault = "missing";
	});
	it("rejects absent or unsupported supply without a host browser fallback", async () => {
		filesystem.fault = "missing";
		await expect(verifyChromiumInstallationV1()).rejects.toThrow(
			"RUNTIME_BROWSER_PROVENANCE_MISMATCH",
		);
	});
	it("returns only the pinned version and fixed image path for valid supply", async () => {
		await expect(verifyChromiumInstallationV1()).resolves.toMatchObject({
			chromiumVersion: "153.0.8010.12",
			playwrightVersion: "1.63.0",
			platform: "linux",
		});
	});

	it.each([
		"writable",
		"root-writable",
		"symlink",
		"tampered",
		"wrong-version",
	])("rejects %s supply before browser execution", async (fault) => {
		filesystem.fault = fault;
		await expect(verifyChromiumInstallationV1()).rejects.toThrow(
			"RUNTIME_BROWSER_PROVENANCE_MISMATCH",
		);
	});
});
