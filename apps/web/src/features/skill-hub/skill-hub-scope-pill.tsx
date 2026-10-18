import { Badge } from "@/components/ui/badge";
import type { SkillHubVersionMetadataV1 } from "../../pilot/generated-v2/types.gen.js";
import {
	type SkillHubVersionState,
	skillHubProviderLabels,
	skillHubVersionStateLabels,
	skillHubVersionStateTones,
	skillHubVisibilityLabels,
} from "./skill-hub-labels.js";

/**
 * 设计 .quiet-pill「{范围} · {来源}」：来源与范围合并成一个标签。
 * 两段前的 sr-only 前缀让读屏能区分同名文案（如「内部市场 · 内部市场」）；
 * span 没有 role，不加 aria-label（NI-98），可访问文本就是可见文本加前缀。
 */
export function SkillHubScopePill({
	version,
}: {
	version: Pick<SkillHubVersionMetadataV1, "provider" | "visibility">;
}) {
	return (
		<Badge variant="tag" data-skill-pill="">
			<span>
				<span className="sr-only">范围：</span>
				{skillHubVisibilityLabels[version.visibility]}
				{" · "}
				<span className="sr-only">来源：</span>
				{skillHubProviderLabels[version.provider]}
			</span>
		</Badge>
	);
}

export function SkillHubStateChip({ state }: { state: SkillHubVersionState }) {
	return (
		<Badge tone={skillHubVersionStateTones[state]}>
			{skillHubVersionStateLabels[state]}
		</Badge>
	);
}
