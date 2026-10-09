import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { chromium } from "playwright-core";
import release from "./browser-release.json" with { type: "json" };

export const BROWSER_NATIVE_PROVENANCE = Object.freeze({
	playwrightVersion: release.playwrightVersion,
	chromiumVersion: release.chromiumVersion,
	chromiumRevision: release.chromiumRevision,
});

/** Verify immutable image supply before executing Chromium; no host fallback. */
export async function verifyChromiumInstallationV1() {
	try {
		if (process.platform !== "linux") throw new Error();
		const architecture = process.arch === "x64" ? "amd64" : process.arch;
		const artifact =
			release.artifacts[architecture as keyof typeof release.artifacts];
		if (!artifact) throw new Error();
		const require = createRequire(import.meta.url);
		const packagePath = require.resolve("playwright-core/package.json");
		const metadata = JSON.parse(await readFile(packagePath, "utf8"));
		const inventory = JSON.parse(
			await readFile(join(dirname(packagePath), "browsers.json"), "utf8"),
		);
		const chromium = inventory.browsers.find(
			(browser: { name: string }) => browser.name === "chromium",
		);
		if (
			metadata.version !== release.playwrightVersion ||
			chromium?.revision !== release.chromiumRevision ||
			chromium?.browserVersion !== release.chromiumVersion
		)
			throw new Error();
		const root = "/opt/agent-infra/browser";
		const executable = join(root, artifact.executable);
		for (const path of [
			"/opt",
			"/opt/agent-infra",
			root,
			dirname(executable),
			executable,
			join(root, "release.json"),
		]) {
			const stat = await lstat(path);
			if (
				(await realpath(path)) !== path ||
				stat.uid !== 0 ||
				stat.gid !== 0 ||
				(stat.mode & 0o022) !== 0 ||
				!(stat.isFile() || stat.isDirectory())
			)
				throw new Error();
		}
		const binary = await lstat(executable);
		if (
			!binary.isFile() ||
			(binary.mode & 0o222) !== 0 ||
			(binary.mode & 0o111) === 0 ||
			binary.nlink !== 1
		)
			throw new Error();
		const installedRelease = JSON.parse(
			await readFile(join(root, "release.json"), "utf8"),
		);
		if (!isDeepStrictEqual(installedRelease, release)) throw new Error();
		const hash = createHash("sha256");
		for await (const chunk of createReadStream(executable)) hash.update(chunk);
		if (hash.digest("hex") !== artifact.executableSha256) throw new Error();
		return {
			...BROWSER_NATIVE_PROVENANCE,
			platform: "linux" as const,
			architecture,
			executable,
			archiveSha256: artifact.archiveSha256,
			executableSha256: artifact.executableSha256,
		};
	} catch {
		throw new Error("RUNTIME_BROWSER_PROVENANCE_MISMATCH");
	}
}

/** Controlled image test, never a Browser Capability conformance projection. */
export async function probeChromiumLaunchV1() {
	if (process.getuid?.() === 0)
		throw new Error("RUNTIME_BROWSER_PROBE_NON_ROOT_REQUIRED");
	const installation = await verifyChromiumInstallationV1();
	const browser = await chromium.launch({
		executablePath: installation.executable,
		headless: true,
		timeout: 15_000,
	});
	try {
		if (browser.version() !== installation.chromiumVersion) throw new Error();
		const context = await browser.newContext();
		await context.route("**/*", (route) => route.abort());
		const page = await context.newPage();
		page.setDefaultTimeout(5_000);
		await page.setContent(
			"<title>Browser supply probe</title><button onclick=\"this.textContent='Clicked'\">Continue</button>",
		);
		if ((await page.title()) !== "Browser supply probe") throw new Error();
		await page.getByRole("button", { name: "Continue" }).click();
		if ((await page.getByRole("button").innerText()) !== "Clicked")
			throw new Error();
		return {
			schemaVersion: 1 as const,
			status: "passed" as const,
			scope: "controlled-image-supply-and-launch" as const,
			installation,
			checks: [
				"non-root",
				"pinned-binary",
				"browser-version",
				"page-observation",
				"page-interaction",
			],
		};
	} catch {
		throw new Error("RUNTIME_BROWSER_LAUNCH_PROBE_FAILED");
	} finally {
		await browser.close();
	}
}
