import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { cn } from "@/lib/utils";

// 单选组：方向键在选项间移动并选中，Tab 只停在已选项上；组的名称由调用方用 aria-label
// 或 aria-labelledby 提供。
function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
	return (
		<RadioGroupPrimitive
			data-slot="radio-group"
			className={cn("grid gap-2", className)}
			{...props}
		/>
	);
}

// 设计稿原生 radio：13px 圆点、accent 色（--primary 与设计 --accent 同值）。命中区由外层
// 选项卡片（<Label> 包住本控件与文字）提供，选项名称由调用方用 aria-labelledby 指向文字。
function RadioGroupItem({ className, ...props }: RadioPrimitive.Root.Props) {
	return (
		<RadioPrimitive.Root
			data-slot="radio-group-item"
			className={cn(
				"peer relative flex size-[13px] shrink-0 items-center justify-center rounded-full border border-muted-foreground bg-[var(--surface)] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 data-disabled:cursor-not-allowed data-checked:border-primary data-disabled:opacity-50",
				className,
			)}
			{...props}
		>
			<RadioPrimitive.Indicator
				data-slot="radio-group-indicator"
				className="size-[7px] rounded-full bg-primary"
			/>
		</RadioPrimitive.Root>
	);
}

export { RadioGroup, RadioGroupItem };
