import type { EvaluationDatasetContentV1 } from "../src/pilot/generated-v2/types.gen.js";

/** Browser-side consumer surface; dynamically loaded server fixtures do not enter Web's build graph. */
export interface EvaluationBrowserFixture {
	origin: string;
	agentId: string;
	datasetId: string;
	versionId: string;
	roles: Record<
		| "manager"
		| "runner"
		| "grader"
		| "reviewer"
		| "analyst"
		| "owner"
		| "outsider",
		string
	>;
	content: EvaluationDatasetContentV1;
	tick(): Promise<void>;
	createOnlineTask(): Promise<{ conversationId: string; executionId: string }>;
	close(): Promise<void>;
	modelCalls(): number;
	runtimeCalls(): number;
}
