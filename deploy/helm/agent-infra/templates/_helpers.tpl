{{- define "agent-infra.name" -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "agent-infra.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "agent-infra.componentName" -}}
{{- $limit := sub 62 (len .suffix) | int -}}
{{- $base := printf "%s-%s" .root.Release.Name .root.Chart.Name | trunc $limit | trimSuffix "-" -}}
{{- printf "%s-%s" $base .suffix -}}
{{- end -}}

{{- define "agent-infra.image" -}}
{{- printf "%s@%s" .repository .digest -}}
{{- end -}}

{{- define "agent-infra.validate" -}}
{{- $placeholderDigest := "sha256:0000000000000000000000000000000000000000000000000000000000000000" -}}
{{- if eq .Values.images.platformWorker.digest $placeholderDigest -}}
{{- fail "platform Worker image digest must be replaced" -}}
{{- end -}}
{{- if and (or .Values.migration.enabled (eq .Values.platformApi.placement "in-cluster")) (eq .Values.images.platformApi.digest $placeholderDigest) -}}
{{- fail "Platform API image digest must be replaced" -}}
{{- end -}}
{{- if and (eq .Values.web.placement "in-cluster") (eq .Values.images.web.digest $placeholderDigest) -}}
{{- fail "Web image digest must be replaced" -}}
{{- end -}}
{{- if and .Values.workloadTopology.enabled (eq .Values.images.runtimeHost.digest $placeholderDigest) -}}
{{- fail "Runtime Host image digest must be replaced" -}}
{{- end -}}
{{- if eq .Values.keys.encryptionPublicKey.secretRef.name .Values.keys.workerDecryptionKeyring.secretRef.name -}}
{{- fail "encryption public key and Worker decryption keyring must use different Secrets" -}}
{{- end -}}
{{- if not (has .Values.keys.encryptionPublicKey.version .Values.keys.workerDecryptionKeyring.versions) -}}
{{- fail "active encryption public key version must exist in the Worker decryption keyring" -}}
{{- end -}}
{{- if and .Values.workloadTopology.enabled (eq (int .Values.workloadTopology.service.runtimePort) (int .Values.workloadTopology.service.routePort)) -}}
{{- fail "workload runtime and route ports must be different" -}}
{{- end -}}
{{- end -}}
