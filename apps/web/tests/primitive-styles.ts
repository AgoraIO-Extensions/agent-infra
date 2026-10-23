import { expect, type Locator, type Page } from "@playwright/test";

// 基础组件（字段、下拉、Tabs、表格卡片）的浏览器计算样式断言。只读计算值，
// 不断言类名，避免组件类被 index.css 中未分层规则覆盖时测试仍通过（NI-59）。

type StyleProperty = keyof CSSStyleDeclaration & string;

export async function computed<T extends StyleProperty>(
	locator: Locator,
	properties: readonly T[],
	pseudo?: string,
) {
	return locator.evaluate(
		(element, { properties, pseudo }) => {
			const style = getComputedStyle(element, pseudo ?? null);
			return Object.fromEntries(
				properties.map((property) => [property, String(style[property])]),
			) as Record<string, string>;
		},
		{ properties, pseudo },
	) as Promise<Record<T, string>>;
}

// 把 CSS 变量解析成浏览器计算后的颜色 / 阴影，用于与元素计算值逐字比较。
export async function resolved(
	page: Page,
	property: "color" | "backgroundColor" | "boxShadow",
	value: string,
) {
	return page.evaluate(
		({ property, value }) => {
			const probe = document.createElement("div");
			probe.style[property] = value;
			document.body.append(probe);
			const result = getComputedStyle(probe)[property];
			probe.remove();
			return result;
		},
		{ property, value },
	);
}

export async function expectFieldLabel(page: Page, label: Locator) {
	expect(
		await computed(label, ["fontSize", "fontWeight", "color", "display"]),
	).toEqual({
		fontSize: "12px",
		fontWeight: "650",
		color: await resolved(page, "color", "var(--muted-foreground)"),
		display: "block",
	});
}

export async function expectFieldControl(page: Page, control: Locator) {
	const style = await computed(control, [
		"height",
		"paddingTop",
		"paddingLeft",
		"lineHeight",
		"fontSize",
		"borderTopLeftRadius",
		"backgroundColor",
	]);
	expect(style).toEqual({
		height: "44px",
		paddingTop: "9px",
		paddingLeft: "12px",
		lineHeight: "24px",
		fontSize: "15px",
		borderTopLeftRadius: "10px",
		backgroundColor: await resolved(page, "backgroundColor", "var(--surface)"),
	});
}

// 设计稿 .input/.select/.textarea:focus（B-05）：2px accent 26% 透明描边、边框变 accent，
// offset 沿用全局 :focus-visible 的 3px，不叠加 ring 阴影。
export async function expectFieldFocus(page: Page, control: Locator) {
	await control.focus();
	expect(
		await computed(control, [
			"outlineStyle",
			"outlineWidth",
			"outlineOffset",
			"outlineColor",
			"borderTopColor",
			"boxShadow",
		]),
	).toEqual({
		outlineStyle: "solid",
		outlineWidth: "2px",
		outlineOffset: "3px",
		outlineColor: await resolved(
			page,
			"color",
			"color-mix(in oklch, var(--accent) 26%, transparent)",
		),
		borderTopColor: await resolved(page, "color", "var(--accent)"),
		boxShadow: "none",
	});
}

// 设计稿 .search-wrap：18px 图标距输入框左缘 13px、垂直居中，输入框左内边距 39px。
export async function expectSearchInput(search: Locator) {
	const geometry = await search.evaluate((input) => {
		const icon = input
			.closest('[data-slot="search-input"]')
			?.querySelector('[data-slot="search-input-icon"]');
		if (!icon) throw new Error("Missing search icon");
		const field = input.getBoundingClientRect();
		const mark = icon.getBoundingClientRect();
		return {
			width: mark.width,
			height: mark.height,
			left: Math.round(mark.left - field.left),
			centerOffset: Math.abs(
				mark.top + mark.height / 2 - (field.top + field.height / 2),
			),
			paddingLeft: getComputedStyle(input).paddingLeft,
			hidden: icon.getAttribute("aria-hidden"),
		};
	});
	expect(geometry).toMatchObject({
		width: 18,
		height: 18,
		left: 13,
		paddingLeft: "39px",
		hidden: "true",
	});
	expect(geometry.centerOffset).toBeLessThanOrEqual(1);
}

