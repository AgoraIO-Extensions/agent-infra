import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui/toast";
import type { SkillHubPublicationResponseV1 } from "../../pilot/generated-v2/types.gen.js";
import {
	type SkillReviewItem,
	SkillReviewsScreen,
	skillReviewReasonMaxLength,
} from "./skill-review-screen.js";

afterEach(cleanup);

const others: SkillReviewItem = {
	skillVersionId: "incident-summary-v1",
	name: "incident-summary",
	version: "1.0.0",
	provider: "github",
	visibility: "ORGANIZATION",
	state: "pending_review",
	ownerId: "user-other",
	submitterName: "周可",
};
const own: SkillReviewItem = {
	...others,
	skillVersionId: "release-notes-v1",
	name: "release-notes",
	ownerId: "user-admin",
	submitterName: "陈昊",
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

function renderReviews({
	administrator = true,
	queue = { kind: "ready", items: [others, own] } as const,
	review = vi.fn() as never,
}: {
	administrator?: boolean;
	queue?: Parameters<typeof SkillReviewsScreen>[0]["queue"];
	review?: Parameters<typeof SkillReviewsScreen>[0]["review"] &
		ReturnType<typeof vi.fn>;
} = {}) {
	render(
		<ToastProvider>
			<SkillReviewsScreen
				isAdministrator={administrator}
				currentUserId="user-admin"
				queue={queue}
				review={review}
			/>
		</ToastProvider>,
	);
	return review;
}

async function openReview(name = "审阅：incident-summary · v1.0.0") {
	fireEvent.click(screen.getByRole("button", { name }));
	return screen.findByRole("dialog", { name: "审阅发布申请" });
}

describe("SkillReviewsScreen", () => {
	it("shows an unavailable queue instead of a manual version ID form (K-04)", () => {
		const review = renderReviews({ queue: { kind: "unavailable" } });
		expect(
			screen.getByRole("heading", { level: 1, name: "Skill 发布审核" }),
		).toBeTruthy();
		expect(screen.getByText("系统管理 / Skill 审核")).toBeTruthy();
		// Toast 宿主也是 status，这里按空态自身定位。
		expect(
			screen
				.getAllByRole("status")
				.some((item) => item.textContent?.includes("审核队列暂不可用")),
		).toBe(true);
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(screen.queryByRole("button")).toBeNull();
		expect(review).not.toHaveBeenCalled();
	});

	it("shows employees a no-permission state without any review action", () => {
		const review = renderReviews({ administrator: false });
		expect(screen.getByText("没有访问权限")).toBeTruthy();
		expect(screen.queryByRole("button")).toBeNull();
		expect(review).not.toHaveBeenCalled();
	});

	it("requires a rejection reason and does not send an empty or whitespace review", async () => {
		const review = renderReviews();
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

	it("sends a trimmed rejection reason once and reports the outcome", async () => {
		const review = vi.fn().mockResolvedValue(reviewed("rejected"));
		renderReviews({ review });
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
	});

	it("blocks the publisher from reviewing their own version (PRD §11.5)", () => {
		const review = renderReviews();
		const ownButton = screen.getByRole("button", {
			name: "审阅：release-notes · v1.0.0",
		});
		expect(ownButton.hasAttribute("disabled")).toBe(true);
		expect(ownButton.getAttribute("aria-describedby")).toBeTruthy();
		expect(
			document.getElementById(ownButton.getAttribute("aria-describedby") ?? "")
				?.textContent,
		).toBe("不能审核自己发布的版本");
		fireEvent.click(ownButton);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(review).not.toHaveBeenCalled();
	});

	it("maps a server self-review rejection to the same readable text", async () => {
		const review = vi.fn().mockRejectedValue(
			Object.assign(new Error("denied"), {
				status: 403,
				code: "owner_cannot_review",
			}),
		);
		renderReviews({ review });
		const dialog = await openReview();
		fireEvent.click(within(dialog).getByRole("button", { name: "批准发布" }));
		await waitFor(() =>
			expect(within(dialog).getByRole("alert").textContent).toBe(
				"不能审核自己发布的版本",
			),
		);
		expect(document.body.textContent).not.toContain("owner_cannot_review");
	});
});
