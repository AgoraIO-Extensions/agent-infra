import {
	AgentProjectionV2Schema,
	ConnectionCapabilityProjectionV1Schema,
	ConversationDetailProjectionV2Schema,
	ConversationPageV1Schema,
	ConversationProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	event,
	history,
	timestamp,
} from "../src/features/conversation/conversation-test-fixtures";
import { deploymentConfiguration } from "../src/features/my-agents/test-fixtures";
import { keepConversationStreamOpen } from "./conversation-stream";
import { controlledFileLimits, isFileLimitsRequest } from "./file-limits";
import { duplicateControlNames } from "./page-hygiene";
import { expectCleanPage, trackPageErrors } from "./primitive-styles";

const conversationId = "conversation-1";
const viewports = [
	{ width: 1440, height: 900 },
	{ width: 390, height: 844 },
] as const;
const limitCopy =
	"仅支持 text/plain 文本文件，最多 4 个，单个文件不超过 4096 字节。";

type LimitsMode = "ready" | "pending" | "error";

/**
 * 选中 Skill「workspace-summary」的对话页（#3259）。上传链按文件名受控：`hold` 的内容写入
 * 等待 `releaseUpload()`，`fail` / `expired` 首次分别得到 500 / 403（上传失败 / 授权过期），重试成功；
 * 能力调用按服务端 invalid_parameters 拒绝，让错误行出现在输入框内。
 */