// legend 落在 fieldset 边框上就是「压线」：所有可见 legend 的 fieldset 都不能有上边框。
export async function expectNoLegendOnBorder(page: Page) {
	const onBorder = await page.locator("main legend").evaluateAll((legends) =>
		legends
			.filter((legend) => {
				const fieldset = legend.parentElement;
				return (
					legend.getBoundingClientRect().height > 0 &&
					fieldset instanceof HTMLFieldSetElement &&
					getComputedStyle(fieldset).borderTopWidth !== "0px"
				);
			})
			.map((legend) => legend.textContent?.trim()),
	);
	expect(onBorder).toEqual([]);
}

export async function expectFormSection(
	page: Page,
	name: string,
	{ first = false } = {},
) {
	const section = page.getByRole("region", { name, exact: true });
	const heading = section.getByRole("heading", { name, exact: true });
	expect(await computed(heading, ["fontSize", "fontWeight"])).toEqual({
		fontSize: "16px",
		fontWeight: "620",
	});
	expect(
		await heading.evaluate(
			(element) =>
				getComputedStyle(element).fontFamily ===
				getComputedStyle(document.body).fontFamily,
		),
	).toBe(true);
	expect(await computed(section, ["borderTopWidth", "paddingTop"])).toEqual(
		first
			? { borderTopWidth: "0px", paddingTop: "0px" }
			: { borderTopWidth: "1px", paddingTop: "22px" },
	);
	// 分隔线在标题上方，标题不压线。
	const [box, title] = await Promise.all([
		section.boundingBox(),
		heading.boundingBox(),
	]);
	if (!box || !title) throw new Error(`Missing section geometry: ${name}`);
	expect(title.y).toBeGreaterThanOrEqual(box.y + (first ? 0 : 22));
}

// 设计稿 ≤767px 的 .table-wrap 卡片规则，以及操作格在视口内（N-15）。
export async function expectCardTable(
	page: Page,
	table: Locator,
	action: Locator,
) {
	const container = table.locator("xpath=..");
	expect(
		await computed(container, ["borderTopWidth", "backgroundColor"]),
	).toEqual({ borderTopWidth: "0px", backgroundColor: "rgba(0, 0, 0, 0)" });
	expect(
		await container.evaluate(
			(element) => element.scrollWidth <= element.clientWidth,
		),
	).toBe(true);
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth === window.innerWidth,
		),
	).toBe(true);
	expect((await computed(table.locator("thead"), ["display"])).display).toBe(
		"none",
	);
	const row = table.locator("tbody tr").first();
	// 行的背景色带悬停过渡；视口切换后等过渡结束再读取。
	await expect
		.poll(
			async () => (await computed(row, ["backgroundColor"])).backgroundColor,
		)
		.toBe(await resolved(page, "backgroundColor", "var(--surface)"));
	expect(
		await computed(row, [
			"display",
			"marginBottom",
			"paddingTop",
			"borderTopWidth",
			"borderTopColor",
			"borderTopLeftRadius",
			"backgroundColor",
		]),
	).toEqual({
		display: "block",
		marginBottom: "10px",
		paddingTop: "10px",
		borderTopWidth: "1px",
		borderTopColor: await resolved(page, "color", "var(--border)"),
		borderTopLeftRadius: "11px",
		backgroundColor: await resolved(page, "backgroundColor", "var(--surface)"),
	});
	const cells = await row.locator("td").evaluateAll((elements) =>
		elements.map((cell, index, all) => {
			const style = getComputedStyle(cell);
			const label = getComputedStyle(cell, "::before");
			const value = cell.querySelector('[data-slot="table-cell-value"]');
			const header = cell
				.closest("table")
				?.querySelectorAll("thead th")
				[index]?.textContent?.trim();
			return {
				last: index === all.length - 1,
				dataLabel: cell.getAttribute("data-label"),
				header,
				display: style.display,
				justifyContent: style.justifyContent,
				gap: style.columnGap,
				padding: style.padding,
				labelContent: label.content,
				labelDisplay: label.display,
				labelSize: label.fontSize,
				labelWeight: label.fontWeight,
				labelColor: label.color,
				valueWidth: value?.getBoundingClientRect().width ?? 0,
				cellWidth: cell.getBoundingClientRect().width,
			};
		}),
	);
	const muted = await resolved(page, "color", "var(--muted-foreground)");
	for (const cell of cells) {
		expect(cell.display).toBe("flex");
		expect(cell.gap).toBe("12px");
		expect(cell.padding).toBe("6px 0px");
		if (cell.last) {
			expect(cell.justifyContent).toBe("flex-start");
			expect(cell.labelDisplay).toBe("none");
			continue;
		}
		expect(cell.justifyContent).toBe("space-between");
		expect(cell.dataLabel).toBe(cell.header);
		expect(cell.labelContent).toBe(`"${cell.dataLabel}"`);
		expect(cell).toMatchObject({
			labelSize: "11px",
			labelWeight: "400",
			labelColor: muted,
		});
		// 值容器占满标签之外的宽度，多元素值不会被挤成逐字折行。
		expect(cell.valueWidth).toBeGreaterThanOrEqual(cell.cellWidth * 0.6);
	}
	// 只做纵向滚动；表格容器没有横向溢出，操作不需要横向滚动就完整可见。
	await action.scrollIntoViewIfNeeded();
	expect(await container.evaluate((element) => element.scrollLeft)).toBe(0);
	await expect(action).toBeInViewport({ ratio: 1 });
	const [card, button] = await Promise.all([
		row.boundingBox(),
		action.boundingBox(),
	]);
	if (!card || !button) throw new Error("Missing card or action geometry");
	expect(button.height).toBeGreaterThanOrEqual(44);
	// 操作在卡片内容左缘（卡片 1px 边框 + 10px 内边距）。
	expect(Math.abs(button.x - (card.x + 11))).toBeLessThanOrEqual(1);
}

