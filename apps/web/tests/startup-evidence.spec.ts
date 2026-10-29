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
			await new Promise<void>((resolve) => {
				const frame = document.createElement("iframe");
				frame.src = `/frame?secret=${value}`;
				frame.onload = () => resolve();
				document.body.append(frame);
			});
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
		expect(evidence.navigation).toBe(1);
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
		expect(evidence.criticalEvents).toHaveLength(20);
		expect(evidence.criticalDropped).toBeGreaterThan(0);
		await page.goto(`https://fixture.invalid/next?secret=${secret}`);
		await page.evaluate(async (value) => {
			Object.defineProperty(
				document.getElementById("app"),
				"__reactContainer$controlled",
				{ value },
			);
			Object.assign(window, {
				__TSR_ROUTER__: {
					state: {
						status: "pending",
						isLoading: true,
						isTransitioning: false,
						matches: [{ status: "success", private: value }, { status: value }],
					},
					stores: {
						pendingMatches: {
							get: () => [{ status: "pending", private: value }],
						},
					},
					private: value,
				},
			});
			await fetch(`/api/current?secret=${value}`).then((response) =>
				response.text(),
			);
			await new Promise<void>((resolve) => {
				const script = document.createElement("script");
				script.src = `data:application/javascript,${encodeURIComponent(`throw new Error(${JSON.stringify(value)})`)}`;
				script.onload = () => resolve();
				script.onerror = () => resolve();
				document.body.append(script);
			});
		}, secret);
		await startup.attach({
			...info,
			attach: async (_name, attachment) => {
				captured = String(attachment?.body);
			},
		});
		const current = JSON.parse(captured);
		expect(captured).not.toContain(secret);
		expect(current.navigation).toBe(2);
		expect(current.latestNavigation.api).toEqual({
			issued: 1,
			finished: 1,
			failed: 0,
		});
		expect(current.criticalEvents.at(-1)).toMatchObject({
			navigation: 2,
			kind: "page-error",
			category: "runtime",
		});
		expect(current.document.reactRootCreated).toBe(true);
		expect(current.document.router).toEqual({
			present: true,
			status: "pending",
			isLoading: true,
			isTransitioning: false,
			matches: { count: 2, statuses: ["success", "other"] },
			pendingMatches: { count: 1, statuses: ["pending"] },
		});
	} finally {
		startup.dispose();
	}
});

test("startup evidence reads the actual Router and React startup state without route contents", async ({
	page,
}, info) => {
	await page.route(/\/api\/v[12]\//, (route) =>
		route.fulfill(
			new URL(route.request().url()).pathname === "/api/v1/session"
				? {
						json: {
							schemaVersion: 1,
							user: {
								userId: "synthetic-admin",
								displayName: "Controlled Admin",
								roles: ["employee", "system_admin"],
							},
						},
					}
				: {
						status: 503,
						json: {
							schemaVersion: 1,
							code: "DEPENDENCY_UNAVAILABLE",
							retryable: true,
							message: "Controlled",
							traceId: "controlled-startup",
						},
					},
		),
	);
	const startup = recordStartupEvidence(page);
	try {
		await page.goto("/admin/approvals");
		await expect(
			page.getByRole("heading", { name: "审批申请", exact: true }),
		).toBeVisible();
		let captured = "";
		await startup.attach({
			...info,
			attach: async (_name, attachment) => {
				captured = String(attachment?.body);
			},
		});
		const evidence = JSON.parse(captured);
		expect(captured).not.toContain("synthetic-admin");
		expect(captured).not.toContain("Controlled Admin");
		expect(evidence.document.reactRootCreated).toBe(true);
		expect(evidence.document.router.present).toBe(true);
		expect(evidence.document.router.matches.count).toBeGreaterThan(0);
		expect(evidence.latestNavigation.scripts.issued).toBeGreaterThan(0);
		expect(evidence.latestNavigation.scriptEvents.length).toBeLessThanOrEqual(
			20,
		);
	} finally {
		startup.dispose();
	}
});