async function skillControlFileFixture(
	page: Page,
	{ attachments, limits }: { attachments: boolean; limits: LimitsMode },
) {
	const requests: string[] = [];
	const unexpected: string[] = [];
	const attempts = new Map<string, number>();
	let releaseLimits: () => void = () => undefined;
	const limitsHeld = new Promise<void>((resolve) => {
		releaseLimits = resolve;
	});
	let releaseUpload: () => void = () => undefined;
	const uploadHeld = new Promise<void>((resolve) => {
		releaseUpload = resolve;
	});
	await keepConversationStreamOpen(page);
	const agent = AgentProjectionV2Schema.parse({
		...pilotFakeScenariosV2.starting.response.body,
		agentId: "agent-1",
		name: "受控控制文件助手",
		managementStatus: "available",
		serviceAvailability: "ready",
		capabilities: {
			...pilotFakeScenariosV2.starting.response.body.capabilities,
			attachments,
			nativeMetadata: true,
		},
	});
	// 已有终态 Execution 的就绪会话：命令与 Skill 目录按该 Execution 读取。
	const detail = ConversationDetailProjectionV2Schema.parse({
		...history(conversationId, [
			event(1),
			{
				...event(2),
				schemaVersion: 1 as const,
				type: "execution.status" as const,
				payload: { status: "completed" as const },
			},
		]),
		conversation: { ...history().conversation, status: "ready" },
	});
	const projection = (fileId: string, name: string) => ({
		schemaVersion: 1,
		fileId,
		kind: "attachment",
		descriptor: {
			name,
			mediaType: "text/plain",
			sizeBytes: 1,
			sha256: "a".repeat(64),
		},
		status: "available",
		createdAt: timestamp,
		expiresAt: "2027-01-01T00:00:00Z",
	});
	await page.route(/\/api\/v[12]\//, async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const path = url.pathname;
		requests.push(`${request.method()} ${path}`);
		if (isFileLimitsRequest(request.method(), path)) {
			if (limits === "pending") {
				await limitsHeld;
				return route.fulfill({ json: controlledFileLimits() }).catch(() => {});
			}
			return limits === "ready"
				? route.fulfill({ json: controlledFileLimits() })
				: route.fulfill({
						status: 503,
						json: { message: "controlled limits failure" },
					});
		}
		if (path === "/api/v1/connection/capability")
			return route.fulfill({
				json: ConnectionCapabilityProjectionV1Schema.parse({
					schemaVersion: 1,
					status: "unavailable",
					reason: "missing",
				}),
			});
		if (path === "/api/v2/deployment/configuration")
			return route.fulfill({ json: deploymentConfiguration });
		if (path === "/api/v1/session")
			return route.fulfill({
				json: {
					schemaVersion: 1,
					user: {
						userId: "controlled-person",
						displayName: "受控员工",
						roles: ["employee"],
					},
				},
				headers: { "X-Platform-Session-Generation": "g".repeat(43) },
			});
		if (path === "/api/v2/me/conversations/recent")
			return route.fulfill({
				json: ConversationPageV1Schema.parse({ items: [], nextCursor: null }),
			});
		if (path === "/api/v2/agents/agent-1")
			return route.fulfill({ json: agent });
		if (path === "/api/v1/agents/agent-1/conversations")
			return route.fulfill({
				json: ConversationPageV1Schema.parse({
					items: [
						ConversationProjectionV1Schema.parse(
							history(conversationId, []).conversation,
						),
					],
					nextCursor: null,
				}),
			});
		if (path === `/api/v2/conversations/${conversationId}`)
			return route.fulfill({ json: detail });
		if (path.endsWith("/events"))
			return route.fulfill({
				contentType: "text/event-stream",
				body: ": heartbeat\n\n",
			});
		if (request.method() === "GET" && path.endsWith("/native-metadata")) {
			const commands = url.searchParams.get("selector") === "commands";
			return route.fulfill({
				json: {
					selector: commands ? "commands" : "skills",
					revision: (commands ? "c" : "d").repeat(64),
					capabilities: commands
						? []
						: [
								{
									id: "e".repeat(64),
									kind: "skill",
									name: "workspace-summary",
									description: "Summarize approved workspace files",
									source: { name: "skillhub", version: "1.0.0" },
									availability: "discovered",
								},
							],
				},
			});
		}
		if (
			request.method() === "POST" &&
			path.endsWith("/native-capability/invoke")
		)
			return route.fulfill({
				status: 409,
				json: { outcome: "invalid_parameters" },
			});
		if (request.method() === "POST" && path.endsWith("/files")) {
			const name = request.postDataJSON().descriptor.name as string;
			const attempt = (attempts.get(name) ?? 0) + 1;
			attempts.set(name, attempt);
			if (attempt === 1 && name.startsWith("fail"))
				return route.fulfill({
					status: 500,
					json: { message: "controlled upload failure" },
				});
			if (attempt === 1 && name.startsWith("expired"))
				return route.fulfill({
					status: 403,
					json: { message: "controlled grant expiry" },
				});
			return route.fulfill({
				status: 201,
				json: projection(`file-${name}`, name),
			});
		}
		if (request.method() === "POST" && path.endsWith("/access")) {
			const fileId = path.split("/").at(-2) ?? "";
			return route.fulfill({
				json: {
					schemaVersion: 1,
					accessId: `access-${fileId}`,
					file: projection(fileId, fileId.replace(/^file-/, "")),
					path: path.replace(/\/access$/, "/content"),
					grant: { format: "compact-jws", schemaVersion: 1, token: "grant" },
					expiresAt: "2027-01-01T00:00:00Z",
				},
			});
		}
		if (request.method() === "PUT" && path.endsWith("/content")) {
			if (path.includes("/file-hold")) await uploadHeld;
			return route.fulfill({ status: 204, body: "" }).catch(() => {});
		}
		if (request.method() === "POST" && path.endsWith("/complete")) {
			const fileId = path.split("/").at(-2) ?? "";
			return route.fulfill({
				json: projection(fileId, fileId.replace(/^file-/, "")),
			});
		}
		unexpected.push(`${request.method()} ${path}`);
		return route.abort();
	});
	await page.goto(`/chat/agent-1/${conversationId}`);
	const input = page.getByLabel("消息", { exact: true });
	await expect(input).toBeEnabled();
	await input.fill("/summary");
	await expect(
		page.getByRole("option", { name: /workspace-summary/ }),
	).toBeVisible();
	await page.keyboard.press("Enter");
	await expect(page.locator(".capability-selection")).toBeVisible();
	return {
		input,
		picker: page.getByTestId("skill-control-file-picker"),
		requests,
		unexpected,
		releaseLimits: () => releaseLimits(),
		releaseUpload: () => releaseUpload(),
	};
}