// 设计稿 th / td（1440 与 768 一致）。
export async function expectDesktopTable(page: Page, table: Locator) {
	const th = table.locator("thead th").first();
	const td = table.locator("tbody td").first();
	const header = await computed(th, [
		"fontSize",
		"fontWeight",
		"lineHeight",
		"letterSpacing",
		"color",
		"fontFamily",
	]);
	expect(header).toMatchObject({
		fontSize: "11px",
		fontWeight: "500",
		lineHeight: "15.4px",
		letterSpacing: "0.55px",
		color: await resolved(page, "color", "var(--muted-foreground)"),
	});
	// 旧规则只写 ui-monospace, monospace，Chromium 不支持 ui-monospace，于是回退到 Courier；
	// 现在的等宽栈在通用族之前提供 Menlo（macOS）与 Consolas（Windows）。
	expect(header.fontFamily).toMatch(/Menlo/);
	expect(header.fontFamily).toMatch(/Consolas/);
	expect(
		await computed(td, ["fontSize", "lineHeight", "padding", "verticalAlign"]),
	).toEqual({
		fontSize: "13px",
		lineHeight: "21.45px",
		padding: "14px 15px",
		verticalAlign: "top",
	});
	expect((await computed(table.locator("thead"), ["display"])).display).toBe(
		"table-header-group",
	);
	expect(
		(await computed(table.locator("tbody tr").first(), ["display"])).display,
	).toBe("table-row");
}

/**
 * 设计 .page-head-copy：eyebrow 上外边距为 0、贴页头文案块顶部，h1 在 eyebrow 下 9px；
 * 1440 下 h1 y=130.4，390 下 y=121.4（±1px）。坐标按文档计算，不受滚动位置影响。
 */
export async function expectPageHeadTop(page: Page, mobile: boolean) {
	const heading = page.locator("main .page-heading").first();
	await expect(heading.locator("h1")).toBeVisible();
	const geometry = await heading.evaluate((element) => {
		const eyebrow = element.querySelector(".page-eyebrow");
		const h1 = element.querySelector("h1");
		if (!eyebrow?.parentElement || !h1)
			throw new Error("Expected a page head eyebrow and h1");
		const box = (node: Element) => {
			const rect = node.getBoundingClientRect();
			return { top: rect.top + scrollY, bottom: rect.bottom + scrollY };
		};
		return {
			marginTop: getComputedStyle(eyebrow).marginTop,
			eyebrow: box(eyebrow),
			copy: box(eyebrow.parentElement),
			h1: box(h1),
		};
	});
	expect(geometry.marginTop).toBe("0px");
	expect(
		Math.abs(geometry.eyebrow.top - geometry.copy.top),
	).toBeLessThanOrEqual(0.5);
	expect(
		Math.abs(geometry.h1.top - (geometry.eyebrow.bottom + 9)),
	).toBeLessThanOrEqual(0.5);
	expect(
		Math.abs(geometry.h1.top - (mobile ? 121.4 : 130.4)),
	).toBeLessThanOrEqual(1);
}

