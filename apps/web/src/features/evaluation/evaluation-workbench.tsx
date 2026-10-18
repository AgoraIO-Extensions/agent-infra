import { Link } from "@tanstack/react-router";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@/components/ui/empty";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type EvaluationSection = "datasets" | "experiments" | "feedback";

// 设计 #eval：分段顺序为 评测集 / 实验 / 反馈，默认评测集。评测 API 尚未接入，
// 每段只显示各自的空态，不展示示例数据（R-03）。
const sections: Array<{
	id: EvaluationSection;
	label: string;
	emptyTitle: string;
	emptyDescription: string;
}> = [
	{
		id: "datasets",
		label: "评测集",
		emptyTitle: "还没有评测集",
		emptyDescription:
			"样本和判定标准按版本保存，接入后在这里显示样本数、版本与授权状态。",
	},
	{
		id: "experiments",
		label: "实验",
		emptyTitle: "还没有实验",
		emptyDescription:
			"实验固定评测集、Agent 配置和评分版本，接入后在这里显示运行进度与逐例复核。",
	},
	{
		id: "feedback",
		label: "反馈",
		emptyTitle: "还没有主动反馈",
		emptyDescription: "反馈只关联当前用户自己的任务。",
	},
];

const pendingNoteId = "evaluation-pending-note";

export function EvaluationWorkbench() {
	return (
		<section aria-labelledby="evaluation-heading">
			<header className="page-heading">
				<div className="min-w-0">
					<p className="page-eyebrow">系统管理 / 评测</p>
					<h1 id="evaluation-heading">评测</h1>
					<p>按固定数据集比较模型或 Agent 配置，保留逐例结果和人工复核。</p>
				</div>
				{/* 评测集写入接口未接入：主操作保留在设计位置，但不可用并指向说明。 */}
				<Button disabled aria-describedby={pendingNoteId}>
					创建评测集
				</Button>
			</header>

			{/* 静态说明，不设 role。 */}
			<Alert tone="info">
				<AlertTitle>评测使用独立授权</AlertTitle>
				<AlertDescription>
					不会自动读取个人会话；评测样本、输出与评分理由按评测用途单独授权。
				</AlertDescription>
			</Alert>

			<div className="evaluation-surface">
				<Tabs defaultValue="datasets">
					<TabsList className="evaluation-tabs" aria-label="评测区域">
						{sections.map((item) => (
							<TabsTrigger
								key={item.id}
								value={item.id}
								className="evaluation-tab"
							>
								{item.label}
							</TabsTrigger>
						))}
					</TabsList>
					{sections.map((item) => (
						<TabsContent key={item.id} value={item.id}>
							<Empty>
								<EmptyHeader>
									<EmptyTitle>{item.emptyTitle}</EmptyTitle>
									<EmptyDescription>{item.emptyDescription}</EmptyDescription>
								</EmptyHeader>
								{item.id === "feedback" ? (
									<EmptyContent>
										{/* 反馈在对话里提交：先选择 Agent 再进入对话（与导航「对话」一致）。 */}
										<Link
											className={buttonVariants({ variant: "outline" })}
											to="/agents"
											search={{ mode: "conversation" }}
										>
											查看对话反馈
										</Link>
									</EmptyContent>
								) : null}
							</Empty>
						</TabsContent>
					))}
				</Tabs>
				<p id={pendingNoteId} className="evaluation-note">
					评测集读写、真实运行、评分器和逐例复核尚未接入，接入前不能创建评测集，也不会显示示例结果。
				</p>
			</div>
		</section>
	);
}