/** 区块、已选 Skill 卡与错误行相对输入框内缘的左右内缩（AC-1）。 */
async function insets(locator: Locator) {
	return locator.evaluate((node) => {
		const form = node.closest("form");
		if (!form) throw new Error("Expected the composer form");
		const box = node.getBoundingClientRect();
		const outer = form.getBoundingClientRect();
		const left = outer.left + form.clientLeft;
		return {
			left: box.left - left,
			right: left + form.clientWidth - box.right,
		};
	});
}

async function expectAligned(page: Page, mobile: boolean, rows: Locator[]) {
	const expected = mobile ? 8 : 12;
	for (const row of rows) {
		const inset = await insets(row);
		expect(Math.abs(inset.left - expected)).toBeLessThanOrEqual(1);
		expect(Math.abs(inset.right - expected)).toBeLessThanOrEqual(1);
	}
	const card = await insets(page.locator(".capability-selection"));
	for (const row of rows) {
		const inset = await insets(row);
		expect(Math.abs(inset.left - card.left)).toBeLessThanOrEqual(1);
		expect(Math.abs(inset.right - card.right)).toBeLessThanOrEqual(1);
	}
}

/** 文字的计算字号、字重与颜色；颜色与同页 `var(--muted-ink)` 探针比对。 */
async function textStyle(locator: Locator) {
	return locator.evaluate((node) => {
		const probe = document.createElement("span");
		probe.style.color = "var(--muted-ink)";
		document.body.append(probe);
		const mutedInk = getComputedStyle(probe).color;
		probe.remove();
		const style = getComputedStyle(node);
		return {
			fontSize: style.fontSize,
			fontWeight: style.fontWeight,
			mutedInk: style.color === mutedInk,
		};
	});
}

/** 静态说明不在任何 live region 内（AC-2）。 */
async function inLiveRegion(locator: Locator) {
	return locator.evaluate((node) =>
		Boolean(node.closest('[role="status"], [role="alert"], [aria-live]')),
	);
}

async function expectNotBodyFocus(page: Page) {
	expect(
		await page.evaluate(() => document.activeElement === document.body),
	).toBe(false);
}

const noticeStates = [
	{
		name: "the Agent does not accept attachments",
		attachments: false,
		limits: "ready",
		copy: "当前 Agent 不支持上传控制文件，只能提交任务说明。",
	},
	{
		name: "the file limits are loading",
		attachments: true,
		limits: "pending",
		copy: "正在读取文件限制…",
	},
	{
		name: "the file limits are unavailable",
		attachments: true,
		limits: "error",
		copy: "文件限制暂不可用，上传入口已关闭。",
	},
] as const;

