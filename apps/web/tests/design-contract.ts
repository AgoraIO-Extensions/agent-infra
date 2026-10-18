import {
	expect,
	type Locator,
	type Page,
	type TestInfo,
} from "@playwright/test";

// OpenDesign export index.html SHA-256:
// f66a8694aecee90322161e9a31d682073919ae846d488312e225edf03232aaaf
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
		type ElementStyle = {
			tag: string;
			className: string;
			height: number;
			fontSize: number;
			fontWeight: number;
			lineHeight: number;
			letterSpacing: string;
			marginTop: number;
			marginBottom: number;
			paddingTop: number;
			paddingRight: number;
			paddingBottom: number;
			paddingLeft: number;
			borderRadius: string;
			borderWidth: string;
			borderStyle: string;
			borderColor: string;
			color: string;
			backgroundColor: string;
			boxShadow: string;
			transitionDuration: string;
			transitionProperty: string;
			animationDuration: string;
			outlineWidth: string;
			outlineOffset: string;
		};
		const visible = (node: Element) => {
			const rect = node.getBoundingClientRect();
			const style = getComputedStyle(node);
			return (
				rect.width > 0 &&
				rect.height > 0 &&
				style.visibility !== "hidden" &&
				style.display !== "none"
			);
		};
		const firstVisible = (selectors: string[]) => {
			for (const selector of selectors) {
				const node = [...document.querySelectorAll(selector)].find(visible);
				if (node) return node;
			}
			return undefined;
		};
		const readStyle = (node: Element | undefined): ElementStyle | null => {
			if (!node) return null;
			const style = getComputedStyle(node);
			const fontSize = Number.parseFloat(style.fontSize);
			const parsedLineHeight = Number.parseFloat(style.lineHeight);
			return {
				tag: node.tagName,
				className: typeof node.className === "string" ? node.className : "",
				height: node.getBoundingClientRect().height,
				fontSize,
				fontWeight: Number.parseInt(style.fontWeight, 10) || 400,
				lineHeight: Number.isFinite(parsedLineHeight)
					? parsedLineHeight
					: fontSize * 1.2,
				letterSpacing: style.letterSpacing,
				marginTop: Number.parseFloat(style.marginTop) || 0,
				marginBottom: Number.parseFloat(style.marginBottom) || 0,
				paddingTop: Number.parseFloat(style.paddingTop) || 0,
				paddingRight: Number.parseFloat(style.paddingRight) || 0,
				paddingBottom: Number.parseFloat(style.paddingBottom) || 0,
				paddingLeft: Number.parseFloat(style.paddingLeft) || 0,
				borderRadius: style.borderRadius,
				borderWidth: style.borderWidth,
				borderStyle: style.borderStyle,
				borderColor: style.borderColor,
				color: style.color,
				backgroundColor: style.backgroundColor,
				boxShadow: style.boxShadow,
				transitionDuration: style.transitionDuration,
				transitionProperty: style.transitionProperty,
				animationDuration: style.animationDuration,
				outlineWidth: style.outlineWidth,
				outlineOffset: style.outlineOffset,
			};
		};
		const topbar = document.querySelector(".platform-topbar");
		const sidebar = document.querySelector(".platform-sidebar");
		if (!topbar || !sidebar) throw new Error("Missing application shell");
		const root = getComputedStyle(document.documentElement);
		const largestVisible = (nodes: Element[]) =>
			nodes
				.filter((node) => node.getBoundingClientRect().width > 0)
				.toSorted(
					(a, b) =>
						b.getBoundingClientRect().height - a.getBoundingClientRect().height,
				)
				.at(0);
		const button = largestVisible([
			...document.querySelectorAll(
				'main [data-slot="button"]:not(.directory-chip-remove), main a[class~="group/button"]',
			),
		]);
		const input = largestVisible([
			...document.querySelectorAll(
				'main .directory-control, main [data-slot="input"], main [data-slot="select-trigger"], main [data-slot="native-select"]',
			),
		]);
		const pageHeading = firstVisible(["main h1"]);
		const sectionHeading = firstVisible(["main h2", "main h3"]);
		const surface = firstVisible([
			"main .directory-card",
			"main .owned-agent-card",
			"main .surface-card",
			"main .workbench-attention",
			"main .workbench-applications",
			"main .agent-detail-panel",
			"main .application-form-card",
			"main .audit-detail-panel",
			"main .state-card",
			'main [data-slot="empty"]',
			'main [data-slot="alert"]',
			"main .connection-notice",
			"main .browser-capability-card",
		]);
		const field = firstVisible([
			"main .directory-control",
			'main [data-slot="select-trigger"]',
			'main [data-slot="native-select"]',
			'main [data-slot="input"]',
			'main [data-slot="textarea"]',
		]);
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
					"--accent-ink",
					"--success-ink",
					"--warning-ink",
					"--danger-ink",
					"--muted-ink",
				].map((key) => [key, root.getPropertyValue(key).trim()]),
			),
			controls: [button, input]
				.filter((node): node is Element => Boolean(node))
				.map((node) => ({
					tag: node.tagName,
					radius: getComputedStyle(node).borderTopLeftRadius,
					height: node.getBoundingClientRect().height,
				})),
			styles: {
				body: readStyle(document.body),
				pageHeading: readStyle(pageHeading),
				sectionHeading: readStyle(sectionHeading),
				surface: readStyle(surface),
				field: readStyle(field),
			},
			primitiveCounts: {
				buttons: document.querySelectorAll('main [data-slot="button"]').length,
				inputs: document.querySelectorAll(
					'main [data-slot="input"], main [data-slot="select-trigger"], main [data-slot="native-select"]',
				).length,
				tables: document.querySelectorAll('main [data-slot="table"]').length,
				cards: document.querySelectorAll(
					'main .directory-card, main .owned-agent-card, main .record-row, main .application-row, main .surface-card, main .workbench-attention, main .workbench-applications, main .agent-detail-panel, main .application-form-card, main .audit-detail-panel, main .state-card, main [data-slot="empty"], main [data-slot="alert"], main .connection-notice, main .browser-capability-card',
				).length,
				headings: document.querySelectorAll("main h1, main h2, main h3").length,
			},
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
		"--accent-ink": [0.46, 0.15, 248],
		"--success-ink": [0.45, 0.12, 145],
		"--warning-ink": [0.49, 0.11, 82],
		"--danger-ink": [0.46, 0.14, 27],
		"--muted-ink": [0.42, 0.03, 255],
	});

	for (const control of measured.controls) {
		expect(control.height).toBeGreaterThanOrEqual(44);
		expect(control.radius).toBe("10px");
	}

	const { body, pageHeading, sectionHeading, surface, field } = measured.styles;
	expect(body).not.toBeNull();
	expect(body?.fontSize).toBe(15);
	expect(body?.lineHeight).toBeGreaterThanOrEqual(22);
	expect(body?.lineHeight).toBeLessThanOrEqual(28);

	// PageHeading / Section are shared visual seams. Keep these assertions as
	// ranges because the handoff intentionally uses clamp() at the responsive
	// breakpoints, while still catching a reset to browser defaults.
	expect(pageHeading).not.toBeNull();
	expect(pageHeading?.fontSize).toBeGreaterThanOrEqual(20);
	expect(pageHeading?.fontSize).toBeLessThanOrEqual(40);
	expect(pageHeading?.fontWeight).toBeGreaterThanOrEqual(500);
	expect(pageHeading?.fontWeight).toBeLessThanOrEqual(700);
	expect(pageHeading?.lineHeight).toBeGreaterThan(pageHeading?.fontSize ?? 0);
	expect(pageHeading?.marginBottom).toBeLessThanOrEqual(40);
	if (sectionHeading) {
		expect(sectionHeading.fontSize).toBeGreaterThanOrEqual(12);
		expect(sectionHeading.fontSize).toBeLessThanOrEqual(28);
		expect(sectionHeading.fontWeight).toBeGreaterThanOrEqual(500);
		expect(sectionHeading.fontWeight).toBeLessThanOrEqual(700);
		expect(sectionHeading.lineHeight).toBeGreaterThan(sectionHeading.fontSize);
	}
	if (surface) {
		expect(surface.borderWidth).toMatch(/(?:1px|2px)/);
		expect(surface.borderStyle).toBe("solid");
		expect(surface.borderColor).not.toBe("rgba(0, 0, 0, 0)");
		expect(surface.borderRadius).toMatch(/^(10|11|12|13|14)px$/);
		expect(surface.paddingTop).toBeGreaterThanOrEqual(12);
		expect(surface.paddingTop).toBeLessThanOrEqual(24);
	}
	if (field) {
		expect(field.height).toBeGreaterThanOrEqual(44);
		expect(field.borderRadius).toBe("10px");
		expect(field.lineHeight).toBeGreaterThanOrEqual(20);
	}

	for (const [name, count] of Object.entries(measured.primitiveCounts)) {
		expect(
			Number.isInteger(count),
			`${name} primitive count must be an integer`,
		).toBe(true);
		expect(
			count,
			`${name} primitive count must not be negative`,
		).toBeGreaterThanOrEqual(0);
	}
	expect(
		measured.primitiveCounts.buttons +
			measured.primitiveCounts.inputs +
			measured.primitiveCounts.tables +
			measured.primitiveCounts.cards +
			measured.primitiveCounts.headings,
	).toBeGreaterThan(0);

	const stateCandidates = page.locator(
		'.platform-topbar [data-slot="button"]:not([disabled]), .platform-sidebar .platform-nav-item, main [data-slot="button"]:not([disabled]), main a[class~="group/button"], main a',
	);
	let stateProbe: Locator | undefined;
	let interactiveStates: Record<string, unknown> | null = null;
	for (let index = 0; index < (await stateCandidates.count()); index += 1) {
		const candidate = stateCandidates.nth(index);
		if (
			(await candidate.isVisible()) &&
			(await candidate.evaluate((node) => {
				const style = getComputedStyle(node);
				return (
					style.transitionDuration !== "0s" &&
					style.transitionProperty !== "none"
				);
			}))
		) {
			stateProbe = candidate;
			break;
		}
	}
	if (stateProbe) {
		const readInteractiveStyle = () =>
			stateProbe?.evaluate((node) => {
				const style = getComputedStyle(node);
				return {
					backgroundColor: style.backgroundColor,
					borderColor: style.borderColor,
					color: style.color,
					boxShadow: style.boxShadow,
					textDecorationLine: style.textDecorationLine,
					transform: style.transform,
					transitionDuration: style.transitionDuration,
					transitionProperty: style.transitionProperty,
					animationDuration: style.animationDuration,
					outlineWidth: style.outlineWidth,
					outlineOffset: style.outlineOffset,
				};
			});
		const resting = await readInteractiveStyle();
		await stateProbe.hover();
		await page.waitForTimeout(200);
		const hover = await readInteractiveStyle();
		expect(hover).not.toBeNull();
		expect(hover?.transitionDuration).not.toBe("0s");
		expect(hover?.transitionProperty).not.toBe("none");

		await stateProbe.focus();
		const focused = await readInteractiveStyle();
		expect(
			await stateProbe.evaluate((node) => node === document.activeElement),
		).toBe(true);
		expect(focused?.outlineWidth).toMatch(/^\d+(?:\.\d+)?px$/);
		expect(focused?.outlineOffset).toMatch(/^(?:auto|(?:0|1|2|3)px)$/);
		// The handoff uses one outline ring. A focus-visible box-shadow would
		// stack a second halo on top of it, which is especially distracting for
		// compact controls.
		expect(focused?.boxShadow).toBe("none");

		const box = await stateProbe.boundingBox();
		let pressed = resting;
		if (box) {
			await stateProbe.evaluate((node) => {
				node.addEventListener(
					"click",
					(event) => {
						event.preventDefault();
						event.stopImmediatePropagation();
					},
					{ capture: true, once: true },
				);
			});
			await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
			await page.mouse.down();
			pressed = await readInteractiveStyle();
			if (resting?.transitionProperty.includes("transform")) {
				expect(pressed?.transitionProperty).toContain("transform");
			} else {
				expect(pressed?.transitionProperty).not.toBe("");
			}
			expect(pressed?.transform).toMatch(/^(none|matrix\()/);
			await page.mouse.up();
		}

		await page.emulateMedia({ reducedMotion: "reduce" });
		const reducedMotion = await readInteractiveStyle();
		expect(reducedMotion?.transitionDuration).toBe("0s");
		expect(reducedMotion?.animationDuration).toBe("0s");
		await page.emulateMedia({ reducedMotion: "no-preference" });
		await stateProbe.evaluate((node) => (node as HTMLElement).blur());
		interactiveStates = { resting, hover, focused, pressed, reducedMotion };
	}
	const fieldCandidates = page.locator(
		'main [data-slot="input"], main [data-slot="textarea"], main [data-slot="select-trigger"], main [data-slot="native-select"]',
	);
	for (let index = 0; index < (await fieldCandidates.count()); index += 1) {
		const fieldCandidate = fieldCandidates.nth(index);
		if (!(await fieldCandidate.isVisible())) continue;
		await fieldCandidate.focus();
		expect(
			await fieldCandidate.evaluate(
				(node) =>
					node === document.activeElement ||
					node.contains(document.activeElement),
			),
		).toBe(true);
		expect(
			await fieldCandidate.evaluate((node) => getComputedStyle(node).boxShadow),
		).toBe("none");
		await fieldCandidate.evaluate((node) => (node as HTMLElement).blur());
		break;
	}
	const name = `${screen}-${measured.viewport.width}x${measured.viewport.height}`;
	await info.attach(`${name}-measurements`, {
		body: JSON.stringify(measured, null, 2),
		contentType: "application/json",
	});
	if (interactiveStates) {
		await info.attach(`${name}-interactive-states`, {
			body: JSON.stringify(interactiveStates, null, 2),
			contentType: "application/json",
		});
	}
	await info.attach(name, {
		body: await page.screenshot({ fullPage: true, animations: "disabled" }),
		contentType: "image/png",
	});
}
