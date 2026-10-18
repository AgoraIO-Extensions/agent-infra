import { useNow } from "@/lib/clock";
import {
	formatTimestamp,
	parseTimestamp,
	type TimestampStyle,
	type TimestampValue,
} from "@/lib/format-time";

/** 统一的时间展示：可见文字为相对或绝对时间，悬停 title 为完整本地时间。 */
function Timestamp({
	value,
	style,
	now,
	className,
}: {
	value: TimestampValue;
	style?: TimestampStyle;
	now?: Date;
	className?: string;
}) {
	const clockNow = useNow();
	const formatted = formatTimestamp(value, { now: now ?? clockNow, style });
	if (!formatted) return null;
	const dateTime =
		typeof value === "string"
			? value
			: (parseTimestamp(value)?.toISOString() ?? "");
	return (
		<time
			data-slot="timestamp"
			className={className}
			dateTime={dateTime}
			title={formatted.full}
		>
			{formatted.text}
		</time>
	);
}

export { Timestamp };
