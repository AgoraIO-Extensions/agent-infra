import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import runtimePackage from "../package.json" with { type: "json" };
import {
	OPENCODE_NATIVE_PROVENANCE,
	supportsProtectedOpenCodeMcpTransport,
} from "./opencode-installation.js";
import { PI_NATIVE_PROVENANCE } from "./pi-installation.js";

describe("protected Connection MCP compatibility facts", () => {
	it("stays tied to the pinned native metadata and package versions", async () => {
		expect(runtimePackage.dependencies["@earendil-works/pi-coding-agent"]).toBe(
			PI_NATIVE_PROVENANCE.nativeVersion,
		);
		expect(runtimePackage.dependencies["@agentclientprotocol/sdk"]).toBe(
			OPENCODE_NATIVE_PROVENANCE.sdkVersion,
		);
		expect(PI_NATIVE_PROVENANCE).toMatchObject({
			nativeVersion: "0.86.0",
			upstreamCommit: "ecac0a9c4edad3dac5d9f8b40e0c7db7a56471fc",
		});
		expect(OPENCODE_NATIVE_PROVENANCE).toMatchObject({
			nativeVersion: "1.18.30",
			sdkVersion: "1.4.0",
			upstreamCommit: "3104c1428ec91f809e5ab86631300de41eb6952e",
		});

		const readme = await readFile(
			new URL("../README.md", import.meta.url),
			"utf8",
		);
		expect(readme).toContain(PI_NATIVE_PROVENANCE.upstreamCommit);
		expect(readme).toContain(OPENCODE_NATIVE_PROVENANCE.upstreamCommit);
		expect(supportsProtectedOpenCodeMcpTransport()).toBe(false);
	});
});
