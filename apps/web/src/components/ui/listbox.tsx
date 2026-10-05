import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ListboxProps = {
	"aria-busy"?: boolean;
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

function ListboxOption({ className, ...props }: ListboxOptionProps) {
	return <Button className={cn(className)} role="option" {...props} />;
}

export { Listbox, ListboxOption };
