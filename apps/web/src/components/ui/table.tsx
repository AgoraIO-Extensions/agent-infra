import * as React from "react";
import { cn } from "@/lib/utils";

type TableMobileLayout = "scroll" | "cards";

// "scroll"：窄屏仍是表格，在容器内横向滚动（列不固定的内容，如 Markdown）。
// "cards"：数据列表，≥768px 为表格，≤767px 每行转为卡片（设计稿 .table-wrap 窄屏规则）。
const TableLayoutContext = React.createContext<TableMobileLayout>("scroll");

function Table({
	className,
	mobileLayout = "scroll",
	...props
}: React.ComponentProps<"table"> & { mobileLayout?: TableMobileLayout }) {
	const cards = mobileLayout === "cards";
	return (
		<TableLayoutContext.Provider value={mobileLayout}>
			<div
				data-slot="table-container"
				data-mobile-layout={mobileLayout}
				className={cn(
					"relative w-full overflow-x-auto",
					cards &&
						"rounded-[14px] border border-border bg-[var(--surface)] max-md:rounded-none max-md:border-0 max-md:bg-transparent",
				)}
			>
				<table
					data-slot="table"
					className={cn(
						"w-full caption-bottom text-[13px] leading-[1.65]",
						cards && "max-md:block",
						className,
					)}
					{...props}
				/>
			</div>
		</TableLayoutContext.Provider>
	);
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
	const cards = React.useContext(TableLayoutContext) === "cards";
	return (
		<thead
			data-slot="table-header"
			className={cn("[&_tr]:border-b", cards && "max-md:hidden", className)}
			{...props}
		/>
	);
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
	const cards = React.useContext(TableLayoutContext) === "cards";
	return (
		<tbody
			data-slot="table-body"
			className={cn(
				cards
					? "max-md:block md:[&_tr:last-child]:border-0"
					: "[&_tr:last-child]:border-0",
				className,
			)}
			{...props}
		/>
	);
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
	return (
		<tfoot
			data-slot="table-footer"
			className={cn(
				"border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
				className,
			)}
			{...props}
		/>
	);
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
	const cards = React.useContext(TableLayoutContext) === "cards";
	return (
		<tr
			data-slot="table-row"
			className={cn(
				"border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted",
				cards &&
					"max-md:mb-[10px] max-md:block max-md:rounded-[11px] max-md:border max-md:border-border max-md:bg-[var(--surface)] max-md:p-[10px]",
				className,
			)}
			{...props}
		/>
	);
}

// 设计稿 th：11px / 1.4 等宽、字重 500、字距 .05em、muted；≤767 内边距 12px 11px。
function TableHead({ className, ...props }: React.ComponentProps<"th">) {
	return (
		<th
			data-slot="table-head"
			className={cn(
				"px-[15px] py-[14px] text-left align-top font-medium font-mono text-[11px] text-muted-foreground leading-[1.4] tracking-[.05em] max-md:px-[11px] max-md:py-3 [&:has([role=checkbox])]:pr-0",
				className,
			)}
			{...props}
		/>
	);
}

// 设计稿 td：13px / 1.65、内边距 14px 15px、顶对齐；td small 为块级 11px muted 副文。
// 卡片模式（≤767px）：td 为 flex，左侧 ::before 显示 data-label，右侧为值容器；
// 最后一格（或 data-cell="actions"）是操作格，不显示标签、左对齐。
function TableCell({
	className,
	children,
	...props
}: React.ComponentProps<"td">) {
	const cards = React.useContext(TableLayoutContext) === "cards";
	return (
		<td
			data-slot="table-cell"
			className={cn(
				"group/cell whitespace-normal px-[15px] py-[14px] align-top [overflow-wrap:anywhere] max-md:px-[11px] max-md:py-3 [&:has([role=checkbox])]:pr-0 [&_small]:mt-[3px] [&_small]:block [&_small]:text-[11px] [&_small]:text-muted-foreground",
				cards &&
					"max-md:flex max-md:items-start max-md:justify-between max-md:gap-3 max-md:border-0 max-md:px-0 max-md:py-[6px] max-md:data-[cell=actions]:justify-start max-md:last:justify-start max-md:before:flex-none max-md:before:font-normal max-md:before:text-[11px] max-md:before:text-muted-foreground max-md:before:content-[attr(data-label)] max-md:data-[cell=actions]:before:hidden max-md:last:before:hidden",
				className,
			)}
			{...props}
		>
			{cards ? (
				<div
					data-slot="table-cell-value"
					className="contents max-md:flex max-md:min-w-0 max-md:flex-1 max-md:flex-col max-md:items-end max-md:text-right max-md:group-data-[cell=actions]/cell:items-start max-md:group-data-[cell=actions]/cell:text-left max-md:group-last/cell:items-start max-md:group-last/cell:text-left"
				>
					{children}
				</div>
			) : (
				children
			)}
		</td>
	);
}

function TableCaption({
	className,
	...props
}: React.ComponentProps<"caption">) {
	return (
		<caption
			data-slot="table-caption"
			className={cn("mt-4 text-muted-foreground text-xs", className)}
			{...props}
		/>
	);
}

export {
	Table,
	TableBody,
	TableCaption,
	TableCell,
	TableFooter,
	TableHead,
	TableHeader,
	TableRow,
};
