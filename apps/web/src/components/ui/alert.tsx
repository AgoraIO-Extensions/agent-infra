import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

const alertVariants = cva(
	"group/alert relative grid w-full gap-1 rounded-[12px] border px-3.5 py-[13px] text-left text-[13px] leading-[1.3] has-data-[slot=alert-action]:relative has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2 has-data-[slot=alert-action]:pr-18 *:[svg:not([class*='size-'])]:size-[17px] *:[svg]:row-span-2 *:[svg]:translate-y-0 *:[svg]:text-current",
	{
		variants: {
			variant: {
				default: "bg-card text-card-foreground",
				destructive:
					"bg-card text-destructive *:data-[slot=alert-description]:text-destructive/90 *:[svg]:text-current",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	},
);

function Alert({
	className,
	variant,
	role,
	...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
	return (
		<div
			data-slot="alert"
			role={role ?? "alert"}
			className={cn(alertVariants({ variant }), className)}
			{...props}
		/>
	);
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="alert-title"
			className={cn(
				"font-[650] group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground",
				className,
			)}
			{...props}
		/>
	);
}

function AlertDescription({
	className,
	...props
}: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="alert-description"
			className={cn(
				"text-balance text-muted-foreground text-xs/relaxed md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-2",
				className,
			)}
			{...props}
		/>
	);
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="alert-action"
			className={cn(
				"absolute top-[calc(--spacing(1.25))] right-[calc(--spacing(1.25))]",
				className,
			)}
			{...props}
		/>
	);
}

export { Alert, AlertAction, AlertDescription, AlertTitle };
