import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EvaluationAnalysis } from "./evaluation-analysis.js";
import { EvaluationDatasets } from "./evaluation-datasets.js";
import { EvaluationRun } from "./evaluation-experiments.js";
import { EvaluationFeedbackSummary } from "./evaluation-feedback.js";
import { EvaluationScoring } from "./evaluation-scoring.js";

type Section = "datasets" | "experiments" | "feedback";
export function EvaluationWorkbench({
	currentUserId,
}: {
	currentUserId?: string;
} = {}) {
	const [section, setSection] = useState<Section>("datasets");
	const [selected, setSelected] = useState<string | null>(null);
	const [version, setVersion] = useState<{
		datasetId: string;
		versionId: string;
	} | null>(null);
	return (
		<section aria-labelledby="evaluation-heading">
			<header className="page-heading">
				<div className="min-w-0">
					<p className="page-eyebrow">工作区 / 评测</p>
					<h1 id="evaluation-heading">评测</h1>
					<p>按固定数据集比较模型或 Agent 配置，保留逐例结果和人工复核。</p>
				</div>
				<Button onClick={() => setSection("experiments")}>
					运行与查看实验
				</Button>
			</header>
			<Alert tone="info">
				<AlertTitle>评测使用独立授权</AlertTitle>
				<AlertDescription>
					不会自动读取个人会话；样本、运行、评分、复核和分析分别按用途授权。费用归于所选
					Agent 的默认 Key。
				</AlertDescription>
			</Alert>
			<div className="evaluation-surface">
				<Tabs value={section} onValueChange={(v) => setSection(v as Section)}>
					<TabsList className="evaluation-tabs" aria-label="评测区域">
						{(
							[
								["datasets", "评测集"],
								["experiments", "实验"],
								["feedback", "反馈"],
							] as const
						).map(([id, label]) => (
							<TabsTrigger key={id} value={id} className="evaluation-tab">
								{label}
							</TabsTrigger>
						))}
					</TabsList>
					<TabsContent value="datasets" keepMounted className="rounded-[14px]">
						<EvaluationDatasets
							currentUserId={currentUserId}
							selectedVersion={version}
							onRun={(datasetId, versionId) => {
								setVersion({ datasetId, versionId });
								setSection("experiments");
							}}
						/>
					</TabsContent>
					<TabsContent
						value="experiments"
						keepMounted
						className="space-y-8 rounded-[14px]"
					>
						<EvaluationRun
							initialVersion={version}
							onAnalyze={(id) => setSelected(id)}
						/>
						<EvaluationScoring />
						<EvaluationAnalysis
							selected={selected}
							onSelect={setSelected}
							onNewVersion={(datasetId, versionId) => {
								setVersion({ datasetId, versionId });
								setSection("datasets");
							}}
						/>
					</TabsContent>
					<TabsContent value="feedback" keepMounted className="rounded-[14px]">
						<EvaluationFeedbackSummary />
					</TabsContent>
				</Tabs>
				<p className="evaluation-note">
					权限或数据发生变化后请刷新。评分故障和未知结果不会计为质量通过；线上主动反馈单独统计。
				</p>
			</div>
		</section>
	);
}
