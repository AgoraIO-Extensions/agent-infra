import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentApplicationForm } from "./agent-application-form.js";
import { deploymentConfiguration } from "./test-fixtures.js";
import { useAgentApplicationSubmission } from "./use-agent-application-submission.js";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("./my-agent-applications.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./my-agent-applications.js")>()),
	createMyAgentApplication: mocks.create,
}));
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const candidates = [
	{
		endpointId: "endpoint-primary",
		modelId: "retry-model",
		reasoningLevels: ["medium", "high"],
	},
];

function SubmissionForm() {
	const submission = useAgentApplicationSubmission();
	return (
		<>
			<output>
				{submission.status}:{submission.error?.message}
			</output>
			<AgentApplicationForm
				mode="create"
				deploymentConfiguration={deploymentConfiguration}
				onSubmit={submission.create}
				submitting={submission.isPending}
				serverError={
					submission.isError
						? (submission.error as Error & { code: string })
						: null
				}
				onCheckApplicationModels={async () => candidates}
			/>
		</>
	);
}

it.each(["INVALID_REQUEST", "MODEL_SELECTION_INVALID"])(
	"restores the unchanged-submit guard after a second fast %s rejection",
	async (code) => {
		let attempts = 0;
		mocks.create.mockImplementation(async () => {
			attempts += 1;
			throw Object.assign(new Error(`Synthetic rejection ${attempts}`), {
				code,
				retryable: false,
			});
		});
		const client = new QueryClient({
			defaultOptions: { mutations: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<SubmissionForm />
			</QueryClientProvider>,
		);
		fireEvent.click(screen.getByRole("combobox", { name: "标准模板" }));
		const option = screen.getByRole("option", { name: "Codex" });
		fireEvent.pointerDown(option);
		fireEvent.pointerUp(option);
		fireEvent.click(option);
		fireEvent.change(screen.getByLabelText("Agent 名称"), {
			target: { value: "Repeated failure fixture" },
		});
		fireEvent.change(screen.getByLabelText("用途说明"), {
			target: { value: "Synthetic submission hook regression" },
		});
		fireEvent.change(screen.getByLabelText("Agent 默认 Relay Key"), {
			target: { value: "synthetic-repeated-failure-key" },
		});
		fireEvent.click(screen.getByRole("button", { name: "检查可用模型" }));
		fireEvent.click(
			await screen.findByRole("checkbox", {
				name: "Primary endpoint · retry-model",
			}),
		);
		const submit = screen.getByRole("button", { name: "提交审批" });
		fireEvent.click(submit);
		await screen.findByText("error:Synthetic rejection 1");
		fireEvent.click(
			screen.getByRole("checkbox", {
				name: "高：Primary endpoint · retry-model",
			}),
		);
		fireEvent.click(submit);
		await screen.findByText("error:Synthetic rejection 2");
		await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2));
		await act(async () => {
			fireEvent.click(submit);
			// 等待 mutation 通知；不强制渲染 pending，覆盖 React Query 合并快速失败的场景。
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
		expect(mocks.create).toHaveBeenCalledTimes(2);
		client.clear();
	},
);
