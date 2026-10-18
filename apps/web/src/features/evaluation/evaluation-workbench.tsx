import { FlaskConical, LockKeyhole, MessageSquareText } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";

type EvaluationSection = "experiments" | "datasets" | "feedback";

const sections: Array<{
	id: EvaluationSection;
	label: string;
	title: string;
	description: string;
}> = [
	{
		id: "experiments",
		label: "实验",
		title: "比较基线与候选配置。",
		description:
			"实验会固定数据集、Agent 配置和评分版本，保留每次运行的可追溯结果。",
	},
	{
		id: "datasets",
		label: "数据集与标准",
		title: "管理可复用的评测材料。",
		description:
			"样本和判定标准按版本保存，修改后以新版本运行，历史结论继续可读。",
	},
	{
		id: "feedback",
		label: "线上反馈",
		title: "把用户反馈与离线评分分开看。",
		description:
			"只统计当前用户自己的任务反馈，不把未反馈当作认可，也不混入离线通过率。",
	},
];

export function EvaluationWorkbench({
	userDisplayName,
	isAdministrator,
}: {
	userDisplayName: string;
	isAdministrator: boolean;
}) {
	const [section, setSection] = useState<EvaluationSection>("experiments");
	const current = sections.find((item) => item.id === section) ?? sections[0];

	return (
		<div className="space-y-8">
			<header className="page-heading">
				<div className="min-w-0">
					<p className="page-eyebrow">系统管理 / 评测</p>
					<h1>用证据比较 Agent 效果。</h1>
					<p>
						{userDisplayName || "当前用户"}{" "}
						的评测材料、实验和线上反馈将在同一处汇总；正文、凭证和思考不会进入评测摘要。
					</p>
				</div>
				<Badge variant="tag">
					{isAdministrator ? "管理员视图" : "个人视图"}
				</Badge>
			</header>

			<nav className="scope-tabs" aria-label="评测区域">
				{sections.map((item) => (
					<Button
						key={item.id}
						variant={item.id === section ? "outline" : "ghost"}
						onClick={() => setSection(item.id)}
						aria-current={item.id === section ? "page" : undefined}
					>
						{item.label}
					</Button>
				))}
			</nav>

			<section
				className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]"
				aria-live="polite"
			>
				<div className="rounded-[14px] border bg-card p-6 shadow-sm">
					<div className="mb-6 flex items-start justify-between gap-4">
						<div>
							<p className="page-eyebrow">{current.label}</p>
							<h2 className="mt-2 font-semibold text-xl">{current.title}</h2>
							<p className="mt-2 max-w-2xl text-muted-foreground text-sm">
								{current.description}
							</p>
						</div>
						<FlaskConical
							className="size-5 text-muted-foreground"
							aria-hidden="true"
						/>
					</div>
					<Empty>
						<EmptyHeader>
							<EmptyMedia>
								<LockKeyhole aria-hidden="true" />
							</EmptyMedia>
							<EmptyTitle>评测 API 尚未接入</EmptyTitle>
							<EmptyDescription>
								页面入口和状态边界已就绪。等正式数据集、实验和用途授权契约接入后，这里才会显示真实结果。
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				</div>

				<aside
					className="rounded-[14px] border bg-muted/30 p-5"
					aria-label="评测边界"
				>
					<div className="flex items-center gap-2 font-medium">
						<MessageSquareText className="size-4" aria-hidden="true" />
						当前边界
					</div>
					<ul className="mt-4 space-y-3 text-muted-foreground text-sm">
						<li>只读取当前主体获准的评测数据。</li>
						<li>评分失败与业务任务失败分别显示。</li>
						<li>重新评分不会自动重跑业务任务。</li>
					</ul>
					<Button className="mt-6 w-full" disabled title="等待正式评测 API">
						创建{current.label}
					</Button>
				</aside>
			</section>
		</div>
	);
}
