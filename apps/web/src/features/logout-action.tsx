import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

type LogoutActionProps = {
	endpoint: string;
	onLoggedOut: () => Promise<unknown> | unknown;
};

export function LogoutAction({ endpoint, onLoggedOut }: LogoutActionProps) {
	const [state, setState] = useState<"idle" | "submitting" | "error">("idle");

	async function submit() {
		setState("submitting");
		try {
			const target = new URL(endpoint, window.location.href);
			if (target.origin !== window.location.origin)
				throw new Error("Logout must use the same origin");
			const response = await fetch(target.href, {
				method: "POST",
				credentials: "include",
				headers: { "X-Platform-CSRF": "1" },
			});
			if (!response.ok) throw new Error(`Logout failed: ${response.status}`);
			try {
				await onLoggedOut();
				setState("idle");
			} catch {
				window.location.reload();
			}
		} catch {
			setState("error");
		}
	}

	return (
		<div className="space-y-1">
			<Button
				type="button"
				variant="ghost"
				// 与相邻导航项同为 13px / 400 / muted、悬停为 --fg（.platform-nav-action，#3267 N8-1-01）。
				className="platform-nav-item platform-nav-action w-full justify-start"
				onClick={() => void submit()}
				// 退出进行中是可聚焦的禁用（aria-disabled），焦点留在按钮上；失败后仍在按钮上（#3242 K7-02）。
				disabled={state === "submitting"}
				focusableWhenDisabled
			>
				{state === "submitting" ? "正在退出…" : "退出登录"}
			</Button>
			{/* 退出失败是操作结果：role="alert"，12px --danger-ink，左缘与导航项文字对齐。 */}
			{state === "error" && (
				<Alert
					tone="danger"
					role="alert"
					icon={null}
					className="platform-nav-action-error"
				>
					退出登录失败，请重试。
				</Alert>
			)}
		</div>
	);
}
