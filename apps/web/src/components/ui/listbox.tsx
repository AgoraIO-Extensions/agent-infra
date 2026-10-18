import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ListboxProps = {
	"aria-busy"?: boolean;
	"aria-label"?: string;
	children: ReactNode;
	className?: string;
	id?: string;
};

function Listbox({ children, className, ...props }: ListboxProps) {
	return (
		<div data-slot="listbox" className={className} role="listbox" {...props}>
			{children}
		</div>
	);
}

type ListboxOptionProps = ComponentProps<typeof Button> & {
	"aria-selected"?: boolean;
};

// 候选默认不进入 Tab 序列：焦点留在输入框，通过 aria-activedescendant 导航。
function ListboxOption({
	className,
	tabIndex = -1,
	...props
}: ListboxOptionProps) {
	return (
		<Button
			className={cn(className)}
			role="option"
			tabIndex={tabIndex}
			{...props}
		/>
	);
}

export { Listbox, ListboxOption };