// 设计稿 .select 的箭头（#3037 X-01、X-09）：背景上 45° / 135° 两段渐变拼成的 5px 实心小三角，
// 位于右侧 13–18px、上距 18px，颜色为 muted 文字色；控件内不再叠加图标元素。
export async function expectNativeSelectArrow(page: Page, select: Locator) {
	const muted = await resolved(page, "color", "var(--muted-foreground)");
	expect(
		await computed(select, [
			"appearance",
			"backgroundImage",
			"backgroundPosition",
			"backgroundSize",
			"backgroundRepeat",
			"paddingRight",
			"height",
		]),
	).toEqual({
		appearance: "none",
		backgroundImage: `linear-gradient(45deg, rgba(0, 0, 0, 0) 50%, ${muted} 50%), linear-gradient(135deg, ${muted} 50%, rgba(0, 0, 0, 0) 50%)`,
		backgroundPosition: "calc(100% - 18px) 18px, calc(100% - 13px) 18px",
		backgroundSize: "5px 5px, 5px 5px",
		backgroundRepeat: "no-repeat, no-repeat",
		paddingRight: "40px",
		height: "44px",
	});
	expect(
		await select.evaluate(
			(element) =>
				element.closest('[data-slot="native-select-wrapper"]')?.children.length,
		),
	).toBe(1);
}

/**
 * 设计 .empty（#3037 X-02、X-13、X-16）：直接子元素是网格行，220px 内的剩余高度由各行均分、
 * 每行内容居中，只有图标下方 11px。`expected` 是图标、标题、说明与操作相对空态上缘的 top（±1px），
 * 取自导出稿同一空态的测量值；没有的项写 null。
 */
export async function expectEmptyRows(
	empty: Locator,
	expected: {
		icon: number | null;
		title: number;
		description: number;
		action: number | null;
	},
) {
	const tops = await empty.evaluate((element) => {
		const top = element.getBoundingClientRect().top;
		const at = (node: Element | null | undefined) =>
			node ? node.getBoundingClientRect().top - top : null;
		return {
			height: element.getBoundingClientRect().height,
			display: getComputedStyle(element).display,
			icon: at(element.querySelector('svg[aria-hidden="true"]')),
			title: at(element.querySelector('[data-slot="empty-title"]')),
			description: at(element.querySelector('[data-slot="empty-description"]')),
			action: at(
				element.querySelector(
					'[data-slot="empty-content"] :is(a, button), :scope > :is(a, button)',
				),
			),
		};
	});
	expect(tops.display).toBe("grid");
	expect(tops.height).toBe(220);
	for (const key of ["icon", "title", "description", "action"] as const) {
		const want = expected[key];
		if (want === null) {
			expect(tops[key], key).toBeNull();
			continue;
		}
		expect(
			Math.abs((tops[key] ?? Number.NaN) - want),
			`${key}: ${tops[key]} vs ${want}`,
		).toBeLessThanOrEqual(1);
	}
}

/**
 * 设计 .skill-dialog（#3037 X-07、X-11、X-15）：宽 min(620px, 视口 − 36px)、高不超过 86dvh、
 * 圆角 14px、var(--shadow)，内边距 24px（窄屏 18px）；标题 20px / 600 / 28px，
 * 页眉关闭是 ghost 文字按钮「关闭」，操作区上距 20px。
 */
