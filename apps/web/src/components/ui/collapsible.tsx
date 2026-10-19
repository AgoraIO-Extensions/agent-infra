import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";
import { cn } from "@/lib/utils";

// 设计 details/summary 的可访问替代：web-ui policy 禁止原生 summary。
// 触发按钮由调用方提供可见结构；展开状态由 aria-expanded 表达。
function Collapsible({ className, ...props }: CollapsiblePrimitive.Root.Props) {
	return (
		<CollapsiblePrimitive.Root
			data-slot="collapsible"
			className={className}
			{...props}
		/>
	);
}

function CollapsibleTrigger({
	className,
	...props
}: CollapsiblePrimitive.Trigger.Props) {
	return (
		<CollapsiblePrimitive.Trigger
			data-slot="collapsible-trigger"
			className={cn("cursor-pointer", className)}
			{...props}
		/>
	);
}

// 默认 keepMounted：收起时只隐藏（hidden），不卸载子树，内部状态与进行中的请求不随收起丢失。
function CollapsiblePanel({
	className,
	keepMounted = true,
	...props
}: CollapsiblePrimitive.Panel.Props) {
	return (
		<CollapsiblePrimitive.Panel
			data-slot="collapsible-panel"
			keepMounted={keepMounted}
			className={className}
			{...props}
		/>
	);
}

export { Collapsible, CollapsiblePanel, CollapsibleTrigger };
