import { useMemo } from "react";
import type { CapabilityCatalog } from "./conversation-capability-menu.js";
import { useConversationNativeMetadata } from "./use-conversation-native-metadata.js";

/**
 * 把命令与 Skill 两个目录读取合成 composer 用的目录状态。契约只支持按 Execution 读取
 * （CK-04），尚无 Execution 时不发请求，弹层给出明确说明而不是整块隐藏（CK-03）。
 */
export function useConversationCapabilityCatalog({
	identityKey,
	conversationId,
	executionId,
	enabled,
}: {
	identityKey: string;
	conversationId: string;
	executionId: string | undefined;
	enabled: boolean;
}): CapabilityCatalog {
	const commands = useConversationNativeMetadata({
		identityKey,
		conversationId,
		executionId,
		selector: "commands",
		enabled,
	});
	const skills = useConversationNativeMetadata({
		identityKey,
		conversationId,
		executionId,
		selector: "skills",
		enabled,
	});
	const capabilities = useMemo(
		() => [...commands.capabilities, ...skills.capabilities],
		[commands.capabilities, skills.capabilities],
	);
	const refetchCommands = commands.refetch;
	const refetchSkills = skills.refetch;
	return useMemo((): CapabilityCatalog => {
		if (!enabled) return { status: "unsupported" };
		if (executionId === undefined) return { status: "no-execution" };
		if (commands.available && skills.available)
			return { status: "ready", capabilities };
		if (commands.isPending || skills.isPending) return { status: "loading" };
		if (commands.available || skills.available)
			return { status: "partial", capabilities };
		return {
			status: "error",
			retry: () => {
				void refetchCommands();
				void refetchSkills();
			},
		};
	}, [
		enabled,
		executionId,
		commands.available,
		skills.available,
		commands.isPending,
		skills.isPending,
		capabilities,
		refetchCommands,
		refetchSkills,
	]);
}
