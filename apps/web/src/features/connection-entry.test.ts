import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { connectionEntryUrl } from "./connection-entry.js";

const origin = "https://connection.example.test";
const capability = (publicOrigin: unknown, webPath: unknown) => ({
	schemaVersion: 1,
	status: "available",
	publicOrigin,
	webPath,
	configFingerprint: "f".repeat(64),
});

describe("connectionEntryUrl", () => {
	it("concatenates a valid origin and path without changing the host", () => {
		expect(connectionEntryUrl(capability(origin, "/mcp"))).toBe(
			"https://connection.example.test/mcp",
		);
		expect(connectionEntryUrl(capability(origin, "/v1/mcp-entry"))).toBe(
			"https://connection.example.test/v1/mcp-entry",
		);
	});

	// NI-01 / NI-68：任何一组都不得产生链接，也不能改道到其他主机。
	it.each([
		["protocol-relative path", origin, "//evil.example/mcp"],
		["backslash host path", origin, "/\\evil.example/mcp"],
		["UNC style path", origin, "\\\\evil.example\\mcp"],
		["origin with trailing newline", `${origin}\n`, "/mcp"],
		["origin with trailing slash", `${origin}/`, "/mcp"],
		["http origin", "http://connection.example.test", "/mcp"],
		[
			"origin with credentials",
			"https://user:pass@connection.example.test",
			"/mcp",
		],
		["origin with a path", `${origin}/base`, "/mcp"],
		["path with newline", origin, "/mcp\n"],
		["path with tab", origin, "/m\tcp"],
		["path without leading slash", origin, ".evil.example/mcp"],
		["path starting with at sign", origin, "@evil.example/mcp"],
		["path with query", origin, "/mcp?next=https://evil.example"],
		["path with fragment", origin, "/mcp#evil"],
		["encoded dot", origin, "/%2e%2e/mcp"],
		["encoded slash", origin, "/%2Fevil.example/mcp"],
		["encoded backslash", origin, "/%5cevil.example/mcp"],
		["dot segment", origin, "/./mcp"],
		["parent segment", origin, "/a/../mcp"],
		["empty path", origin, ""],
		["non-string origin", 42, "/mcp"],
		["non-string path", origin, ["/mcp"]],
	])("rejects %s", (_name, publicOrigin, webPath) => {
		expect(
			connectionEntryUrl(capability(publicOrigin, webPath)),
		).toBeUndefined();
	});

	it("rejects unavailable, missing and malformed capabilities", () => {
		for (const value of [
			undefined,
			null,
			"https://connection.example.test/mcp",
			{ status: "unavailable", reason: "missing", schemaVersion: 1 },
			{ ...capability(origin, "/mcp"), status: "pending" },
			{ status: "available" },
		])
			expect(connectionEntryUrl(value)).toBeUndefined();
	});

	it("keeps every produced link on the published origin", () => {
		for (const path of ["/mcp", "/a/b", "/a-b_c~d", "/中文"])
			expect(
				new URL(connectionEntryUrl(capability(origin, path)) ?? "").origin,
			).toBe(origin);
	});

	it("is the only Connection URL builder and never resolves webPath against publicOrigin", () => {
		for (const file of [
			"./application-shell.tsx",
			"./agent-discovery/agent-detail-screen.tsx",
			"./agent-discovery/connection-notice.tsx",
			"../routes/agents/$agentId/index.tsx",
		]) {
			const source = readFileSync(new URL(file, import.meta.url), "utf8");
			expect(source, file).not.toMatch(/new URL\(\s*[^,)]*webPath/);
			expect(source, file).not.toMatch(/publicOrigin\s*\+/);
		}
	});
});
