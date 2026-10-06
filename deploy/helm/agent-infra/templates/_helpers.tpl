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
{{- $consumer := .Values.connectionConsumer | default dict -}}
{{- $source := required "connectionConsumer.source is required" $consumer.source -}}
{{- if not (has $source (list "inline" "external")) -}}
{{- fail "connectionConsumer.source must be inline or external" -}}
{{- end -}}
{{- $inline := $consumer.inline | default dict -}}
{{- $external := $consumer.external | default dict -}}
{{- if eq $source "inline" -}}
{{- if not $consumer.inline -}}{{- fail "connectionConsumer.inline is required for inline source" -}}{{- end -}}
{{- if gt (len $external) 0 -}}{{- fail "connectionConsumer.inline and external sources conflict" -}}{{- end -}}
{{- if ne (int ($inline.schemaVersion | default 0)) 1 -}}{{- fail "connectionConsumer.inline.schemaVersion must be 1" -}}{{- end -}}
{{- $origin := required "connectionConsumer.inline.publicOrigin is required" $inline.publicOrigin -}}
{{- if not (regexMatch `^https://(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:]+\])(?::(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?$` $origin) -}}{{- fail "connectionConsumer.inline.publicOrigin must be a canonical HTTPS origin without path, query, fragment, or credentials" -}}{{- end -}}
{{- $path := required "connectionConsumer.inline.mcpPath is required" $inline.mcpPath -}}
{{- if or (not (hasPrefix "/" $path)) (hasPrefix "//" $path) (regexMatch `[?#\\\s]` $path) (regexMatch `(^|/)\.\.?(/|$)` $path) (regexMatch `(?i)%(?:2f|2e|5c)` $path) -}}{{- fail "connectionConsumer.inline.mcpPath must be a safe absolute path" -}}{{- end -}}
{{- if not ($inline.consumerId | default "") -}}{{- fail "connectionConsumer.inline.consumerId is required" -}}{{- end -}}
{{- if not ($inline.audience | default "") -}}{{- fail "connectionConsumer.inline.audience is required" -}}{{- end -}}
{{- if not $inline.egressProfile -}}{{- fail "connectionConsumer.inline.egressProfile is required" -}}{{- end -}}
{{- if not $inline.egressProfile.ref -}}{{- fail "connectionConsumer.inline.egressProfile.ref is required" -}}{{- end -}}
{{- if not $inline.egressProfile.revision -}}{{- fail "connectionConsumer.inline.egressProfile.revision is required" -}}{{- end -}}
{{- if not $inline.approval -}}{{- fail "connectionConsumer.inline.approval is required" -}}{{- end -}}
{{- if ne $inline.approval.egressEnforced true -}}{{- fail "connectionConsumer.inline.approval.egressEnforced must be true" -}}{{- end -}}
{{- if not $inline.approval.source.ref -}}{{- fail "connectionConsumer.inline.approval.source.ref is required" -}}{{- end -}}
{{- if not $inline.approval.source.revision -}}{{- fail "connectionConsumer.inline.approval.source.revision is required" -}}{{- end -}}
{{- else -}}
{{- if not $consumer.external -}}{{- fail "connectionConsumer.external is required for external source" -}}{{- end -}}
{{- if gt (len $inline) 0 -}}{{- fail "connectionConsumer.inline and external sources conflict" -}}{{- end -}}
{{- range $key := list "configMapName" "configMapKey" "configVersion" "configFingerprint" "sourceRef" "sourceRevision" -}}{{- if not (index $external $key) -}}{{- fail (printf "connectionConsumer.external.%s is required" $key) -}}{{- end -}}{{- end -}}
{{- if not (regexMatch `^1-[a-f0-9]{64}$` $external.configVersion) -}}{{- fail "connectionConsumer.external.configVersion must be 1-<sha256>" -}}{{- end -}}
{{- if not (regexMatch `^[a-f0-9]{64}$` $external.configFingerprint) -}}{{- fail "connectionConsumer.external.configFingerprint must be a sha256" -}}{{- end -}}
{{- if ne (trimPrefix "1-" $external.configVersion) $external.configFingerprint -}}{{- fail "connectionConsumer.external.configVersion and configFingerprint must agree" -}}{{- end -}}
{{- end -}}
{{- end -}}

{{- define "agent-infra.connectionProfileName" -}}
{{- include "agent-infra.componentName" (dict "root" . "suffix" "connection-consumer") -}}
{{- end -}}

{{- define "agent-infra.connectionFingerprint" -}}
{{- $profile := .Values.connectionConsumer.inline -}}
{{- sha256sum (toJson (list $profile.schemaVersion $profile.publicOrigin $profile.mcpPath $profile.consumerId $profile.audience $profile.egressProfile.ref $profile.egressProfile.revision)) -}}
{{- end -}}

{{- define "agent-infra.connectionEnv" -}}
{{- if eq .Values.connectionConsumer.source "external" -}}
- name: AGENT_INFRA_CONNECTION_PROFILE
  valueFrom:
    configMapKeyRef:
      name: {{ .Values.connectionConsumer.external.configMapName }}
      key: {{ .Values.connectionConsumer.external.configMapKey }}
      optional: false
- name: AGENT_INFRA_CONNECTION_CONFIG_VERSION
  value: {{ .Values.connectionConsumer.external.configVersion | quote }}
- name: AGENT_INFRA_CONNECTION_CONFIG_FINGERPRINT
  value: {{ .Values.connectionConsumer.external.configFingerprint | quote }}
- name: AGENT_INFRA_CONNECTION_APPROVAL_SOURCE_REF
  value: {{ .Values.connectionConsumer.external.sourceRef | quote }}
- name: AGENT_INFRA_CONNECTION_APPROVAL_SOURCE_REVISION
  value: {{ .Values.connectionConsumer.external.sourceRevision | quote }}
{{- end -}}
{{- end -}}

{{- define "agent-infra.connectionEnvFrom" -}}
{{- if eq .Values.connectionConsumer.source "inline" -}}
- configMapRef:
    name: {{ include "agent-infra.connectionProfileName" . }}
{{- end -}}
{{- end -}}
