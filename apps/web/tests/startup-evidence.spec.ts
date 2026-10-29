import { expect, test } from "@playwright/test";
import { recordStartupEvidence } from "./page-health";

test("startup evidence bounds events and omits bodies, headers, origins and raw errors", async ({
	page,
}, info) => {
	const secret = "SYNTHETIC_PRIVATE_STARTUP_SENTINEL";
	await page.route("https://fixture.invalid/**", async (route) => {
		if (new URL(route.request().url()).pathname === "/api/fail")
			return route.abort("failed");
		return route.fulfill({
			contentType:
				route.request().resourceType() === "document"
					? "text/html"
					: "application/json",
			headers: { "x-private": secret },
			body:
				route.request().resourceType() === "document"
					? `<div id="app">${secret}</div>`
					: JSON.stringify({ secret }),
		});
	});
	const startup = recordStartupEvidence(page);
	try {
		await page.goto(`https://fixture.invalid/start?secret=${secret}#${secret}`);
		await page.evaluate(async (value) => {
			for (const path of [
				"first",
				"second",
				"fail",
				...Array.from({ length: 22 }, (_, index) => `bounded-${index}`),
			]) {
				await fetch(`/api/${path}?secret=${value}`, {
					method: "POST",
					headers: { Authorization: `Bearer ${value}` },
					body: value,
				})
					.then((response) => response.text())
					.catch(() => undefined);
			}
			await new Promise<void>((resolve) => {
				const script = document.createElement("script");
				script.src = `data:application/javascript,${encodeURIComponent(`throw new Error(${JSON.stringify(value)})`)}`;
				script.onload = () => resolve();
				script.onerror = () => resolve();
				document.body.append(script);
			});
			for (let index = 0; index < 120; index++) console.error(value);
		}, secret);
		let captured = "";
		await startup.attach({
			...info,
			attach: async (_name, attachment) => {
				if (!attachment?.body) throw new Error("Startup attachment is missing");
				captured = String(attachment.body);
			},
		});
		const evidence = JSON.parse(captured);
		expect(captured).not.toContain(secret);
		expect(captured).not.toContain("fixture.invalid");
		expect(evidence.path).toBe("/start");
		expect(evidence.api).toEqual({ issued: 25, finished: 24, failed: 1 });
		expect(evidence.apiResponses).toHaveLength(20);
		expect(evidence.apiResponses.at(-1)).toEqual({
			navigation: 1,
			path: "/api/bounded-21",
			status: 200,
		});
		expect(evidence.document.appChildren).toBe(0);
		expect(evidence.events).toHaveLength(100);
		expect(evidence.dropped).toBeGreaterThan(0);
		expect(evidence.events).toContainEqual(
			expect.objectContaining({
				kind: "response",
				path: "/api/first",
				status: 200,
			}),
		);
		expect(evidence.events).toContainEqual(
			expect.objectContaining({ kind: "page-error", category: "runtime" }),
		);
	} finally {
		startup.dispose();
	}
});