export async function expectSkillDialog(
	page: Page,
	dialog: Locator,
	mobile: boolean,
) {
	await expect(dialog).toBeVisible();
	await expect(dialog).toHaveAttribute("data-variant", "skill");
	const viewport = page.viewportSize();
	const box = await dialog.boundingBox();
	if (!viewport || !box) throw new Error("Missing Skill dialog geometry");
	expect(
		Math.abs(box.width - Math.min(620, viewport.width - 36)),
	).toBeLessThanOrEqual(1);
	expect(box.height).toBeLessThanOrEqual(viewport.height * 0.86 + 1);
	expect(
		Math.abs(box.x + box.width / 2 - viewport.width / 2),
	).toBeLessThanOrEqual(1);
	const padding = mobile ? "18px" : "24px";
	expect(
		await computed(dialog, [
			"paddingTop",
			"paddingLeft",
			"borderTopLeftRadius",
			"borderTopWidth",
			"boxShadow",
		]),
	).toEqual({
		paddingTop: padding,
		paddingLeft: padding,
		borderTopLeftRadius: "14px",
		borderTopWidth: "1px",
		boxShadow: await resolved(page, "boxShadow", "var(--shadow)"),
	});
	const title = dialog.locator('[data-slot="dialog-title"]');
	expect(
		await computed(title, [
			"fontSize",
			"fontWeight",
			"lineHeight",
			"letterSpacing",
		]),
	).toEqual({
		fontSize: "20px",
		fontWeight: "600",
		lineHeight: "28px",
		letterSpacing: "normal",
	});
	expect(
		await title.evaluate(
			(element) =>
				getComputedStyle(element).fontFamily ===
				getComputedStyle(document.body).fontFamily,
		),
	).toBe(true);
	const header = dialog.locator('[data-slot="dialog-header"]');
	const close = header.getByRole("button", { name: "关闭", exact: true });
	await expect(close).toHaveCount(1);
	await expect(close).toHaveText("关闭");
	expect((await close.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
	await expect(dialog.getByRole("button", { name: "关闭弹窗" })).toHaveCount(0);
	await expect(dialog.locator('[data-slot="dialog-footer"]')).toHaveCSS(
		"margin-top",
		"20px",
	);
}

/**
 * 设计 ≤767px .section-head{align-items:flex-start}（#3037 X-03、X-05、X-14）：
 * 区头右侧的 chip 或入口与 h2 顶对齐（±1px）。
 */
export async function expectSectionHeadTopAligned(
	heading: Locator,
	side: Locator,
) {
	const [title, aside] = await Promise.all([
		heading.boundingBox(),
		side.boundingBox(),
	]);
	if (!title || !aside) throw new Error("Missing section head geometry");
	expect(Math.abs(aside.y - title.y)).toBeLessThanOrEqual(1);
}

/**
 * 弹窗内没有同名控件（#3037 X-04、AC-2）：页眉图标钮名为「关闭弹窗」，页脚主按钮「关闭」各一个；
 * 弹窗打开时页面其余部分不可交互，所以弹窗内的按钮名逐一不同。
 */
export async function expectDistinctDialogControls(dialog: Locator) {
	await expect(
		dialog
			.locator('[data-slot="dialog-header"]')
			.getByRole("button", { name: "关闭弹窗", exact: true }),
	).toHaveCount(1);
	await expect(
		dialog
			.locator('[data-slot="dialog-footer"]')
			.getByRole("button", { name: "关闭", exact: true }),
	).toHaveCount(1);
	await expect(
		dialog.getByRole("button", { name: "关闭", exact: true }),
	).toHaveCount(1);
	const names = await dialog
		.locator("button:visible")
		.evaluateAll((buttons) =>
			buttons.map(
				(button) =>
					button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "",
			),
		);
	expect(new Set(names).size, names.join(" / ")).toBe(names.length);
}

/**
 * #3037 AC-2：记录页面的未捕获异常与 console.error。fixture 故意返回的 4xx / 5xx 会让浏览器
 * 打出「Failed to load resource」资源日志，这不是页面错误，不计入。
 */
export function trackPageErrors(page: Page) {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (
			message.type() === "error" &&
			!message.text().startsWith("Failed to load resource")
		)
			errors.push(message.text());
	});
	return errors;
}

/** #3037 AC-2：没有控制台错误，页面没有横向溢出。 */
export async function expectCleanPage(page: Page, errors: readonly string[]) {
	expect(errors).toEqual([]);
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	).toBe(true);
}

/**
 * 文字颜色与其实际背景的 WCAG 对比度（#3128 B2-01）：向上叠加祖先的半透明背景，
 * 缺省为白色；颜色经 canvas 归一为 sRGB，兼容 oklch / color-mix 计算值。
 */
