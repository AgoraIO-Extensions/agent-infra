import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui/toast";
import { client as generatedClient } from "../../pilot/generated-v2/client.gen.js";
import type { SkillHubPublicationResponseV1 } from "../../pilot/generated-v2/types.gen.js";
import {
	type SkillReviewItem,
	SkillReviewsScreen,
	skillReviewReasonMaxLength,
} from "./skill-review-screen.js";

// 发布者与组织名称由页面级目录读取解析：测试与生产一样经 QueryClient 读取固定目录记录。
let directoryRecords: {
	kind: "user" | "organization";
	canonicalId: string;
	displayName: string;
}[] = [];
// 审阅弹窗读取的待审正文（#3046）：默认返回一段含 HTML 的正文，用例可替换为失败或其他内容。
const reviewBody =
	"# incident-summary\n汇总事故时间线。\n<script>alert(1)</script>\n";
let reviewContent: (skillVersionId: string) => Response | Promise<Response>;
let contentReads: string[] = [];
const contentResponse = (
	skillVersionId: string,
	content: Record<string, unknown> = {
		state: "available",
		body: reviewBody,
		bodyTruncated: false,
		resources: [{ path: "scripts/run.sh", kind: "script", sizeBytes: 8 }],
	},
) => Response.json({ schemaVersion: 1, skillVersionId, content });
const protocolError = (status: number) =>
	Response.json(
		{
			schemaVersion: 1,
			code: status === 503 ? "DEPENDENCY_UNAVAILABLE" : "RESOURCE_UNAVAILABLE",
			message: "Skill review content fixture",
			retryable: status === 503,
			traceId: "trace-skill-review",
		},
		{ status },
	);
beforeEach(() => {
	directoryRecords = [
		{ kind: "user", canonicalId: "user-other", displayName: "周可" },
		{ kind: "user", canonicalId: "user-admin", displayName: "陈昊" },
		{
			kind: "organization",
			canonicalId: "org-release",
			displayName: "发布工程",
		},
	];
	contentReads = [];
	reviewContent = (skillVersionId) => contentResponse(skillVersionId);
	// 待审正文经生成的 v2 client 读取；测试环境没有页面来源，给出固定的平台地址。
	generatedClient.setConfig({ baseUrl: "https://platform.test" });
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request) => {
			const url = new URL(
				input instanceof Request ? input.url : String(input),
				"http://localhost",
			);
			const content = url.pathname.match(
				/^\/api\/v2\/skills\/reviews\/([^/]+)\/content$/,
			);
			if (content) {
				contentReads.push(url.pathname + url.search);
				return reviewContent(decodeURIComponent(content[1] ?? ""));
			}
			const ids = url.searchParams.get("ids")?.split(",") ?? [];
			return Response.json({
				items: directoryRecords.filter(
					(item) =>
						item.kind === url.searchParams.get("kind") &&
						ids.includes(item.canonicalId),
				),
			});
		}),
	);
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const others: SkillReviewItem = {
	schemaVersion: 1,
	skillId: "incident-summary",
	skillVersionId: "incident-summary-v1",
	name: "incident-summary",
	version: "1.0.0",
	provider: "github",
	packageDigest: "a".repeat(64),
	manifestDigest: "b".repeat(64),
	signatureDigest: "c".repeat(64),
	visibility: "ORGANIZATION",
	organizationId: "org-release",
	state: "pending_review",
	ownerId: "user-other",
	submittedAt: "2026-10-01T08:00:00Z",
};
const own: SkillReviewItem = {
	...others,
	skillId: "release-notes",
	skillVersionId: "release-notes-v1",
	name: "release-notes",
	visibility: "MARKET",
	organizationId: null,
	ownerId: "user-admin",
};

function reviewed(
	state: SkillHubPublicationResponseV1["version"]["state"],
): SkillHubPublicationResponseV1 {
	return {
		replayed: false,
		version: {
			schemaVersion: 1,
			skillId: "incident-summary",
			skillVersionId: others.skillVersionId,
			provider: "github",
			version: "1.0.0",
			packageDigest: "a".repeat(64),
			manifestDigest: "b".repeat(64),
			signatureDigest: "c".repeat(64),
			visibility: "ORGANIZATION",
			state,
			needUpgrade: false,
			reviewedBy: "user-admin",
			reviewReason: null,
			revokedAt: null,
		},
	};
}

