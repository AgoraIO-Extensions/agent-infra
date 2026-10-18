import { cn } from "@/lib/utils";

// 设计 .empty：虚线边框的居中空态；调用点不覆盖 padding、min-height 与边框。
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

// 动作按钮放在说明下方。
function EmptyContent({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="empty-content"
			className={cn(
				"mt-[14px] flex w-full min-w-0 max-w-sm flex-col items-center gap-2.5",
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
