import type { V1SecurityContext } from "@kubernetes/client-node";
import { vi } from "vitest";
import { fakeKubernetesApi, workloadTestPolicy } from "./kubernetes.fixture.js";
import { createKubernetesRuntimeAdapterV1 } from "./kubernetes-runtime-adapter.js";

export type SecurityContextMutation = (
	securityContext: V1SecurityContext | undefined,
) => V1SecurityContext;

export function fixture() {
	const api = fakeKubernetesApi();
	const probe = vi.fn(async () => true);
	const adapter = () =>
		createKubernetesRuntimeAdapterV1({
			client: api.client,
			policy: workloadTestPolicy,
			probe,
		});
	return { ...api, probe, adapter };
}
