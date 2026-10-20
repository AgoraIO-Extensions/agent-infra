{{- define "ack.labels" -}}
app.kubernetes.io/name: agent-infra
app.kubernetes.io/managed-by: Helm
{{- end }}
{{- define "ack.pullSecrets" -}}
{{- with .Values.images.pullSecrets }}
imagePullSecrets:
{{- range . }}
  - name: {{ . }}
{{- end }}
{{- end }}
{{- end }}
{{- define "ack.securityContext" -}}
runAsNonRoot: true
runAsUser: 1000
runAsGroup: 1000
fsGroup: 1000
seccompProfile:
  type: RuntimeDefault
{{- end }}
{{- define "ack.scheduling" -}}
{{- with . }}
{{- with .nodeSelector }}
nodeSelector:
{{ toYaml . | nindent 2 }}
{{- end }}
{{- with .tolerations }}
tolerations:
{{ toYaml . | nindent 2 }}
{{- end }}
{{- end }}
{{- end }}
