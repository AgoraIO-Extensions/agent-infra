import type * as React from "react";
import { useId } from "react";
import { cn } from "@/lib/utils";

// 设计 .state-card：min-height 190px、纵向 space-between、padding 18px、1px border、
// 14px 圆角、surface 底；标题为 16px 正文字体，说明 13px muted、margin-top 6px。
// 尺寸写在 index.css 的 [data-slot="state-card"] 规则中，避免被页面级 h2/h3 规则覆盖。
// 不设默认 role：读取失败由调用方传 role="alert"，静态说明（404、无权限）不设 role。
type StateCardProps = Omit<React.ComponentProps<"article">, "title"> & {
	title: React.ReactNode;
	description: React.ReactNode;
	/** 卡片底部的操作；单个按钮按设计撑满卡宽。 */
	actions?: React.ReactNode;
	/** 页面已有 h1 时默认 h2；整页只有这张卡时可传 1。 */
	headingLevel?: 1 | 2 | 3;
};

function StateCard({
	title,
	description,
	actions,
	headingLevel = 2,
	className,
	...props
}: StateCardProps) {
	const titleId = useId();
	const Heading = headingLevel === 1 ? "h1" : headingLevel === 3 ? "h3" : "h2";
	return (
		<article
			data-slot="state-card"
			aria-labelledby={titleId}
			className={cn(className)}
			{...props}
		>
			<div>
				<Heading id={titleId} data-slot="state-card-title">
					{title}
				</Heading>
				<p data-slot="state-card-description">{description}</p>
			</div>
			{actions ? <div data-slot="state-card-actions">{actions}</div> : null}
		</article>
	);
}

export type { StateCardProps };
export { StateCard };
