import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentApplicationForm } from "./agent-application-form.js";
import {
	deploymentConfiguration,
	pendingApplication,
} from "./test-fixtures.js";

afterEach(cleanup);

const firstCandidate = {
	endpointId: "endpoint-primary",
	modelId: "retry-model",
	reasoningLevels: ["medium", "high"],
};
const candidates = [
	firstCandidate,
	{
		endpointId: "endpoint-primary",
		modelId: "other-model",
		reasoningLevels: ["medium"],
	},
];
const application = {
	...pendingApplication,
	configuration: {
		...pendingApplication.configuration,
		modelOptions: [
			{
				...firstCandidate,
				optionId: "endpoint-primary:retry-model",
				displayName: "Retry model",
			},
		],
		defaultModelOptionId: "endpoint-primary:retry-model",
		defaultReasoningLevel: "medium",
	},
};

async function prepare(mode: "create" | "update") {
	const onSubmit = vi.fn();
	const check = vi
		.fn()
		.mockResolvedValue({ candidates, configurationRevision: 7, keyVersion: 2 });
	const props =
		mode === "create"
			? {
					mode,
					deploymentConfiguration,
					onSubmit,
					submitting: false,
					onCheckApplicationModels: async () => (await check()).candidates,
				}
			: {
					mode,
					action: "edit" as const,
					application,
					deploymentConfiguration,
					onSubmit,
					submitting: false,
					defaultRelayKeyManaged: true,
					onCheckDefaultRelayKey: check,
				};
	const view = render(<AgentApplicationForm {...props} />);
	if (mode === "create") {
		fireEvent.click(screen.getByRole("combobox", { name: "标准模板" }));
		const option = screen.getByRole("option", { name: "Codex" });
		fireEvent.pointerDown(option);
		fireEvent.pointerUp(option);
		fireEvent.click(option);
		fireEvent.change(screen.getByLabelText("Agent 名称"), {
			target: { value: "Retry fixture" },
		});
		fireEvent.change(screen.getByLabelText("用途说明"), {
			target: { value: "Synthetic retry regression" },
		});
	} else
		fireEvent.click(screen.getByRole("checkbox", { name: "修改模型配置" }));
	fireEvent.change(screen.getByLabelText("Agent 默认 Relay Key"), {
		target: { value: "synthetic-retry-fixture-key" },
	});
	fireEvent.click(screen.getByRole("button", { name: "检查可用模型" }));
	const model = await screen.findByRole("checkbox", {
		name: "Primary endpoint · retry-model",
	});
	if (mode === "create") fireEvent.click(model);
	const submit = () =>
		fireEvent.click(
			screen.getByRole("button", {
				name: mode === "create" ? "提交审批" : "修改申请",
			}),
		);
	submit();
	await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
	return {
		onSubmit,
		check,
		submit,
		reject(code: string) {
			view.rerender(<AgentApplicationForm {...props} submitting />);
			view.rerender(<AgentApplicationForm {...props} serverError={{ code }} />);
		},
	};
}

it.each([
	["create", "INVALID_REQUEST"],
	["create", "MODEL_SELECTION_INVALID"],
	["update", "INVALID_REQUEST"],
	["update", "MODEL_SELECTION_INVALID"],
] as const)(
	"retries %s after %s when only a reasoning level changes",
	async (mode, code) => {
		const f = await prepare(mode);
		f.reject(code);
		f.submit();
		expect(f.onSubmit).toHaveBeenCalledTimes(1);
		fireEvent.click(
			screen.getByRole("checkbox", { name: /^高：.*retry-model$/ }),
		);
		expect(f.onSubmit).toHaveBeenCalledTimes(1);
		f.submit();
		await waitFor(() => expect(f.onSubmit).toHaveBeenCalledTimes(2));
		expect(
			f.onSubmit.mock.calls[1]?.[0].modelConfiguration.options[0]
				.reasoningLevels,
		).toEqual(["medium"]);
	},
);

it.each(["model", "default"])(
	"retries a model error after changing only the %s",
	async (change) => {
		const f = await prepare("create");
		f.reject("MODEL_SELECTION_INVALID");
		if (change === "model")
			fireEvent.click(screen.getByRole("checkbox", { name: /other-model$/ }));
		else {
			const select = screen.getByLabelText<HTMLSelectElement>("默认模型选项");
			const next = Array.from(select.options).find(
				(option) => option.value !== select.value,
			);
			if (!next) throw new Error("missing alternative default");
			fireEvent.change(select, { target: { value: next.value } });
		}
		f.submit();
		await waitFor(() => expect(f.onSubmit).toHaveBeenCalledTimes(2));
	},
);

it.each(["INVALID_REQUEST", "MODEL_SELECTION_INVALID"])(
	"recovers %s after successfully checking the same Key again",
	async (code) => {
		const f = await prepare("update");
		f.reject(code);
		f.check.mockResolvedValueOnce({
			candidates,
			configurationRevision: 8,
			keyVersion: 3,
		});
		fireEvent.click(screen.getByRole("button", { name: "检查可用模型" }));
		await screen.findByRole("checkbox", {
			name: "Primary endpoint · retry-model",
		});
		f.submit();
		await waitFor(() => expect(f.onSubmit).toHaveBeenCalledTimes(2));
		expect(f.onSubmit.mock.calls[1]?.[0]).toMatchObject({
			expectedConfigurationRevision: 8,
			expectedKeyVersion: 3,
		});
	},
);

it("keeps a failed Key recheck and an empty model selection blocked", async () => {
	const f = await prepare("update");
	f.reject("MODEL_SELECTION_INVALID");
	f.check.mockRejectedValueOnce(new Error("private check detail"));
	fireEvent.click(screen.getByRole("button", { name: "检查可用模型" }));
	await screen.findByText("Key 校验失败或暂时无法读取可用模型，请检查后重试。");
	f.submit();
	expect(f.onSubmit).toHaveBeenCalledTimes(1);
	expect(screen.queryByText("private check detail")).toBeNull();
});