type ScreenProps = Parameters<typeof SkillReviewsScreen>[0];

function renderReviews({
	administrator = true,
	queue = { kind: "ready", items: [others, own] } as const,
	review = vi.fn() as never,
	onReviewed = vi.fn<() => void>(),
	onRetry,
}: {
	administrator?: boolean;
	queue?: ScreenProps["queue"];
	review?: ScreenProps["review"] & ReturnType<typeof vi.fn>;
	onReviewed?: ReturnType<typeof vi.fn<() => void>>;
	onRetry?: ReturnType<typeof vi.fn<() => void>>;
} = {}) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	render(
		<QueryClientProvider client={client}>
			<ToastProvider>
				<SkillReviewsScreen
					isAdministrator={administrator}
					currentUserId="user-admin"
					queue={queue}
					review={review}
					onReviewed={onReviewed}
					onRetry={onRetry}
				/>
			</ToastProvider>
		</QueryClientProvider>,
	);
	return { review, onReviewed, client };
}

async function openReview(name = "审阅：incident-summary · v1.0.0") {
	fireEvent.click(await screen.findByRole("button", { name }));
	return screen.findByRole("dialog", { name: "审阅发布申请" });
}

describe("SkillReviewsScreen", () => {
	it("lists pending versions with publisher, scope, source and submission time (K-04)", async () => {
		renderReviews();
		expect(
			screen.getByRole("heading", { level: 1, name: "Skill 发布审核" }),
		).toBeTruthy();
		expect(screen.getByText("系统管理 / Skill 审核")).toBeTruthy();
		const row = screen
			.getByRole("heading", { level: 2, name: "incident-summary" })
			.closest("article");
		if (!row) throw new Error("review row missing");
		await waitFor(() =>
			expect(row.textContent).toContain(
				"周可申请 · 组织共享：发布工程 · GitHub · ",
			),
		);
		expect(within(row).getByText("待审核")).toBeTruthy();
		// V-06：说明行下是 quiet-pill，陈述与弹窗「权限声明」相同的平台规则。
		const pill = row.querySelector(".quiet-pill");
		expect(pill?.textContent).toBe("脚本禁用 · 仅使用 Agent 已有权限");
		expect(pill?.previousElementSibling?.tagName).toBe("P");
		expect(row.querySelector("time")?.getAttribute("dateTime")).toBe(
			others.submittedAt,
		);
		const dialog = await openReview();
		expect(within(dialog).getByText("周可")).toBeTruthy();
		expect(within(dialog).getByText("组织共享：发布工程")).toBeTruthy();
		expect(dialog.querySelector("time")).toBeTruthy();
		// 原始枚举、摘要和内部 ID 不出现在页面上。
		expect(document.body.textContent).not.toMatch(
			/pending_review|ORGANIZATION|org-release|user-other|aaaaaaaa/,
		);
	});

	it("shows a loading state, then a retryable read failure with a recovery action", () => {
		renderReviews({ queue: { kind: "loading" } });
		expect(screen.getByText("正在读取待审核版本…")).toBeTruthy();
		cleanup();
		const onRetry = vi.fn<() => void>();
		renderReviews({
			queue: { kind: "unavailable", retryable: true },
			onRetry,
		});
		expect(screen.getByRole("alert").textContent).toContain(
			"暂时无法读取审核队列",
		);
		fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
		expect(onRetry).toHaveBeenCalledOnce();
		cleanup();
		renderReviews({
			queue: { kind: "unavailable", retryable: false, reason: "denied" },
		});
		expect(screen.getByText("没有读取权限")).toBeTruthy();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("shows an empty queue without any review action", () => {
		renderReviews({ queue: { kind: "ready", items: [] } });
		expect(screen.getByText("当前没有待审核版本")).toBeTruthy();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("shows employees a no-permission state without any review action", () => {
		const { review } = renderReviews({ administrator: false });
		expect(screen.getByText("没有访问权限")).toBeTruthy();
		expect(screen.queryByRole("button")).toBeNull();
		expect(review).not.toHaveBeenCalled();
	});

	it("spaces a Latin submitter name before 申请 and keeps Han names joined", async () => {
		directoryRecords[0] = {
			kind: "user",
			canonicalId: "user-other",
			displayName: "Alex Chen",
		};
		renderReviews();
		await waitFor(() => {
			const lines = [...document.querySelectorAll(".skill-row-copy > p")].map(
				(line) => line.textContent,
			);
			expect(lines.some((line) => line?.startsWith("Alex Chen 申请 · "))).toBe(
				true,
			);
			expect(lines.some((line) => line?.startsWith("陈昊申请 · "))).toBe(true);
			expect(lines.some((line) => line?.includes("Chen申请"))).toBe(false);
		});
	});

	it("keeps an unresolved publisher identifiable for administrators", async () => {
		directoryRecords = [];
		renderReviews({ queue: { kind: "ready", items: [others] } });
		await waitFor(() =>
			expect(document.body.textContent).toContain("未识别的用户申请"),
		);
		expect(screen.getByTitle("user-other")).toBeTruthy();
	});

	it("requires a rejection reason and does not send an empty or whitespace review", async () => {
		const { review } = renderReviews();
		const dialog = await openReview();
		const reason = within(dialog).getByLabelText("审核说明 · 驳回时必填");
		fireEvent.click(within(dialog).getByRole("button", { name: "驳回" }));
		expect(review).not.toHaveBeenCalled();
		expect(within(dialog).getByRole("alert").textContent).toBe(
			"请填写驳回原因。",
		);
		expect(reason.getAttribute("aria-invalid")).toBe("true");
		expect(document.activeElement).toBe(reason);
		fireEvent.change(reason, { target: { value: "   " } });
		fireEvent.click(within(dialog).getByRole("button", { name: "驳回" }));
		expect(review).not.toHaveBeenCalled();
		expect(reason.getAttribute("maxlength")).toBe(
			String(skillReviewReasonMaxLength),
		);
	});

	it("sends a trimmed rejection reason once, shows the new state and re-reads the queue", async () => {
		const review = vi.fn().mockResolvedValue(reviewed("rejected"));
		const { onReviewed } = renderReviews({ review });
		const dialog = await openReview();
		fireEvent.change(within(dialog).getByLabelText("审核说明 · 驳回时必填"), {
			target: { value: "  缺少使用说明  " },
		});
		fireEvent.click(within(dialog).getByRole("button", { name: "驳回" }));
		await waitFor(() => expect(review).toHaveBeenCalledOnce());
		expect(review).toHaveBeenCalledWith(
			others.skillVersionId,
			{ decision: "reject", reason: "缺少使用说明" },
			expect.any(String),
		);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(screen.getByText("已驳回，发布者可修改后重提")).toBeTruthy();
		expect(screen.getByText("已驳回")).toBeTruthy();
		expect(onReviewed).toHaveBeenCalledOnce();
		// 已处理的版本不能再次打开审阅。
		expect(
			screen
				.getByRole("button", { name: "审阅：incident-summary · v1.0.0" })
				.hasAttribute("disabled"),
		).toBe(true);
	});

	it("approves without a reason and re-reads the queue", async () => {
		const review = vi.fn().mockResolvedValue(reviewed("published"));
		const { onReviewed } = renderReviews({ review });
		const dialog = await openReview();
		fireEvent.click(within(dialog).getByRole("button", { name: "批准发布" }));
		await waitFor(() => expect(onReviewed).toHaveBeenCalledOnce());
		expect(review).toHaveBeenCalledWith(
			others.skillVersionId,
			{ decision: "approve" },
			expect.any(String),
		);
		expect(
			screen.getByText("版本已批准发布，现有绑定继续使用原版本"),
		).toBeTruthy();
		expect(screen.getByText("已发布")).toBeTruthy();
	});

	it("hides the review action on the publisher's own version (PRD §11.5)", async () => {
		const { review } = renderReviews();
		await screen.findByRole("button", {
			name: "审阅：incident-summary · v1.0.0",
		});
		const ownRow = screen
			.getByRole("heading", { level: 2, name: "release-notes" })
			.closest("article");
		if (!ownRow) throw new Error("own row missing");
		expect(within(ownRow).queryByRole("button", { name: /审阅/ })).toBeNull();
		expect(within(ownRow).getByText("不能审核自己发布的版本")).toBeTruthy();
		expect(screen.getAllByRole("button", { name: /^审阅/ })).toHaveLength(1);
		expect(review).not.toHaveBeenCalled();
	});

	it("maps a server self-review rejection to the same readable text", async () => {
		const review = vi.fn().mockRejectedValue(
			Object.assign(new Error("denied"), {
				status: 403,
				code: "owner_cannot_review",
			}),
		);
		const { onReviewed } = renderReviews({ review });
		const dialog = await openReview();
		fireEvent.click(within(dialog).getByRole("button", { name: "批准发布" }));
		await waitFor(() =>
			expect(within(dialog).getByRole("alert").textContent).toBe(
				"不能审核自己发布的版本",
			),
		);
		expect(document.body.textContent).not.toContain("owner_cannot_review");
		expect(onReviewed).not.toHaveBeenCalled();
	});

	it("re-reads the queue when the version was already handled elsewhere", async () => {
		const review = vi
			.fn()
			.mockRejectedValue(
				Object.assign(new Error("conflict"), { status: 409, retryable: false }),
			);
		const { onReviewed } = renderReviews({ review });
		const dialog = await openReview();
		fireEvent.click(within(dialog).getByRole("button", { name: "批准发布" }));
		await waitFor(() =>
			expect(within(dialog).getByRole("alert").textContent).toBe(
				"版本状态已变化，队列已重新读取。",
			),
		);
		expect(onReviewed).toHaveBeenCalledOnce();
		// 冲突时不在本行假定新状态，等待队列回读。
		expect(screen.getAllByText("待审核")).toHaveLength(2);
	});
});

// 审阅弹窗的待审正文（#3046）：事实列表下方纯文本显示，读取中、失败、无权、不可用与截断分别反馈。
describe("SkillReviewDialog pending SKILL.md", () => {
	async function codeRegion(dialog: HTMLElement) {
		return within(dialog).findByRole("region", { name: "SKILL.md 正文" });
	}

	it("shows the pending body as plain text below the facts and above the review reason", async () => {
		// 先挂起响应，确定地观察读取中的反馈，再放行。
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		reviewContent = async (skillVersionId) => {
			await held;
			return contentResponse(skillVersionId);
		};
		renderReviews();
		const dialog = await openReview();
		expect((await within(dialog).findByRole("status")).textContent).toBe(
			"正在读取 SKILL.md 正文…",
		);
		expect(dialog.querySelector(".skill-code")).toBeNull();
		release();
		const region = await codeRegion(dialog);
		const pre = region.querySelector("pre");
		// 正文按原样显示为文本，其中的 HTML 不被解析，脚本不执行。
		expect(pre?.textContent).toBe(reviewBody);
		expect(region.querySelector("script")).toBeNull();
		expect(document.querySelector("script")).toBeNull();
		const facts = dialog.querySelector("dl");
		const reason = within(dialog).getByLabelText("审核说明 · 驳回时必填");
		if (!facts || !pre) throw new Error("dialog layout missing");
		expect(
			facts.compareDocumentPosition(pre) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			pre.compareDocumentPosition(reason) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		// 只提交版本 ID，不带主体或其他查询参数。
		expect(contentReads).toEqual([
			"/api/v2/skills/reviews/incident-summary-v1/content",
		]);
		expect(within(dialog).queryByRole("alert")).toBeNull();
		expect(within(dialog).queryByText(/正文较长/)).toBeNull();
	});

	it("does not read any body for the publisher's own version", async () => {
		renderReviews({ queue: { kind: "ready", items: [own] } });
		await screen.findByText("不能审核自己发布的版本");
		expect(screen.queryByRole("button", { name: /^审阅/ })).toBeNull();
		expect(contentReads).toEqual([]);
	});

	it("offers a distinct recovery action after a retryable failure and keeps focus inside the dialog", async () => {
		const statuses = [503];
		reviewContent = (skillVersionId) => {
			const status = statuses.shift();
			return status ? protocolError(status) : contentResponse(skillVersionId);
		};
		renderReviews();
		const dialog = await openReview();
		const alert = await within(dialog).findByRole("alert");
		expect(alert.textContent).toContain(
			"暂时无法读取 SKILL.md 正文，可以稍后重新读取。",
		);
		// 弹窗内只有一个恢复操作，名称与页面其他控件不同。
		expect(
			within(dialog).getAllByRole("button", { name: "重新读取正文" }),
		).toHaveLength(1);
		expect(screen.queryByRole("button", { name: "重新读取" })).toBeNull();
		fireEvent.click(
			within(dialog).getByRole("button", { name: "重新读取正文" }),
		);
		expect(document.activeElement).not.toBe(document.body);
		expect(dialog.contains(document.activeElement)).toBe(true);
		await codeRegion(dialog);
		expect(within(dialog).queryByRole("alert")).toBeNull();
		expect(document.activeElement).not.toBe(document.body);
		expect(contentReads).toHaveLength(2);
	});

	it("tells no permission and a handled version apart from a read failure", async () => {
		for (const [status, text] of [
			[403, "当前账号没有读取待审正文的权限。"],
			[404, "这个版本已不在待审核状态，正文不再提供。"],
		] as const) {
			reviewContent = () => protocolError(status);
			renderReviews();
			const dialog = await openReview();
			await waitFor(() =>
				expect(within(dialog).getByRole("alert").textContent).toBe(text),
			);
			// 无权与已处理不可重试，不提供重新读取。
			expect(
				within(dialog).queryByRole("button", { name: "重新读取正文" }),
			).toBeNull();
			expect(dialog.querySelector(".skill-code")).toBeNull();
			cleanup();
		}
		// 响应不符合契约时不显示任何正文。
		reviewContent = () =>
			Response.json({
				schemaVersion: 1,
				skillVersionId: "another-version",
				content: {
					state: "available",
					body: "x",
					bodyTruncated: false,
					resources: [],
				},
			});
		renderReviews();
		const dialog = await openReview();
		await waitFor(() =>
			expect(within(dialog).getByRole("alert").textContent).toBe(
				"待审正文暂时无法访问，请联系管理员。",
			),
		);
		expect(dialog.querySelector(".skill-code")).toBeNull();
	});

	it("reports unavailable content, an empty body and truncation separately", async () => {
		reviewContent = (skillVersionId) =>
			contentResponse(skillVersionId, { state: "unavailable" });
		renderReviews();
		let dialog = await openReview();
		await waitFor(() =>
			expect(within(dialog).getByRole("status").textContent).toBe(
				"这个版本的正文暂时无法读取，其余审核信息不受影响。",
			),
		);
		expect(within(dialog).queryByRole("alert")).toBeNull();
		cleanup();
		reviewContent = (skillVersionId) =>
			contentResponse(skillVersionId, {
				state: "available",
				body: "",
				bodyTruncated: false,
				resources: [],
			});
		renderReviews();
		dialog = await openReview();
		expect(await within(dialog).findByText("SKILL.md 没有正文。")).toBeTruthy();
		cleanup();
		reviewContent = (skillVersionId) =>
			contentResponse(skillVersionId, {
				state: "available",
				body: "y".repeat(2_000),
				bodyTruncated: true,
				resources: [],
			});
		renderReviews();
		dialog = await openReview();
		const region = await codeRegion(dialog);
		expect(region.textContent).toBe("y".repeat(2_000));
		expect(
			within(dialog).getByText("正文较长，这里只显示开头部分（64 KiB）。"),
		).toBeTruthy();
	});

	it("re-reads the body on reopen and drops it from the cache after closing", async () => {
		const { client } = renderReviews();
		let dialog = await openReview();
		await codeRegion(dialog);
		fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		await waitFor(() =>
			expect(
				client
					.getQueryCache()
					.findAll({ queryKey: ["skill-hub", "review-content"] }),
			).toHaveLength(0),
		);
		dialog = await openReview();
		await codeRegion(dialog);
		expect(contentReads).toHaveLength(2);
	});
});
