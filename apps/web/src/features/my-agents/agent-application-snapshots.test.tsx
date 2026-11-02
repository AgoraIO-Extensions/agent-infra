import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client as generatedClient } from "../../pilot/generated-v2/client.gen.js";
import type {
	AgentApplicationProjectionV2,
	WorkspaceSnapshotMetadataV1,
} from "../../pilot/generated-v2/types.gen.js";
import { AgentApplicationForm } from "./agent-application-form.js";
import {
	deploymentConfiguration,
	pendingApplication,
} from "./test-fixtures.js";
import { useAgentApplicationSubmission } from "./use-agent-application-submission.js";

const snapshot: WorkspaceSnapshotMetadataV1 = {
	snapshotId: "snapshot-repo",
	digest: `sha256:${"b".repeat(64)}`,
	sizeBytes: 128,
	unpackedSizeBytes: 256,
	fileCount: 2,
	mediaType: "application/x-tar+gzip",
	source: { kind: "direct-upload" },
	createdAt: "2026-11-02T00:00:00Z",
	status: "ready",
	bindings: [],
};
const manifest = JSON.stringify({
	schemaVersion: 1,
	entryServiceName: "web",
	resources: ["web", "worker"].flatMap((name) => [
		{
			apiVersion: "apps/v1",
			kind: "Deployment",
			metadata: { name, labels: { app: name } },
			spec: {
				replicas: 1,
				selector: { matchLabels: { app: name } },
				template: {
					metadata: { labels: { app: name } },
					spec: {
						containers: [
							{
								name,
								image: `sha256:${"a".repeat(64)}`,
								ports: [{ name: "http", port: 8080, targetPort: 8080 }],
							},
						],
					},
				},
			},
		},
		{
			apiVersion: "v1",
			kind: "Service",
			metadata: {
				name,
				labels: { app: name },
				...(name === "web"
					? { annotations: { "agent-infra.agora.io/entry": "true" } }
					: {}),
			},
			spec: {
				type: "ClusterIP",
				selector: { app: name },
				ports: [{ name: "http", port: 8080, targetPort: 8080 }],
			},
		},
	]),
});
let writes: { request: Request; body: Record<string, unknown> }[];
let reads: Request[];
const clients: QueryClient[] = [];
beforeEach(() => {
	writes = [];
	reads = [];
	generatedClient.setConfig({ baseUrl: "https://platform.test" });
	vi.stubGlobal(
		"fetch",
		vi.fn(async (request: Request) => {
			if (request.url.endsWith("/api/v2/me/workspace-snapshots")) {
				reads.push(request);
				return new Response(
					JSON.stringify([
						snapshot,
						{ ...snapshot, snapshotId: "snapshot-env" },
					]),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (request.method === "POST" || request.method === "PUT") {
				const body = await request.clone().json();
				writes.push({ request, body });
				return new Response(
					JSON.stringify({ ...pendingApplication, source: body.source }),
					{
						status: request.method === "POST" ? 201 : 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			return new Response(JSON.stringify({ items: [], nextCursor: null }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}),
	);
});
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	vi.unstubAllGlobals();
});

function Harness({
	application,
}: {
	application?: AgentApplicationProjectionV2;
}) {
	const submission = useAgentApplicationSubmission(application?.applicationId);
	return application ? (
		<AgentApplicationForm
			identityKey="user-1"
			mode="update"
			action="resubmit"
			application={application}
			deploymentConfiguration={deploymentConfiguration}
			submitting={submission.isPending}
			onSubmit={(body) => submission.update(application.applicationId, body)}
		/>
	) : (
		<AgentApplicationForm
			identityKey="user-1"
			mode="create"
			deploymentConfiguration={deploymentConfiguration}
			submitting={submission.isPending}
			onSubmit={submission.create}
		/>
	);
}
function renderForm(application?: AgentApplicationProjectionV2) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 0 },
			mutations: { retry: false },
		},
	});
	clients.push(client);
	return render(
		<QueryClientProvider client={client}>
			<Harness application={application} />
		</QueryClientProvider>,
	);
}
function choose(label: string, name: string) {
	fireEvent.click(screen.getByRole("combobox", { name: label }));
	const option = screen.getByRole("option", { name });
	fireEvent.pointerDown(option);
	fireEvent.pointerUp(option);
	fireEvent.click(option);
}
function fillBasics() {
	fireEvent.change(screen.getByLabelText("Agent 名称"), {
		target: { value: "Snapshot Agent" },
	});
	fireEvent.change(screen.getByLabelText("用途说明"), {
		target: { value: "Reads synthetic workspaces" },
	});
}
function fillCustom(
	kind: "platform-adapter" | "self-managed" | "multi-service",
) {
	choose(
		"Agent 来源",
		kind === "platform-adapter"
			? "自定义 Agent · 平台交互入口"
			: kind === "self-managed"
				? "自定义 Agent · 自有交互入口"
				: "多服务 Agent · 自有交互入口",
	);
	if (kind === "multi-service") {
		const field = document.getElementById("application-multi-service-manifest");
		if (!field) throw new Error("Missing manifest field");
		fireEvent.change(field, { target: { value: manifest } });
	} else {
		fireEvent.change(screen.getByLabelText("镜像地址"), {
			target: { value: "synthetic.test/agent:v1" },
		});
		if (kind === "self-managed") choose("入口身份校验", "由自有入口校验");
	}
}
async function selectSnapshot(id = "snapshot-repo") {
	const checkbox = await screen.findByRole("checkbox", {
		name: `选择快照 ${id}`,
	});
	fireEvent.click(checkbox);
	return checkbox;
}