export async function textContrast(locator: Locator) {
	return locator.evaluate((element) => {
		const canvas = document.createElement("canvas");
		canvas.width = 1;
		canvas.height = 1;
		const context = canvas.getContext("2d", { willReadFrequently: true });
		if (!context) throw new Error("Missing canvas context");
		const rgba = (color: string) => {
			context.clearRect(0, 0, 1, 1);
			context.fillStyle = "#000";
			context.fillStyle = color;
			context.fillRect(0, 0, 1, 1);
			const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(
				0,
				0,
				1,
				1,
			).data;
			return [r, g, b, a / 255] as const;
		};
		const luminance = (channels: readonly number[]) => {
			const [r = 0, g = 0, b = 0] = channels.map((channel) => {
				const value = channel / 255;
				return value <= 0.03928
					? value / 12.92
					: ((value + 0.055) / 1.055) ** 2.4;
			});
			return 0.2126 * r + 0.7152 * g + 0.0722 * b;
		};
		const layers: (readonly [number, number, number, number])[] = [];
		for (let node: Element | null = element; node; node = node.parentElement) {
			const layer = rgba(getComputedStyle(node).backgroundColor);
			if (layer[3] > 0) layers.push(layer);
			if (layer[3] >= 1) break;
		}
		let background = [255, 255, 255];
		for (const [r, g, b, a] of layers.toReversed())
			background = [r, g, b].map(
				(channel, index) => channel * a + (background[index] ?? 0) * (1 - a),
			);
		const [r, g, b, a] = rgba(getComputedStyle(element).color);
		const foreground = [r, g, b].map(
			(channel, index) => channel * a + (background[index] ?? 0) * (1 - a),
		);
		const [light = 1, dark = 1] = [luminance(foreground), luminance(background)]
			.toSorted((left, right) => right - left)
			.map((value) => value + 0.05);
		return light / dark;
	});
}

/**
 * #3128 B2-11：设计稿全局 button{cursor:pointer}。范围内可见的按钮，可用时悬停为指针，
 * 禁用（:disabled 或 aria-disabled）时不是指针。范围内至少要有一个按钮。
 */
export async function expectPointerButtons(scope: Locator, context: string) {
	const buttons = await scope
		.locator('button, [role="button"]')
		.evaluateAll((nodes) =>
			nodes
				.filter((node) => (node as HTMLElement).checkVisibility())
				.map((node) => ({
					name:
						node.getAttribute("aria-label") ??
						node.textContent?.trim() ??
						node.tagName,
					disabled:
						node.matches(":disabled") ||
						node.getAttribute("aria-disabled") === "true",
					cursor: getComputedStyle(node).cursor,
				})),
		);
	expect(buttons.length, `${context} 按钮`).toBeGreaterThan(0);
	expect(
		buttons
			.filter(({ disabled, cursor }) =>
				disabled ? cursor === "pointer" : cursor !== "pointer",
			)
			.map(({ name, cursor }) => `${name}: ${cursor}`),
		`${context} 按钮光标`,
	).toEqual([]);
}

/**
 * #3268 N8-2-02：字段级错误为公共 FieldError——12px / 1.5（18px）、--danger-ink、上距 6px，
 * 不带边框，也不在 Alert 框内。只读计算值，不断言类名。
 */
export async function expectPublicFieldError(page: Page, error: Locator) {
	await expect(error).toBeVisible();
	expect(
		await computed(error, [
			"fontSize",
			"lineHeight",
			"color",
			"marginTop",
			"borderTopWidth",
		]),
	).toEqual({
		fontSize: "12px",
		lineHeight: "18px",
		color: await resolved(page, "color", "var(--danger-ink)"),
		marginTop: "6px",
		borderTopWidth: "0px",
	});
	expect(
		await error.evaluate((element) =>
			Boolean(element.closest('[data-slot="alert"]')),
		),
	).toBe(false);
}

/**
 * #3268 N8-2-10：企微卡片内的错误为导出稿 .wecom-channel-error——单行 12px / 1.6（19.2px）、
 * danger 78% 混 fg，无边框、无内边距、无图标，距上方 10px，role=alert。
 */
export async function expectWecomCardError(page: Page, error: Locator) {
	await expect(error).toBeVisible();
	await expect(error).toHaveAttribute("role", "alert");
	expect(
		await computed(error, [
			"fontSize",
			"lineHeight",
			"color",
			"marginTop",
			"borderTopWidth",
			"paddingTop",
		]),
	).toEqual({
		fontSize: "12px",
		lineHeight: "19.2px",
		color: await resolved(
			page,
			"color",
			"color-mix(in oklch, var(--danger) 78%, var(--fg))",
		),
		marginTop: "10px",
		borderTopWidth: "0px",
		paddingTop: "0px",
	});
	await expect(error.locator("svg")).toHaveCount(0);
	expect(
		await error.evaluate((element) =>
			Boolean(element.closest('[data-slot="alert"]')),
		),
	).toBe(false);
	// 单行：高度等于一行行高。
	expect((await error.boundingBox())?.height ?? 0).toBeCloseTo(19.2, 0);
}

