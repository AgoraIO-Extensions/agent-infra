import { cn } from "@/lib/utils";

// 设计 .empty：虚线边框的居中空态；调用点不覆盖 padding、min-height 与边框。
// 直接子元素就是网格行：220px 内的剩余高度由各行均分，每行内容居中；行与行之间
// 不另加外边距（只有图标下方 11px）。需要同一行的内容（如标题与说明）用
// EmptyHeader 包在一起，单独成行的图标、标题、说明或操作直接放在 Empty 下。
function Empty({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="empty"
			className={cn(
				"grid min-h-[220px] w-full min-w-0 place-items-center rounded-[14px] border border-border border-dashed bg-card p-[28px] text-center",
				className,
			)}
			{...props}
		/>
	);
}

function EmptyHeader({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="empty-header"
			className={cn("flex max-w-sm flex-col items-center", className)}
			{...props}
		/>
	);
}

// 放 lucide 图标：28px、muted、与标题间距 11px。
function EmptyMedia({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="empty-icon"
			className={cn(
				"flex shrink-0 items-center justify-center text-muted-foreground [&_svg]:pointer-events-none [&_svg]:mb-[11px] [&_svg]:size-[28px] [&_svg]:shrink-0",
				className,
			)}
			{...props}
		/>
	);
}

// 标题是 strong 而不是 heading，避免被页面级 h2 规则放大成 display 字体。
function EmptyTitle({ className, ...props }: React.ComponentProps<"strong">) {
	return (
		<strong
			data-slot="empty-title"
			className={cn(
				"block font-bold text-[15px] text-foreground leading-[1.65]",
				className,
			)}
			{...props}
		/>
	);
}

function EmptyDescription({ className, ...props }: React.ComponentProps<"p">) {
	return (
		<p
			data-slot="empty-description"
			className={cn(
				"text-[13px] text-muted-foreground leading-[1.65] [&>a:hover]:text-primary [&>a]:underline [&>a]:underline-offset-4",
				className,
			)}
			{...props}
		/>
	);
}

// 动作按钮单独成行，放在说明下方；与上一行的距离由网格均分决定。
function EmptyContent({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="empty-content"
			className={cn(
				"flex w-full min-w-0 max-w-sm flex-col items-center gap-2.5",
				className,
			)}
			{...props}
		/>
	);
}

export {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
};
