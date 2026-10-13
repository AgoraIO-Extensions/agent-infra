import { createFileRoute, redirect } from "@tanstack/react-router";

// 缺少 Agent 的对话地址转到选择 Agent 的对话入口，与导航中的「对话」一致（#2297）。
export const Route = createFileRoute("/chat/")({
	beforeLoad: () => {
		throw redirect({
			to: "/agents",
			search: { mode: "conversation" },
			replace: true,
		});
	},
});
