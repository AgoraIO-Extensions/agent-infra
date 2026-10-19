import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CapabilityInvocation } from "./conversation-capability-lifecycle.js";
import { CapabilityReceipt } from "./conversation-capability-receipt.js";

afterEach(cleanup);

const invocation: CapabilityInvocation = {
	executionId: "execution-1",
	kind: "command",
	name: "status",
	source: "native",
};

describe("CapabilityReceipt (N-12)", () => {
	it("names its buttons after the invoked command", () => {
		const onDetails = vi.fn();
		const onVerify = vi.fn();
		render(
			<CapabilityReceipt
				invocation={invocation}
				phase="unknown"
				onDetails={onDetails}
				onVerify={onVerify}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "调用详情：status" }));
		fireEvent.click(screen.getByRole("button", { name: "核实原操作：status" }));
		expect(onDetails).toHaveBeenCalledOnce();
		expect(onVerify).toHaveBeenCalledOnce();
	});

	it("uses the distinct object name when the same command runs twice", () => {
		render(
			<>
				<CapabilityReceipt
					invocation={invocation}
					phase="completed"
					objectName="status（第 1 次）"
					onDetails={() => undefined}
					onVerify={() => undefined}
				/>
				<CapabilityReceipt
					invocation={{ ...invocation, executionId: "execution-2" }}
					phase="completed"
					objectName="status（第 2 次）"
					onDetails={() => undefined}
					onVerify={() => undefined}
				/>
			</>,
		);
		expect(
			screen
				.getAllByRole("button", { name: /^调用详情：/ })
				.map((button) => button.getAttribute("aria-label")),
		).toEqual(["调用详情：status（第 1 次）", "调用详情：status（第 2 次）"]);
	});
});
