import { type ReactNode, useId } from "react";
import { cn } from "@/lib/utils";

/**
 * 设计 .form-section 里带 .section-head 的分区：左侧 h2 与说明，右侧状态 chip 或入口按钮
 * （「Agent 默认 Relay Key」「Skill」，G-08、O-02）。骨架与基础层 FormSection 相同
 * （同样的 data-slot、上边线与 22px 内边距），只是标题行多了右侧内容。
 */
export function ConfigurationHeadSection({
	aside,
	children,
	className,
	description,
	title,
	...props
}: {
	aside?: ReactNode;
	children?: ReactNode;
	className?: string;
	description: ReactNode;
	title: ReactNode;
	"data-od-id"?: string;
}) {
	const id = useId();
	const titleId = `${id}-title`;
	return (
		<section
			data-slot="form-section"
			aria-labelledby={titleId}
			className={cn(
				"min-w-0 border-border border-t py-[22px] first:border-t-0 first:pt-0",
				className,
			)}
			{...props}
		>
			<div className="configuration-section-head">
				<div className="min-w-0">
					{/* 与 FormSection 相同：固定分区标题设计值，避免被 `.management-content h2` 放大。 */}
					<h2
						id={titleId}
						data-slot="form-section-title"
						className="!font-[inherit] !text-[16px] !tracking-normal font-[620] text-foreground leading-[1.35]"
					>
						{title}
					</h2>
					<p
						data-slot="form-section-description"
						className="mt-[4px] text-[13px] text-muted-foreground"
					>
						{description}
					</p>
				</div>
				{aside}
			</div>
			{children}
		</section>
	);
}
