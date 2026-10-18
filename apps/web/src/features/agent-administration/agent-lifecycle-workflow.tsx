import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import { useBrowserSession } from "../use-browser-session.js";
import {
	AgentLifecycleControls,
	type AgentLifecycleScope,
} from "./agent-lifecycle-controls.js";
import { useAgentLifecycleCommand } from "./use-agent-lifecycle-command.js";

type AgentLifecycleWorkflowProps = {
	agent: AgentProjectionV2;
	description?: string;
	heading?: string;
	scope?: AgentLifecycleScope;
};

export function AgentLifecycleWorkflow({
	agent,
	description,
	heading,
	scope,
}: AgentLifecycleWorkflowProps) {
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
			description={description}
			heading={heading}
			scope={scope}
		/>
	);
}
