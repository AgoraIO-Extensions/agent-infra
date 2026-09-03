import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
	component: HomeComponent,
});

function HomeComponent() {
	return (
		<main className="mx-auto flex min-h-screen max-w-5xl items-center px-6 py-16">
			<section className="space-y-6">
				<p className="font-medium text-slate-500 text-sm uppercase tracking-[0.2em]">
					Agent Infra · M1
				</p>
				<h1 className="max-w-3xl font-semibold text-4xl text-slate-950 tracking-tight sm:text-6xl">
					企业级 Agent 平台工程骨架
				</h1>
				<p className="max-w-2xl text-lg text-slate-600 leading-8">
					当前页面仅验证 Web 部署单元。产品功能将按 PRD 与工程架构 Spec
					分阶段交付。
				</p>
				<Link
					className="inline-flex min-h-11 items-center border border-slate-900 bg-slate-900 px-4 font-medium text-sm text-white transition-colors hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-slate-900 focus-visible:outline-offset-2"
					to="/agents"
				>
					查看 Agent
				</Link>
			</section>
		</main>
	);
}
