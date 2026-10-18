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
