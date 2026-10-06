import { expect, type Page, type TestInfo } from "@playwright/test";

// OpenDesign export index.html SHA-256:
// c278d81ade83e5e2237d852cbca1f9930759652811ddd6ef99fef099a4405940
export const designViewports = [
	{ width: 360, height: 800 },
	{ width: 390, height: 844 },
	{ width: 430, height: 932 },
	{ width: 600, height: 960 },
	{ width: 820, height: 1180 },
	{ width: 1024, height: 768 },
	{ width: 1366, height: 768 },
	{ width: 1440, height: 900 },
	{ width: 1920, height: 1080 },
] as const;

export async function captureDesignContract(
	page: Page,
	info: TestInfo,
	screen: string,
) {
	await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
	const measured = await page.evaluate(() => {
		const topbar = document.querySelector(".platform-topbar");
		const sidebar = document.querySelector(".platform-sidebar");
		if (!topbar || !sidebar) throw new Error("Missing application shell");
		const root = getComputedStyle(document.documentElement);
		const button = [
			...document.querySelectorAll(
				'main [data-slot="button"], main a[class~="group/button"]',
			),
		].find((node) => node.getBoundingClientRect().width > 0);
		const input = [
			...document.querySelectorAll(
				'main .directory-control, main [data-slot="input"], main [data-slot="select-trigger"], main [data-slot="native-select"]',
			),
		].find((node) => node.getBoundingClientRect().width > 0);
		return {
			viewport: { width: innerWidth, height: innerHeight },
			pageWidth: Math.max(
				document.body.scrollWidth,
				document.documentElement.scrollWidth,
			),
			topbar: topbar.getBoundingClientRect().toJSON(),
			sidebar: sidebar.getBoundingClientRect().toJSON(),
			colors: Object.fromEntries(
				[
					"--background",
					"--surface",
					"--foreground",
					"--primary",
					"--border",
					"--success",
					"--warning",
					"--destructive",
				].map((key) => [key, root.getPropertyValue(key).trim()]),
			),
			controls: [button, input]
				.filter((node): node is Element => Boolean(node))
				.map((node) => ({
					tag: node.tagName,
					radius: getComputedStyle(node).borderTopLeftRadius,
					height: node.getBoundingClientRect().height,
				})),
		};
	});
	expect(measured.pageWidth).toBeLessThanOrEqual(measured.viewport.width);
	expect(measured.topbar.height).toBe(72);
	expect(measured.sidebar.width).toBe(
		measured.viewport.width >= 1024 ? 248 : 0,
	);

	const normalizedColors = Object.fromEntries(
		Object.entries(measured.colors).map(([key, value]) => {
			const parts = /^oklch\(([\d.]+)(%)? ([\d.]+) ([\d.]+)\)$/.exec(value);
			if (!parts) throw new Error(`Unexpected color serialization: ${value}`);
			return [
				key,
				[
					Number(parts[1]) / (parts[2] ? 100 : 1),
					Number(parts[3]),
					Number(parts[4]),
				],
			];
		}),
	);
	expect(normalizedColors).toEqual({
		"--background": [0.975, 0.008, 95],
		"--surface": [0.995, 0.005, 90],
		"--foreground": [0.23, 0.02, 255],
		"--primary": [0.58, 0.16, 248],
		"--border": [0.88, 0.018, 95],
		"--success": [0.63, 0.14, 145],
		"--warning": [0.74, 0.14, 82],
		"--destructive": [0.58, 0.17, 27],
	});

	for (const control of measured.controls) {
		expect(control.height).toBeGreaterThanOrEqual(44);
		expect(control.radius).toBe("10px");
	}
	const name = `${screen}-${measured.viewport.width}x${measured.viewport.height}`;
	await info.attach(`${name}-measurements`, {
		body: JSON.stringify(measured, null, 2),
		contentType: "application/json",
	});
	await info.attach(name, {
		body: await page.screenshot({ fullPage: true, animations: "disabled" }),
		contentType: "image/png",
	});
}
