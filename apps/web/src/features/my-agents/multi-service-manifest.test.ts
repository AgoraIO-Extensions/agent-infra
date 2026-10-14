import { describe, expect, it } from "vitest";
import {
	formatMultiServiceManifestSummary,
	MULTI_SERVICE_MANIFEST_MAX_BYTES,
	parseMultiServiceManifest,
} from "./multi-service-manifest.js";

const digest = `sha256:${"a".repeat(64)}`;
const manifest = `schemaVersion: 1
entryServiceName: api
resources:
  - apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: api
      labels:
        app: payments
    spec:
      replicas: 1
      selector:
        matchLabels:
          app: payments
      template:
        metadata:
          labels:
            app: payments
        spec:
          containers:
            - name: api
              image: ${digest}
  - apiVersion: v1
    kind: Service
    metadata:
      name: api
      labels:
        app: payments
      annotations:
        agent-infra.agora.io/entry: "true"
        agent-infra.agora.io/resource-profile: small
    spec:
      type: ClusterIP
      selector:
        app: payments
      ports:
        - name: http
          port: 8080
          targetPort: 8080
`;

describe("multi-service manifest parsing", () => {
	it("validates YAML and returns a service and entry summary", () => {
		const result = parseMultiServiceManifest(manifest);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.summary).toEqual({
			entryServiceName: "api",
			resourceCount: 2,
			serviceNames: ["api"],
			resourceProfileRefs: ["small"],
		});
		expect(formatMultiServiceManifestSummary(result.summary)).toContain(
			"规格引用：small",
		);
	});

	it("rejects malformed and semantically invalid YAML", () => {
		expect(parseMultiServiceManifest("resources: [")).toEqual({
			ok: false,
			message: "多服务 YAML 语法不正确，请检查缩进和字段。",
		});
		const invalid = manifest.replace(
			"entryServiceName: api",
			"entryServiceName: worker",
		);
		const result = parseMultiServiceManifest(invalid);
		expect(result.ok).toBe(false);
		expect(result).toEqual({
			ok: false,
			message:
				"多服务 YAML 不符合受限资源清单格式，请检查资源、入口服务和镜像 Digest。",
		});
	});

	it("rejects a manifest over the contract byte limit before parsing", () => {
		const oversized = `${manifest}\n#${"x".repeat(MULTI_SERVICE_MANIFEST_MAX_BYTES)}`;
		expect(parseMultiServiceManifest(oversized)).toEqual({
			ok: false,
			message: `多服务 YAML 不能超过 ${MULTI_SERVICE_MANIFEST_MAX_BYTES} bytes。`,
		});
	});
});
