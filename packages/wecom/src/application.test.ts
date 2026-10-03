import { expect, it, vi } from "vitest";
import { createWecomApplicationAccessV1 } from "./application.js";

it.each(["success", "wrong-application", "wrong-secret", "transient"])(
	"validates app identity without sending messages: %s",
	async (mode) => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
			const url = new URL(String(input));
			expect(url.origin).toBe("https://qyapi.weixin.qq.com");
			expect(["/cgi-bin/gettoken", "/cgi-bin/agent/get"]).toContain(
				url.pathname,
			);
			expect(init?.redirect).toBe("error");
			if (mode === "transient")
				return new Response("Unavailable", { status: 503 });
			if (url.pathname.endsWith("gettoken"))
				return Response.json(
					mode === "wrong-secret"
						? { errcode: 40001 }
						: { errcode: 0, access_token: "fixture-access" },
				);
			return Response.json({
				errcode: 0,
				agentid: mode === "wrong-application" ? 8 : 7,
			});
		});
		const promise = createWecomApplicationAccessV1({ fetch }).token({
			corporationId: "corp",
			applicationId: "7",
			secret: "fixture-secret",
		});
		if (mode === "transient")
			await expect(promise).rejects.toThrow("unavailable");
		else
			await expect(promise).resolves.toBe(
				mode === "success" ? "fixture-access" : null,
			);
		expect(fetch).toHaveBeenCalledTimes(
			mode === "transient" || mode === "wrong-secret" ? 1 : 2,
		);
	},
);

it("rejects oversized provider responses without exposing a token", async () => {
	const fetch = vi.fn<typeof globalThis.fetch>(async () =>
		Response.json({ errcode: 0, access_token: "sensitive-token".repeat(5000) }),
	);
	await expect(
		createWecomApplicationAccessV1({ fetch }).token({
			corporationId: "corp",
			applicationId: "7",
			secret: "fixture-secret",
		}),
	).rejects.toThrow("WeCom application unavailable");
});

it("redacts a provider transport error that contains the credential URL", async () => {
	const access = createWecomApplicationAccessV1({
		fetch: async (input) => {
			throw new Error(`Request failed: ${String(input)}`);
		},
	});
	await expect(
		access.token({
			corporationId: "corp",
			applicationId: "7",
			secret: "fixture-secret",
		}),
	).rejects.toThrow("WeCom application unavailable");
});
