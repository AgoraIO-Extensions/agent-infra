import { useState } from "react";
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
				className="platform-nav-item w-full justify-start"
				onClick={() => void submit()}
				disabled={state === "submitting"}
			>
				{state === "submitting" ? "正在退出…" : "退出登录"}
			</Button>
			{state === "error" && (
				<p className="px-3 text-destructive text-sm" role="status">
					退出登录失败，请重试。
				</p>
			)}
		</div>
	);
}
