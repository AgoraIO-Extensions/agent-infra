import type { AgentProjectionV1 } from "../../pilot/generated/types.gen.js";
import { AgentLifecycleControls } from "./agent-lifecycle-controls.js";
import { useAgentLifecycleCommand } from "./use-agent-lifecycle-command.js";
import { useBrowserSession } from "./use-browser-session.js";

type AgentLifecycleWorkflowProps = {
	agent: AgentProjectionV1;
};

export function AgentLifecycleWorkflow({ agent }: AgentLifecycleWorkflowProps) {
	const session = useBrowserSession();
	const lifecycle = useAgentLifecycleCommand(agent.agentId);

	return (
		<AgentLifecycleControls
			agent={agent}
			commandError={lifecycle.error}
			commandResult={lifecycle.data}
			onCommand={(command) => lifecycle.mutate(command)}
			pendingCommand={lifecycle.isPending ? lifecycle.variables : undefined}
			session={session.state}
		/>
	);
}
