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
{{- if .Values.nativeMetadata.enabled -}}
{{- if or .Values.workloadTopology.enabled (ne (int .Values.platformWorker.replicas) 1) -}}
{{- fail "native metadata requires one production Worker instance" -}}
{{- end -}}
{{- if or (lt (int .Values.nativeMetadata.workerPort) 1024) (gt (int .Values.nativeMetadata.workerPort) 65535) -}}
{{- fail "native metadata Worker port is invalid" -}}
{{- end -}}
{{- $workerSecret := required "nativeMetadata.workerConfigurationSecretRef.name is required" .Values.nativeMetadata.workerConfigurationSecretRef.name -}}
{{- $apiSecret := required "nativeMetadata.apiConfigurationSecretRef.name is required" .Values.nativeMetadata.apiConfigurationSecretRef.name -}}
{{- $keyringSecret := .Values.keys.workerDecryptionKeyring.secretRef.name -}}
{{- $businessConfigurationSecret := get (.Values.platformWorker.configurationModuleSecretRef | default dict) "name" | default "" -}}
{{- $runtimeSecret := get (.Values.platformWorker.runtimeAuthSecretRef | default dict) "name" | default "" -}}
{{- if or (eq $workerSecret $apiSecret) (eq $workerSecret $keyringSecret) (eq $apiSecret $keyringSecret) (eq $workerSecret $runtimeSecret) (eq $apiSecret $runtimeSecret) (eq $workerSecret $businessConfigurationSecret) (eq $apiSecret $businessConfigurationSecret) -}}
{{- fail "native metadata configuration Secrets must be separate from each other and business Worker material" -}}
{{- end -}}
{{- end -}}
{{- $placeholderDigest := "sha256:0000000000000000000000000000000000000000000000000000000000000000" -}}
{{- if eq .Values.images.platformWorker.digest $placeholderDigest -}}
{{- fail "platform Worker image digest must be replaced" -}}
{{- end -}}

{{- if and .Values.enterpriseDirectorySync.enabled (eq .Values.images.enterpriseDirectorySync.digest $placeholderDigest) -}}
{{- fail "Enterprise Directory Sync image digest must be replaced" -}}
{{- end -}}
{{- if and .Values.enterpriseDirectorySync.enabled (not .Values.enterpriseDirectorySync.corpId) -}}
{{- fail "Enterprise Directory Sync corpId is required" -}}
{{- end -}}
{{- if and .Values.enterpriseDirectorySync.enabled .Values.migration.enabled (not .Values.enterpriseDirectorySync.runtimeDatabaseRole) -}}
{{- fail "Enterprise Directory Sync runtimeDatabaseRole is required for migration" -}}
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

{{- define "agent-infra.nativeMetadataPeer" -}}
{{- if .ip -}}
{{- if not (regexMatch "^[0-9a-fA-F:.]+/(32|128)$" .ip) -}}
{{- fail "native metadata endpoint must use one /32 or /128 address" -}}
{{- end -}}
ipBlock:
  cidr: {{ .ip | quote }}
{{- else -}}
namespaceSelector:
  matchLabels:
    kubernetes.io/metadata.name: {{ required "native metadata peer namespace is required" .namespace | quote }}
podSelector:
  matchLabels:
    {{- required "native metadata peer podLabels must be nonempty" .podLabels | toYaml | nindent 4 }}
{{- end -}}
{{- end -}}