describe("workspace snapshot selection through Agent application forms", () => {
	it.each(["platform-adapter", "self-managed", "multi-service"] as const)(
		"sends selected immutable snapshot IDs/names in the %s creation request",
		async (kind) => {
			renderForm();
			fillBasics();
			fillCustom(kind);
			await selectSnapshot();
			fireEvent.change(
				screen.getByRole("textbox", { name: "快照挂载名称 snapshot-repo" }),
				{ target: { value: "source" } },
			);
			fireEvent.click(screen.getByRole("button", { name: "提交审批" }));
			await waitFor(() => expect(writes).toHaveLength(1));
			expect(writes[0]?.request.url).toBe(
				"https://platform.test/api/v2/agent-applications",
			);
			expect(writes[0]?.request.headers.get("Idempotency-Key")).toBeTruthy();
			expect(writes[0]?.body.source).toMatchObject({
				kind: "custom",
				interactionMode:
					kind === "platform-adapter" ? "platform-adapter" : "self-managed",
				workspaceSnapshots: [
					{ snapshotId: snapshot.snapshotId, name: "source" },
				],
			});
			expect(writes[0]?.body.source).not.toHaveProperty("digest");
			if (kind === "multi-service")
				expect(writes[0]?.body.source).toHaveProperty("manifest", manifest);
			else
				expect(writes[0]?.body.source).toHaveProperty(
					"imageReference",
					"synthetic.test/agent:v1",
				);
			expect(reads).toHaveLength(1);
			expect(reads[0]?.headers.has("Authorization")).toBe(false);
		},
	);
	it("preserves projected multi-service bindings and submits explicit empty bindings after deselection", async () => {
		const application: AgentApplicationProjectionV2 = {
			...pendingApplication,
			status: "rejected",
			source: {
				kind: "custom",
				interactionMode: "self-managed",
				identityResponsibility: "self-managed",
				manifest,
				workspaceSnapshots: [{ snapshotId: snapshot.snapshotId, name: "repo" }],
			},
		};
		renderForm(application);
		const checkbox = await screen.findByRole("checkbox", {
			name: "选择快照 snapshot-repo",
		});
		expect(checkbox.getAttribute("aria-checked")).toBe("true");
		fireEvent.click(checkbox);
		fireEvent.click(screen.getByRole("button", { name: "修改并重新提交" }));
		await waitFor(() => expect(writes).toHaveLength(1));
		expect(writes[0]?.request.method).toBe("PUT");
		expect(writes[0]?.body.source).toMatchObject({
			manifest,
			workspaceSnapshots: [],
		});
	});
	it("retains bindings when editing another application field", async () => {
		const application: AgentApplicationProjectionV2 = {
			...pendingApplication,
			status: "rejected",
			source: {
				kind: "custom",
				imageReference: "synthetic.test/agent:v1",
				interactionMode: "platform-adapter",
				workspaceSnapshots: [{ snapshotId: snapshot.snapshotId, name: "repo" }],
			},
		};
		renderForm(application);
		await screen.findByRole("checkbox", { name: "选择快照 snapshot-repo" });
		fireEvent.change(screen.getByLabelText("用途说明"), {
			target: { value: "Updated usage" },
		});
		fireEvent.click(screen.getByRole("button", { name: "修改并重新提交" }));
		await waitFor(() => expect(writes).toHaveLength(1));
		expect(writes[0]?.body).toMatchObject({
			description: "Updated usage",
			source: {
				workspaceSnapshots: [{ snapshotId: snapshot.snapshotId, name: "repo" }],
			},
		});
	});
	it("disables snapshot edits while the submitted request is pending", async () => {
		const nativeFetch = globalThis.fetch;
		let finish: ((response: Response) => void) | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn((request: Request) =>
				request.method === "POST"
					? new Promise<Response>((resolve) => {
							finish = resolve;
						})
					: nativeFetch(request),
			),
		);
		renderForm();
		fillBasics();
		fillCustom("platform-adapter");
		const checkbox = await selectSnapshot();
		fireEvent.click(screen.getByRole("button", { name: "提交审批" }));
		await waitFor(() => expect(finish).toBeDefined());
		expect(
			checkbox.getAttribute("aria-disabled") === "true" ||
				checkbox.hasAttribute("disabled"),
		).toBe(true);
		expect(
			screen
				.getByRole("textbox", { name: "快照挂载名称 snapshot-repo" })
				.hasAttribute("disabled"),
		).toBe(true);
		finish?.(
			new Response(JSON.stringify(pendingApplication), {
				status: 201,
				headers: { "Content-Type": "application/json" },
			}),
		);
		await waitFor(() =>
			expect(checkbox.getAttribute("aria-disabled")).not.toBe("true"),
		);
	});

	it("blocks invalid and duplicate mount names before making a creation request", async () => {
		renderForm();
		fillBasics();
		fillCustom("platform-adapter");
		await selectSnapshot();
		const input = screen.getByRole("textbox", {
			name: "快照挂载名称 snapshot-repo",
		});
		fireEvent.change(input, { target: { value: "../escape" } });
		fireEvent.click(screen.getByRole("button", { name: "提交审批" }));
		expect(writes).toHaveLength(0);
		expect(screen.getByRole("alert").textContent).toContain("挂载名称");
		expect(document.activeElement).toBe(
			screen.getByRole("group", { name: "工作区快照选择" }),
		);
		fireEvent.change(input, { target: { value: "repo" } });
		await selectSnapshot("snapshot-env");
		fireEvent.change(
			screen.getByRole("textbox", { name: "快照挂载名称 snapshot-env" }),
			{ target: { value: "repo" } },
		);
		fireEvent.click(screen.getByRole("button", { name: "提交审批" }));
		expect(writes).toHaveLength(0);
		expect(screen.getByRole("alert").textContent).toBe(
			"快照挂载名称不能重复。",
		);
	});
	it("does not load snapshots for standard templates and clears them when switching back to standard", async () => {
		renderForm();
		expect(reads).toHaveLength(0);
		expect(screen.queryByRole("group", { name: "工作区快照选择" })).toBeNull();
		fillBasics();
		fillCustom("platform-adapter");
		await selectSnapshot();
		choose("Agent 来源", "标准模板");
		expect(screen.queryByRole("group", { name: "工作区快照选择" })).toBeNull();
		fillCustom("platform-adapter");
		expect(
			(
				await screen.findByRole("checkbox", { name: "选择快照 snapshot-repo" })
			).getAttribute("aria-checked"),
		).toBe("false");
		fireEvent.click(screen.getByRole("button", { name: "提交审批" }));
		await waitFor(() => expect(writes).toHaveLength(1));
		expect(writes[0]?.body.source).not.toHaveProperty("workspaceSnapshots");
	});
});
