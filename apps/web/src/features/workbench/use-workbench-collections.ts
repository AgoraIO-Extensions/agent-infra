import type { Client } from "../../pilot/generated-v2/client/index.js";
import { useAdminAgents } from "../admin-agents/use-admin-agents.js";
import { usePendingAgentApplications } from "../agent-administration/use-pending-agent-applications.js";
import { isRetryableAgentDiscoveryError } from "../agent-discovery/agent-discovery.js";
import { useAgentDiscovery } from "../agent-discovery/use-agent-discovery.js";
import { isRetryableMyAgentApplicationError } from "../my-agents/my-agent-applications.js";
import { useMyAgentApplications } from "../my-agents/use-my-agent-applications.js";
import type { WorkbenchScreenProps } from "./workbench-screen.js";

/** Existing collections only; personal recent requires its own merged producer. */
export function useWorkbenchCollections({
	identityKey,
	administrator,
	client,
}: {
	identityKey: string;
	administrator: boolean;
	client?: Client;
}): Pick<
	WorkbenchScreenProps,
	| "agents"
	| "ownerAgents"
	| "applications"
	| "pending"
	| "adminAgents"
	| "onRetry"
	| "refreshing"
> & {
	/** 「重新登录」后会话仍有效：解除各分区不可重试的失败并重读（W-03）。 */
	reload: () => void;
} {
	const agents = useAgentDiscovery({ identityKey, client });
	const ownerAgents = useAgentDiscovery({
		identityKey,
		client,
		scope: "owner",
	});
	const applications = useMyAgentApplications({ identityKey, client });
	const pending = usePendingAgentApplications({
		identityKey,
		enabled: administrator,
		client,
	});
	const adminAgents = useAdminAgents({
		identityKey,
		enabled: administrator,
		client,
	});
	return {
		agents: !identityKey
			? { kind: "unavailable", retryable: false }
			: // 后台重读的可重试失败不替换已显示的分区（#3387）。
				agents.failed
				? {
						kind: "unavailable",
						retryable: isRetryableAgentDiscoveryError(agents.error),
					}
				: (agents.data ?? { kind: "loading" }),
		ownerAgents: !identityKey
			? { kind: "unavailable", retryable: false }
			: ownerAgents.failed
				? {
						kind: "unavailable",
						retryable: isRetryableAgentDiscoveryError(ownerAgents.error),
					}
				: (ownerAgents.data ?? { kind: "loading" }),
		applications: !identityKey
			? { kind: "unavailable", retryable: false }
			: applications.failed
				? {
						kind: "unavailable",
						retryable: isRetryableMyAgentApplicationError(applications.error),
					}
				: (applications.data ?? { kind: "loading" }),
		pending: pending.state,
		adminAgents: adminAgents.state,
		refreshing:
			agents.isFetching ||
			ownerAgents.isFetching ||
			applications.isFetching ||
			pending.isFetching ||
			adminAgents.isFetching,
		onRetry: () => {
			void agents.refetch();
			void ownerAgents.refetch();
			void applications.refetch();
			void pending.refetch();
			void adminAgents.refetch();
		},
		reload: () => {
			void agents.reload();
			void ownerAgents.reload();
			void applications.reload();
			void pending.reload();
			void adminAgents.reload();
		},
	};
}
