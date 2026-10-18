import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cn } from "@/lib/utils";

function Tabs({
	className,
	orientation = "horizontal",
	...props
}: TabsPrimitive.Root.Props) {
	return (
		<TabsPrimitive.Root
			data-slot="tabs"
			data-orientation={orientation}
			orientation={orientation}
			className={cn(
				"group/tabs flex",
				orientation === "horizontal" ? "flex-col" : "gap-2",
				className,
			)}
			{...props}
		/>
	);
}

// 设计稿只有一种 Tab 样式（.tabs / .tab）：下划线标签，底边 1px 分隔线。
function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
	return (
		<TabsPrimitive.List
			data-slot="tabs-list"
			className={cn(
				"group/tabs-list mb-5 flex w-full max-w-full flex-wrap items-center gap-1 border-border border-b group-data-[orientation=vertical]/tabs:w-fit group-data-[orientation=vertical]/tabs:flex-col group-data-[orientation=vertical]/tabs:border-b-0",
				className,
			)}
			{...props}
		/>
	);
}

// 选中与未选中同为 13px / 650；选中下划线为 --accent-ink，悬停文字变前景色。
// 焦点环走全局 :focus-visible（2px、offset 3px），不再叠加 1px outline 与 ring；过渡不含 outline。
function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
	return (
		<TabsPrimitive.Tab
			data-slot="tabs-trigger"
			className={cn(
				"relative mr-[18px] inline-flex min-h-11 min-w-0 flex-none cursor-pointer items-center justify-center gap-1.5 whitespace-normal border-0 border-transparent border-b-2 bg-transparent px-[2px] py-[9px] font-[650] text-[13px] text-muted-foreground leading-[1.65] transition-[color,background-color,border-color] [overflow-wrap:anywhere] hover:text-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 aria-selected:border-b-[var(--accent-ink)] aria-selected:text-foreground [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
				className,
			)}
			{...props}
		/>
	);
}

// 面板不设字号，继承页面正文 15px / 1.65；不加 outline-none，可聚焦面板显示全局焦点环（N-17）。
function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
	return (
		<TabsPrimitive.Panel
			data-slot="tabs-content"
			className={cn("flex-1", className)}
			{...props}
		/>
	);
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
