import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export const evaluationRequestOptions = {
	responseStyle: "fields",
	throwOnError: false,
} as const;
export class EvaluationRequestError extends Error {
	constructor(
		readonly status: number | undefined,
		readonly code: string | undefined,
	) {
		super(
			code === "EVALUATION_QUERY_TOO_LARGE"
				? "查询范围过大，请缩小时间窗口、筛选范围或每页条数。"
				: status === 401
					? "登录已失效，请重新登录。"
					: status === 403 || status === 404
						? "当前权限不足或对象已不可用，请刷新并核对授权。"
						: status === 409
							? "内容或修订已变化，请刷新后确认再提交。"
							: status === 400
								? "请求未被接受，请检查填写内容。"
								: "服务未配置或暂时不可用，请稍后重试。",
		);
	}
}
export function evaluationResponse<T>(
	result: { data?: unknown; error?: unknown; response?: Response },
	schema: {
		safeParse(input: unknown): { success: true; data: T } | { success: false };
	},
): T {
	if (result.error || (result.response && !result.response.ok)) {
		const error = result.error;
		throw new EvaluationRequestError(
			result.response?.status,
			error &&
				typeof error === "object" &&
				"code" in error &&
				typeof error.code === "string"
				? error.code
				: undefined,
		);
	}
	const parsed = schema.safeParse(result.data);
	if (!parsed.success) throw new EvaluationRequestError(undefined, undefined);
	return parsed.data;
}
export function evaluationError(error: unknown) {
	return error instanceof EvaluationRequestError
		? error.message
		: "服务暂不可用，请稍后重试。";
}
/** Each load replaces sensitive data; older responses cannot restore it after a newer read. */
export function useEvaluationRead<T>(
	load: (signal: AbortSignal) => Promise<T>,
	enabled = true,
) {
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);
	const generation = useRef(0);
	const controller = useRef<AbortController | null>(null);
	const clear = useCallback(() => {
		generation.current++;
		controller.current?.abort();
		setData(null);
		setError("");
		setLoading(false);
	}, []);
	const reload = useCallback(async () => {
		const n = ++generation.current;
		controller.current?.abort();
		const next = new AbortController();
		controller.current = next;
		setData(null);
		setError("");
		setLoading(true);
		try {
			const value = await load(next.signal);
			if (n === generation.current && !next.signal.aborted) setData(value);
		} catch (e) {
			if (n === generation.current && !next.signal.aborted)
				setError(evaluationError(e));
		} finally {
			if (n === generation.current) setLoading(false);
		}
	}, [load]);
	useEffect(() => {
		if (enabled) void reload();
		else clear();
		return () => {
			generation.current++;
			controller.current?.abort();
		};
	}, [reload, enabled, clear]);
	return { data, error, loading, reload, clear };
}
/** A transport-uncertain command retains its original captured body and key until explicit replay. */
export function useEvaluationCommand<T>(
	accepted: (value: T) => void | Promise<void>,
	scope = "mounted-resource",
) {
	const [busy, setBusy] = useState(false);
	const [uncertain, setUncertain] = useState(false);
	const [error, setError] = useState("");
	const pending = useRef<{
		key: string;
		send: (key: string) => Promise<T>;
		accepted: typeof accepted;
		epoch: number;
	} | null>(null);
	const generation = useRef(0);
	const inFlight = useRef(false);
	const uncertainRef = useRef(false);
	const mounted = useRef(true);
	const lastScope = useRef(scope);
	if (lastScope.current !== scope) {
		lastScope.current = scope;
		generation.current++;
		pending.current = null;
		inFlight.current = false;
		uncertainRef.current = false;
	}
	// Scope changes invalidate both the request intent and its visible status.
	useEffect(() => {
		if (lastScope.current !== scope) return;
		setBusy(false);
		setUncertain(false);
		setError("");
	}, [scope]);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			generation.current++;
			pending.current = null;
		};
	}, []);
	const execute = async () => {
		if (!pending.current || inFlight.current) return;
		const intent = pending.current;
		const live = () =>
			mounted.current &&
			intent.epoch === generation.current &&
			pending.current === intent;
		inFlight.current = true;
		setBusy(true);
		setError("");
		let value: T;
		try {
			value = await intent.send(intent.key);
		} catch (e) {
			if (!live()) return;
			if (
				!uncertainRef.current &&
				e instanceof EvaluationRequestError &&
				e.status &&
				[400, 401, 403, 404, 409].includes(e.status)
			) {
				pending.current = null;
				uncertainRef.current = false;
				setUncertain(false);
				setError(e.message);
			} else {
				uncertainRef.current = true;
				setUncertain(true);
				setError("操作未确认。请重试原操作，不会新建请求或自动重复提交。");
			}
			inFlight.current = false;
			setBusy(false);
			return;
		}
		if (!live()) return;
		pending.current = null;
		uncertainRef.current = false;
		setUncertain(false);
		try {
			await intent.accepted(value);
		} catch {
			if (mounted.current && intent.epoch === generation.current)
				setError("操作已完成，但刷新失败，请手动刷新。");
		}
		if (mounted.current && intent.epoch === generation.current) {
			inFlight.current = false;
			setBusy(false);
		}
	};
	return {
		busy,
		uncertain,
		error,
		setError,
		run(send: (key: string) => Promise<T>) {
			if (inFlight.current || pending.current) return;
			pending.current = {
				key: crypto.randomUUID(),
				send,
				accepted,
				epoch: generation.current,
			};
			void execute();
		},
		retry: () => void execute(),
	};
}
export function EvaluationNotice({
	error,
	loading,
}: {
	error?: string;
	loading?: boolean;
}) {
	return (
		<>
			{loading && <p role="status">正在读取…</p>}
			{error && (
				<Alert tone="danger" role="alert">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			)}
		</>
	);
}
export function EvaluationRetry({
	command,
}: {
	command: { uncertain: boolean; busy: boolean; retry: () => void };
}) {
	return command.uncertain ? (
		<Button variant="outline" disabled={command.busy} onClick={command.retry}>
			重试原操作
		</Button>
	) : null;
}
