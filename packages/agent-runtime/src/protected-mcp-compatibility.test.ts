import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import runtimePackage from "../package.json" with { type: "json" };
import {
	OPENCODE_NATIVE_PROVENANCE,
	supportsProtectedOpenCodeMcpTransport,
} from "./opencode-installation.js";
import {
	PI_NATIVE_PROVENANCE,
	supportsProtectedPiMcpTransport,
} from "./pi-installation.js";

describe("protected Connection MCP compatibility facts", () => {
	it("stays tied to the pinned native metadata and package versions", async () => {
		expect(runtimePackage.dependencies["@earendil-works/pi-coding-agent"]).toBe(
			PI_NATIVE_PROVENANCE.nativeVersion,
		);
		expect(runtimePackage.dependencies["@agentclientprotocol/sdk"]).toBe(
			OPENCODE_NATIVE_PROVENANCE.sdkVersion,
		);
		expect(PI_NATIVE_PROVENANCE).toMatchObject({
			nativeVersion: "0.99.0",
			upstreamCommit: "4b060d3a98618019adb9985d517516c8e99a2bbe",
		});
		expect(supportsProtectedPiMcpTransport()).toBe(true);
		expect(OPENCODE_NATIVE_PROVENANCE).toMatchObject({
			nativeVersion: "1.19.0",
			sdkVersion: "1.4.0",
			upstreamCommit: "733b2c627e5aec39cb33cc22373bdce33053ef2c",
		});

		const readme = await readFile(
			new URL("../README.md", import.meta.url),
			"utf8",
		);
		expect(readme).toContain(PI_NATIVE_PROVENANCE.upstreamCommit);
		expect(readme).toContain(OPENCODE_NATIVE_PROVENANCE.upstreamCommit);
		expect(supportsProtectedOpenCodeMcpTransport()).toBe(true);
	});
});
