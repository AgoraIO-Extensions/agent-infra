import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonStyles = cva(
	"group/button inline-flex shrink-0 select-none items-center justify-center whitespace-normal rounded-[10px] border border-transparent bg-clip-padding text-center font-[650] text-[13px] leading-[1.65] tracking-[.02em] outline-none [transition:background_.18s_ease,border-color_.18s_ease,color_.18s_ease,transform_.06s_ease] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-[.48] aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 active:not-aria-[haspopup]:[transform:translateY(1px)] [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
	{
		variants: {
			variant: {
				default:
					"border-primary bg-primary text-primary-foreground hover:border-[color-mix(in_oklch,var(--primary)_84%,var(--foreground))] hover:bg-[color-mix(in_oklch,var(--primary)_84%,var(--foreground))]",
				outline:
					"border-border bg-card hover:border-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
				secondary:
					"bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
				ghost:
					"text-muted-foreground hover:bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)] hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
				destructive:
					"border-destructive bg-destructive text-primary-foreground hover:bg-[color-mix(in_oklch,var(--destructive)_84%,var(--foreground))] focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 dark:hover:bg-destructive/30",
				link: "text-primary underline-offset-4 hover:underline",
			},
			size: {
				default: "min-h-[44px] min-w-11 gap-[8px] px-[14px] py-[9px]",
				// xs / icon-xs 只剩目录 chip 的移除与清空按钮（尺寸由 directory-fields 的样式决定）。
				xs: "h-6 gap-1 rounded-none px-2 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
				// 设计稿 .btn-sm 为 38px，DESIGN.md 要求操作至少 44px：待设计定版前保持 44px 最小高度，
				// 内边距与字号按 .btn-sm。
				sm: "min-h-[44px] min-w-11 gap-[8px] px-[11px] py-[7px] text-[12px]",
				icon: "size-11 p-0",
				"icon-xs": "size-6 rounded-none [&_svg:not([class*='size-'])]:size-3",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

// Links use the same merged variants as Button (for example outline must
// replace the base transparent border rather than compete in CSS order).
const buttonVariants: typeof buttonStyles = (props) => cn(buttonStyles(props));

function Button({
	className,
	variant = "default",
	size = "default",
	...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
	return (
		<ButtonPrimitive
			data-slot="button"
			className={cn(buttonVariants({ variant, size, className }))}
			{...props}
		/>
	);
}

export { Button, buttonVariants };