for (const viewport of viewports) {
	for (const state of noticeStates) {
		test(`keeps one aligned static line when ${state.name} at ${viewport.width} by ${viewport.height} (#3259 AC-1, AC-2)`, async ({
			page,
		}, info) => {
			test.skip(info.project.name !== "desktop", "Viewport list runs once.");
			const mobile = viewport.width <= 767;
			await page.setViewportSize(viewport);
			const errors = trackPageErrors(page);
			const fixture = await skillControlFileFixture(page, state);
			const { picker } = fixture;
			const notice = picker.getByText(state.copy, { exact: true });
			await expect(notice).toBeVisible();
			// 只有这一行：没有标题、禁用的入口与限制说明，播报区为空。
			await expect(picker).toHaveText(state.copy);
			await expect(
				page.getByText("Skill 控制文件", { exact: true }),
			).toHaveCount(0);
			await expect(
				page.getByRole("button", { name: "添加文本文件" }),
			).toHaveCount(0);
			await expect(page.getByText(limitCopy)).toHaveCount(0);
			await expect(page.getByLabel("添加 Skill 控制文件")).toHaveCount(0);
			expect(await inLiveRegion(notice)).toBe(false);
			await expect(picker.locator('[role="status"]')).toHaveText("");
			// 字号与 Skill 卡说明同级：12px muted-ink，单行；Skill 卡标题仍为 12px / 600。
			expect(await textStyle(notice)).toEqual({
				fontSize: "12px",
				fontWeight: "400",
				mutedInk: true,
			});
			expect(
				await textStyle(page.locator(".capability-selection strong")),
			).toMatchObject({ fontSize: "12px", fontWeight: "600" });
			const height = await picker.evaluate(
				(node) => node.getBoundingClientRect().height,
			);
			expect(height).toBeLessThanOrEqual(19);
			// 服务端拒绝后错误行出现在 Skill 卡与区块之间，三者左右边缘对齐。
			await fixture.input.fill("总结工作区变更");
			await page.getByRole("button", { name: "确认发送" }).click();
			const error = page.locator(".composer-zone .capability-error");
			await expect(error).toContainText("补充内容不符合所选项的要求");
			await expectAligned(page, mobile, [picker, error]);
			expect(await duplicateControlNames(page)).toEqual([]);
			await expectCleanPage(page, errors);
			await info.attach(
				`skill-control-files-${state.limits}-${viewport.width}`,
				{
					body: await page.screenshot({ animations: "disabled" }),
					contentType: "image/png",
				},
			);
			fixture.releaseLimits();
			expect(
				fixture.requests.filter((request) => request.startsWith("POST")),
			).toEqual([
				`POST /api/v2/conversations/${conversationId}/native-capability/invoke`,
			]);
			expect(fixture.unexpected).toEqual([]);
		});
	}

	test(`walks the upload states with aligned rows and focus kept off body at ${viewport.width} by ${viewport.height} (#3259 AC-1–AC-3)`, async ({
		page,
	}, info) => {
		test.skip(info.project.name !== "desktop", "Viewport list runs once.");
		const mobile = viewport.width <= 767;
		await page.setViewportSize(viewport);
		const errors = trackPageErrors(page);
		const fixture = await skillControlFileFixture(page, {
			attachments: true,
			limits: "pending",
		});
		const { picker } = fixture;
		await expect(picker).toHaveText("正在读取文件限制…");
		fixture.releaseLimits();
		// 支持上传：标题、「添加文本文件」与一行限制说明。
		const add = page.getByRole("button", { name: "添加文本文件" });
		await expect(add).toBeVisible();
		const title = picker.getByText("Skill 控制文件", { exact: true });
		const limit = picker.getByText(limitCopy, { exact: true });
		await expect(limit).toBeVisible();
		expect(await textStyle(title)).toMatchObject({
			fontSize: "12px",
			fontWeight: "600",
		});
		expect(await textStyle(limit)).toEqual({
			fontSize: "11px",
			fontWeight: "400",
			mutedInk: true,
		});
		expect(await textStyle(add)).toMatchObject({ fontSize: "12px" });
		expect(await inLiveRegion(limit)).toBe(false);
		await expect(add).toHaveAttribute(
			"aria-describedby",
			(await limit.getAttribute("id")) ?? "missing",
		);
		// 紧凑排列：入口与标题、说明同一行，整块不超过一个触达高度加一行窄屏换行。
		const head = await picker.evaluate((node) => {
			const rect = (selector: string) => {
				const found = node.querySelector(selector);
				if (!found) throw new Error(`Missing ${selector}`);
				return found.getBoundingClientRect();
			};
			const button = rect('[data-slot="button"]');
			const text = rect(".skill-control-files-head > div");
			return {
				height: node.getBoundingClientRect().height,
				sameRow: button.left >= text.right && button.top < text.bottom,
				buttonHeight: button.height,
			};
		});
		expect(head.sameRow).toBe(true);
		expect(head.buttonHeight).toBe(44);
		expect(head.height).toBeLessThanOrEqual(52);
		await expectAligned(page, mobile, [picker]);
		// 添加：经文件选择器选择四个文件，焦点留在「添加文本文件」。
		const chooser = page.waitForEvent("filechooser");
		await add.click();
		await (await chooser).setFiles(
			["a.txt", "hold.txt", "fail.txt", "expired.txt"].map((name) => ({
				name,
				mimeType: "text/plain",
				buffer: Buffer.from("x"),
			})),
		);
		await expect(add).toBeFocused();
		const rows = picker.getByRole("listitem");
		await expect(rows).toHaveCount(4);
		const row = (name: string) => rows.filter({ hasText: name });
		await expect(row("a.txt")).toHaveAttribute("data-file-status", "available");
		await expect(row("a.txt")).toContainText("已上传");
		await expect(row("hold.txt")).toHaveAttribute(
			"data-file-status",
			"uploading",
		);
		await expect(row("hold.txt")).toContainText("上传中…");
		await expect(row("fail.txt")).toHaveAttribute("data-file-status", "failed");
		await expect(row("fail.txt").getByRole("alert")).toHaveText(
			"上传失败，请重试。",
		);
		await expect(row("expired.txt")).toHaveAttribute(
			"data-file-status",
			"expired",
		);
		await expect(row("expired.txt").getByRole("alert")).toHaveText(
			"上传授权已过期，请重试。",
		);
		// 行内状态不是 live region；区块只有一个常驻播报区。
		await expect(rows.locator('[role="status"]')).toHaveCount(0);
		await expect(picker.locator('[role="status"]')).toHaveCount(1);
		// 每行名称可见、不被状态与操作挤没，行不越出区块。
		for (const name of ["a.txt", "hold.txt", "fail.txt", "expired.txt"]) {
			const geometry = await row(name).evaluate((node) => {
				const label = node.querySelector(".skill-control-file-name");
				const block = node.closest('[data-testid="skill-control-file-picker"]');
				if (!label || !block) throw new Error("Expected file row parts");
				const text = label.getBoundingClientRect();
				const box = node.getBoundingClientRect();
				const outer = block.getBoundingClientRect();
				return {
					labelWidth: text.width,
					fullName: label.scrollWidth <= label.clientWidth,
					inside:
						box.left >= outer.left - 0.5 && box.right <= outer.right + 0.5,
					fontSize: getComputedStyle(label).fontSize,
				};
			});
			expect(geometry).toEqual({
				labelWidth: expect.any(Number),
				fullName: true,
				inside: true,
				fontSize: "12px",
			});
			expect(geometry.labelWidth).toBeGreaterThan(20);
		}
		await expectAligned(page, mobile, [picker]);
		expect(await duplicateControlNames(page)).toEqual([]);
		await expectCleanPage(page, errors);
		await info.attach(`skill-control-files-uploads-${viewport.width}`, {
			body: await page.screenshot({ animations: "disabled" }),
			contentType: "image/png",
		});
		// 上传完成只在状态变化时播报。
		fixture.releaseUpload();
		await expect(row("hold.txt")).toHaveAttribute(
			"data-file-status",
			"available",
		);
		await expect(picker.locator('[role="status"]')).toHaveText(
			"hold.txt 已上传",
		);
		// 重试：「重试」随失败状态卸载，焦点到同一行的移除按钮。
		await page.getByRole("button", { name: "重试：fail.txt" }).click();
		await expect(row("fail.txt")).toHaveAttribute(
			"data-file-status",
			"available",
		);
		await expect(
			page.getByRole("button", { name: "移除控制文件 fail.txt" }),
		).toBeFocused();
		await expectNotBodyFocus(page);
		// 移除：行卸载后焦点回到「添加文本文件」，播报移除结果。
		await page
			.getByRole("button", { name: "移除控制文件 expired.txt" })
			.click();
		await expect(rows).toHaveCount(3);
		await expect(add).toBeFocused();
		await expect(picker.locator('[role="status"]')).toHaveText(
			"已移除 expired.txt",
		);
		// 已上传三个文件后发送，被拒绝时错误行与区块、Skill 卡对齐。
		await fixture.input.fill("总结这些控制文件");
		await page.getByRole("button", { name: "确认发送" }).click();
		const error = page.locator(".composer-zone .capability-error");
		await expect(error).toContainText("补充内容不符合所选项的要求");
		await expectAligned(page, mobile, [picker, error]);
		expect(await duplicateControlNames(page)).toEqual([]);
		await expectCleanPage(page, errors);
		expect(
			fixture.requests.filter(
				(request) => request.startsWith("POST") && request.endsWith("/files"),
			),
		).toHaveLength(5);
		expect(fixture.unexpected).toEqual([]);
	});
}
