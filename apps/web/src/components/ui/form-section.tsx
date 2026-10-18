import * as React from "react";
import { cn } from "@/lib/utils";

type FormSectionProps = Omit<React.ComponentProps<"section">, "title"> & {
	title: React.ReactNode;
	description?: React.ReactNode;
	// 说明文字需要被字段 aria-describedby 引用时提供。
	descriptionId?: string;
	headingLevel?: 2 | 3;
};

// 设计稿 .form-section：section + 标题，分隔线在标题上方；
// 首个分区没有上边线与上内边距。不要再用 fieldset + legend 作为分区标题。
function FormSection({
	className,
	title,
	description,
	descriptionId,
	headingLevel = 2,
	id,
	children,
	...props
}: FormSectionProps) {
	const generatedId = React.useId();
	const titleId = `${id ?? generatedId}-title`;
	const Heading = headingLevel === 3 ? "h3" : "h2";
	return (
		<section
			data-slot="form-section"
			id={id}
			aria-labelledby={titleId}
			className={cn(
				"min-w-0 border-border border-t py-[22px] first:border-t-0 first:pt-0",
				className,
			)}
			{...props}
		>
			{/* 管理页未分层的 `.management-content h2` 会压过工具类，字体、字号与字距用 !important 固定为分区标题设计值。 */}
			<Heading
				id={titleId}
				data-slot="form-section-title"
				className="!font-[inherit] !text-[16px] !tracking-normal font-[620] text-foreground leading-[1.35]"
			>
				{title}
			</Heading>
			{description ? (
				<p
					id={descriptionId}
					data-slot="form-section-description"
					className="mt-[5px] text-[13px] text-muted-foreground"
				>
					{description}
				</p>
			) : null}
			{children}
		</section>
	);
}

export { FormSection };
