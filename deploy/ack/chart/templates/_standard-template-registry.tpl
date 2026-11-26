{{- define "agentInfra.standardTemplateRegistryEnv" -}}
{{- with .Values.standardTemplateRegistry }}
- name: AGENT_INFRA_STANDARD_TEMPLATE_REGISTRY
  value: {{ omit . "credentialsSecretRef" | toJson | quote }}
{{- end }}
{{- end }}

{{- define "agentInfra.standardTemplateRegistryMount" -}}
{{- with .Values.standardTemplateRegistry }}
- name: standard-template-registry
  mountPath: /var/run/agent-infra/standard-template-registry
  readOnly: true
{{- end }}
{{- end }}

{{- define "agentInfra.standardTemplateRegistryVolume" -}}
{{- with .Values.standardTemplateRegistry }}
- name: standard-template-registry
  secret:
    secretName: {{ .credentialsSecretRef.name | quote }}
    defaultMode: 288
    items: [{key: {{ .credentialsSecretRef.key | quote }}, path: credentials.json}]
{{- end }}
{{- end }}
