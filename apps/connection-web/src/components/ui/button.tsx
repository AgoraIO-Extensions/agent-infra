import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";

import { cn } from "../../lib/utils";

export const buttonVariants = cva("button", {
	defaultVariants: { size: "default", variant: "primary" },
	variants: {
		size: {
			default: "",
			icon: "icon-button",
			text: "text-button",
		},
		variant: {
			danger: "button-danger",
			ghost: "",
			primary: "button-primary",
			secondary: "button-secondary",
		},
	},
});

export function Button({
	asChild = false,
	className,
	size,
	variant,
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> &
	VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
	const Component = asChild ? Slot : "button";
	return (
		<Component
			className={cn(buttonVariants({ size, variant }), className)}
			{...props}
		/>
	);
}
