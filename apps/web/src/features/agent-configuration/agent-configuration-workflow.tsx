import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import { AgentLifecycleWorkflow } from "../agent-administration/agent-lifecycle-workflow.js";
import { useBrowserSession } from "../agent-administration/use-browser-session.js";
import { AgentConfigurationScreen } from "./agent-configuration-screen.js";
import { useAgentConfigurationSubmission } from "./use-agent-configuration-submission.js";

type AgentConfigurationWorkflowProps = {
	agent: AgentProjectionV2;
};

export function AgentConfigurationWorkflow({
	agent,
}: AgentConfigurationWorkflowProps) {
	const session = useBrowserSession();
	const submission = useAgentConfigurationSubmission(agent.agentId);
	const commandError =
		submission.isError && submission.error instanceof Error
			? submission.error
			: null;

	return (
		<AgentConfigurationScreen
			lifecycle={<AgentLifecycleWorkflow agent={agent} />}
			agent={agent}
			commandError={commandError}
			commandResult={submission.data}
			key={agent.agentId}
			onSave={submission.saveConfiguration}
			onUpgradeImage={submission.upgradeImage}
			session={session.state}
			submitting={submission.isPending}
		/>
	);
}
