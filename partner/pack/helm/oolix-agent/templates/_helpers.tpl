{{- define "oolix-agent.name" -}}{{ .Release.Name }}-oolix-agent{{- end -}}
{{- define "oolix-agent.store" -}}{{ .Release.Name }}-oolix-store{{- end -}}
{{- define "oolix-agent.labels" -}}
app.kubernetes.io/part-of: oolix-agent
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}
