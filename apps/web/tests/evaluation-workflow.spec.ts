import { expect, type Page, test } from "@playwright/test";
import type { EvaluationBrowserFixture } from "./evaluation-fixture.js";
import { recordStartupEvidence } from "./page-health.js";

type Fixture = EvaluationBrowserFixture;

test("real purpose-isolated evaluation, version history and online feedback", async ({
	page,
	context,
}, info) => {
	test.setTimeout(240_000);
	page.setDefaultTimeout(15_000);
	const support = (await import(
		new URL(
			"../../platform-api/src/evaluation-workflow.browser-test-support.ts",
			import.meta.url,
		).href
	)) as {
		startEvaluationWorkflowBrowserFixture: () => Promise<EvaluationBrowserFixture>;
	};
	const fixture = await support.startEvaluationWorkflowBrowserFixture();
	const requests: { method: string; path: string; status: number }[] = [];
	async function login(role: keyof Fixture["roles"], path = "/eval") {
		await context.addCookies([
			{
				name: "session",
				value: fixture.roles[role],
				domain: "127.0.0.1",
				path: "/",
			},
		]);
		await page.goto(path);
		if (path === "/eval") {
			const nav = page.getByRole("navigation", { name: "工作区", exact: true });
			const entry = nav.getByRole("link", { name: "评测", exact: true });
			if (info.project.name === "mobile")
				await page.getByRole("button", { name: /打开导航/ }).click();
			await entry.click();
		}
	}
	try {
		await page.route("**/api/**", async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			const response = await fetch(
				`${fixture.origin}${url.pathname}${url.search}`,
				{
					method: request.method(),
					headers: request.headers(),
					...(request.postDataBuffer()
						? { body: new Uint8Array(request.postDataBuffer() ?? []) }
						: {}),
					redirect: "manual",
				},
			);
			requests.push({
				method: request.method(),
				path: url.pathname + url.search,
				status: response.status,
			});
			await route.fulfill({
				status: response.status,
				headers: Object.fromEntries(response.headers),
				body:
					response.headers.get("content-type")?.includes("text/event-stream") &&
					response.body
						? await firstEventChunk(response.body)
						: Buffer.from(await response.arrayBuffer()),
			});
		});
		async function run(versionId: string) {
			await page.getByRole("tab", { name: "实验", exact: true }).click();
			await page
				.getByLabel("评测版本", { exact: true })
				.selectOption(`${fixture.datasetId}/${versionId}`);
			await page.getByLabel("基线", { exact: true }).selectOption("baseline");
			await page.getByRole("checkbox", { name: /model_candidate/ }).check();
			for (const scorer of ["rule", "human", "model"])
				await page
					.getByRole("checkbox", { name: new RegExp(`^${scorer} ·`) })
					.check();
			await expect(
				page.getByText(/费用归属：样本运行及模型评分/),
			).toBeVisible();
			const accepted = page.waitForResponse(
				(r) =>
					r.url().endsWith("/api/v2/evaluation/experiments") &&
					r.request().method() === "POST",
			);
			await page.getByRole("button", { name: "创建实验", exact: true }).click();
			const response = await accepted;
			expect(response.status()).toBe(201);
			const experiment = (await response.json()) as {
				experimentId: string;
				versionId: string;
			};
			expect(experiment.versionId).toBe(versionId);
			await fixture.tick();
			await page.getByRole("button", { name: "刷新运行进度" }).click();
			await expect(
				page.getByRole("region", { name: "实验执行进度" }),
			).toContainText("已完成");
			return experiment.experimentId;
		}
		await login("runner");
		const first = await run(fixture.versionId);
		await page.getByRole("button", { name: "查看分析", exact: true }).click();
		await expect(
			page.getByRole("region", { name: "实验分析结果" }).getByRole("alert"),
		).toBeVisible();
		expect(
			requests.some((r) => r.path.includes("/analysis") && r.status === 200),
		).toBe(false);
		await login("grader");
		await page.getByRole("tab", { name: "实验", exact: true }).click();
		const human = page
			.getByRole("listitem")
			.filter({ hasText: "human" })
			.first();
		const humanContextResponse = page.waitForResponse(
			(r) => r.url().includes("/scores/") && r.url().endsWith("/content"),
		);
		await human.getByRole("button", { name: /打开评分/ }).click();
		const humanContext = (await (await humanContextResponse).json()) as {
			scoreId: string;
			sampleTaskId: string;
		};
		await page.getByLabel(/分数（/).fill("1");
		await page
			.getByLabel("判定依据", { exact: true })
			.fill("Synthetic human judgment");
		await page.getByRole("button", { name: "保存人工评分" }).click();
		await expect(page.getByText("人工评分已保存。")).toBeVisible();
		await login("reviewer");
		await page.getByRole("tab", { name: "实验", exact: true }).click();
		await page.getByLabel("工作用途").selectOption("review");
		await page
			.getByRole("button", {
				name: `打开复核 ${humanContext.scoreId}`,
				exact: true,
			})
			.click();
		await expect(
			page.getByRole("region", { name: "原评分结论" }),
		).toContainText("Synthetic human judgment");
		await page.getByLabel(/分数（/).fill("0");
		await page
			.getByLabel("判定依据", { exact: true })
			.fill("Synthetic independent review");
		await page.getByRole("button", { name: "保存独立复核" }).click();
		await expect(
			page.getByRole("region", { name: "独立复核历史" }),
		).toContainText("Synthetic independent review");
		await expect(
			page.getByRole("region", { name: "原评分结论" }),
		).toContainText("Synthetic human judgment");
		await login("analyst");
		await page.getByRole("tab", { name: "实验", exact: true }).click();
		const summaryResponse = page.waitForResponse((r) =>
			r.url().endsWith(`/analysis/${first}`),
		);
		await page
			.getByRole("button", { name: `分析实验 ${first}`, exact: true })
			.click();
		const summary = (await (await summaryResponse).json()) as {
			items: Array<{
				sampleTaskId: string;
				sampleId: string;
				variantId: string;
			}>;
		};
		const reviewedTask = summary.items.find(
			(item) => item.sampleTaskId === humanContext.sampleTaskId,
		);
		if (!reviewedTask) throw new Error("Missing reviewed sample task");
		const analysis = page.getByRole("region", { name: "实验分析结果" });
		await expect(analysis).toContainText("固定样本集合：1");
		await expect(analysis).toContainText("模型累计耗时（可能并行）");
		await analysis
			.getByRole("button", {
				name: `查看样本 ${reviewedTask.sampleId} ${reviewedTask.variantId}`,
				exact: true,
			})
			.click();
		await expect(
			page.getByRole("region", { name: "获准样本详情" }),
		).toContainText("Synthetic human judgment");
		await expect(
			page.getByRole("region", { name: "获准样本详情" }),
		).toContainText("Synthetic independent review");
		await page.screenshot({
			path: info.outputPath("evaluation-analysis.png"),
			fullPage: true,
		});
		// Maintenance creates a new immutable version; it receives its own explicit grants.
		await login("manager");
		await page
			.getByRole("button", {
				name: `基于版本 ${fixture.versionId} 创建新版本`,
				exact: true,
			})
			.click();
		await expect(
			page.getByLabel("待授权或导入版本").locator("option"),
		).toHaveCount(3);
		const versions = await page
			.getByLabel("待授权或导入版本")
			.locator("option")
			.evaluateAll((nodes) =>
				nodes.map((n) => (n as HTMLOptionElement).value).filter(Boolean),
			);
		const secondVersion = versions.find((v) => v !== fixture.versionId);
		if (!secondVersion) throw new Error("Missing reserved version");
		await page.getByLabel("待授权或导入版本").selectOption(secondVersion);
		await page.getByRole("button", { name: "选择当前用户" }).click();
		await page
			.getByLabel("授权到期时间（UTC ISO）")
			.fill(new Date(Date.now() + 900000).toISOString());
		async function grant() {
			const response = page.waitForResponse(
				(r) => r.url().includes("/grants") && r.request().method() === "POST",
			);
			await page.getByRole("button", { name: "显式授予用途权限" }).click();
			expect((await response).status()).toBe(201);
			await expect(
				page.getByRole("button", { name: "显式授予用途权限" }),
			).toBeEnabled();
		}
		await grant();
		await page.getByLabel("获准的样本与判定标准 JSON").fill(
			JSON.stringify({
				...fixture.content,
				samples: fixture.content.samples.map((s) => ({
					...s,
					input: "Synthetic second version question",
				})),
			}),
		);
		const imported = page.waitForResponse(
			(r) =>
				r.url().includes(`/versions/${secondVersion}/content`) &&
				r.request().method() === "PUT",
		);
		await page.getByRole("button", { name: "导入所选版本" }).click();
		expect((await imported).ok()).toBe(true);
		async function grantRole(role: "runner" | "analyst", purposes: string[]) {
			const picker = page.getByRole("combobox", {
				name: "授权接收用户",
				exact: true,
			});
			await picker.fill(fixture.roles[role]);
			await page
				.getByRole("option")
				.filter({ hasText: fixture.roles[role] })
				.click();
			for (const [id, label] of [
				["import", "导入"],
				["read", "读取内容"],
				["delete", "删除"],
				["run", "运行"],
				["score", "评分"],
				["analyze", "分析"],
			]) {
				await page
					.getByRole("checkbox", { name: label, exact: true })
					.setChecked(purposes.includes(id));
			}
			await grant();
		}
		await grantRole("runner", ["run", "score"]);
		await grantRole("analyst", ["analyze"]);
		await login("runner");
		const second = await run(secondVersion);
		expect(second).not.toBe(first);
		await login("analyst");
		await page.getByRole("tab", { name: "实验", exact: true }).click();
		await expect(
			page.getByRole("button", { name: `分析实验 ${second}`, exact: true }),
		).toBeVisible();
		await page
			.getByRole("button", { name: `分析实验 ${first}`, exact: true })
			.click();
		await page
			.getByRole("button", { name: /查看样本 answer/ })
			.first()
			.click();
		await expect(
			page.getByRole("region", { name: "获准样本详情" }),
		).toContainText("Synthetic question");
		await expect(
			page.getByRole("region", { name: "获准样本详情" }),
		).not.toContainText("Synthetic second version question");
		const online = await fixture.createOnlineTask();
		await fixture.createOnlineTask();
		await login("runner", `/chat/${fixture.agentId}/${online.conversationId}`);
		await page
			.getByRole("button", { name: /任务反馈/ })
			.first()
			.click();
		await page.getByRole("button", { name: "有用", exact: true }).click();
		await page.getByRole("button", { name: "提交反馈", exact: true }).click();
		await expect(page.getByText("反馈已保存。")).toBeVisible();
		async function feedback(view: "self" | "owner") {
			await page.getByRole("tab", { name: "反馈", exact: true }).click();
			await page.getByLabel("查看范围").selectOption(view);
			await page
				.getByLabel("Agent", { exact: true })
				.selectOption(fixture.agentId);
			const tomorrow = new Date(Date.now() + 86400000);
			const local = new Date(+tomorrow - tomorrow.getTimezoneOffset() * 60000)
				.toISOString()
				.slice(0, 16);
			await page.getByLabel("确认终态结束时间（不含，本地）").fill(local);
			await page.getByRole("button", { name: "查询反馈汇总" }).click();
			const result = page.getByRole("region", { name: "反馈汇总结果" });
			for (const [label, value] of [
				["可反馈任务", "2"],
				["已反馈任务", "1"],
				["未反馈任务", "1"],
				["反馈率", "50.0%"],
			]) {
				await expect(
					result
						.locator("dl > div")
						.filter({ has: page.getByText(label, { exact: true }) })
						.locator("dd"),
				).toHaveText(value);
			}
			return result;
		}
		await login("runner");
		await feedback("self");
		await login("owner");
		const owner = await feedback("owner");
		await expect(owner).toContainText("Owner 授权汇总（无他人任务或正文下钻）");
		await expect(owner).not.toContainText(online.executionId);
		await expect(owner).not.toContainText("Synthetic feedback task");
		await page.screenshot({
			path: info.outputPath("evaluation-feedback.png"),
			fullPage: true,
		});
		expect(fixture.modelCalls()).toBeGreaterThan(0);
		expect(fixture.runtimeCalls()).toBeGreaterThan(0);
		await expectNoHorizontalOverflow(page);
	} catch (error) {
		await startupEvidence.get(page)?.attach(info);
		if (!page.isClosed()) {
			await info.attach("synthetic-page", {
				body: await page.locator("body").innerText(),
				contentType: "text/plain",
			});
			await page.screenshot({
				path: info.outputPath("failure.png"),
				fullPage: true,
			});
		}
		await info.attach("api-statuses", {
			body: JSON.stringify(requests),
			contentType: "application/json",
		});
		throw error;
	} finally {
		startupEvidence.get(page)?.dispose();
		startupEvidence.delete(page);
		try {
			if (!page.isClosed()) await page.goto("about:blank");
		} finally {
			try {
				await page.unrouteAll({ behavior: "ignoreErrors" });
			} finally {
				await fixture.close();
			}
		}
	}
});
async function expectNoHorizontalOverflow(page: Page) {
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth + 1,
		),
	).toBe(true);
}

async function firstEventChunk(body: ReadableStream<Uint8Array>) {
	const reader = body.getReader();
	try {
		const chunk = await reader.read();
		return Buffer.from(chunk.value ?? []);
	} finally {
		await reader.cancel();
	}
}

// 首屏偶发白屏的失败证据，保留原断言、超时和执行并发。
const startupEvidence = new WeakMap<
	Page,
	ReturnType<typeof recordStartupEvidence>
>();
test.beforeEach(async ({ page }, info) => {
	if (
		info.title ===
		"real purpose-isolated evaluation, version history and online feedback"
	)
		startupEvidence.set(page, recordStartupEvidence(page));
});
test.afterEach(async ({ page }, info) => {
	const startup = startupEvidence.get(page);
	if (info.status !== info.expectedStatus) await startup?.attach(info);
	startup?.dispose();
});
