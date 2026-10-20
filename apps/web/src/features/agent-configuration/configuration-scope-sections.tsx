import { FormSection } from "@/components/ui/form-section";
import { DirectoryPicker } from "../directory-fields.js";

/** 「共同 Owner」分区（O-03）：标题与说明按设计稿。 */
export function ConfigurationCoOwnerSection({
	disabled,
	error,
	fallbackLabels,
	onChange,
	value,
}: {
	disabled: boolean;
	error?: string;
	/** 目录缺少 Owner 记录或读取失败时，chip 仍显示 Agent 投影中的 Owner 显示名。 */
	fallbackLabels: Record<string, string>;
	onChange: (value: string) => void;
	value: string;
}) {
	return (
		<FormSection
			title="共同 Owner"
			description="从目录选择共同 Owner；页面不显示内部 ID，提交时保存服务端 ID。"
		>
			<div className="mt-4 max-w-[720px]">
				<DirectoryPicker
					id="configuration-owner-ids"
					kind="user"
					label="共同 Owner 用户"
					required
					help="至少保留一名有效 Owner"
					value={value}
					disabled={disabled}
					error={error}
					fallbackLabels={fallbackLabels}
					onChange={(next) => onChange(next)}
				/>
			</div>
		</FormSection>
	);
}

/** 「可用范围」分区（O-03）：人员与组织两列，窄屏单列。 */
export function ConfigurationAvailabilitySection({
	disabled,
	onOrganizationsChange,
	onUsersChange,
	organizationIds,
	userIds,
}: {
	disabled: boolean;
	onOrganizationsChange: (value: string) => void;
	onUsersChange: (value: string) => void;
	organizationIds: string;
	userIds: string;
}) {
	return (
		<FormSection
			title="可用范围"
			description="按人员和组织配置可用范围；搜不到结果时可清空关键词重试。"
		>
			{/* 设计 .form-grid：两列间距 14px（W-22）。 */}
			<div className="mt-4 grid min-w-0 gap-[14px] sm:grid-cols-2">
				<DirectoryPicker
					id="configuration-user-availability"
					kind="user"
					label="可使用的用户"
					help="可选；用于补充个人范围"
					value={userIds}
					disabled={disabled}
					onChange={(next) => onUsersChange(next)}
				/>
				<DirectoryPicker
					id="configuration-organization-availability"
					kind="organization"
					label="可使用的组织"
					help="可选；组织范围会与用户范围合并"
					value={organizationIds}
					disabled={disabled}
					onChange={(next) => onOrganizationsChange(next)}
				/>
			</div>
		</FormSection>
	);
}
