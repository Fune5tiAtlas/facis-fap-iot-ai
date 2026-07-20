{{/*
Expand the name of the chart.
*/}}
{{- define "facis-industrial-ingestion.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "facis-industrial-ingestion.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "facis-industrial-ingestion.labels" -}}
helm.sh/chart: {{ include "facis-industrial-ingestion.name" . }}-{{ .Chart.Version | replace "+" "_" }}
{{ include "facis-industrial-ingestion.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "facis-industrial-ingestion.selectorLabels" -}}
app.kubernetes.io/name: {{ include "facis-industrial-ingestion.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
ServiceAccount name
*/}}
{{- define "facis-industrial-ingestion.serviceAccountName" -}}
{{- if .Values.serviceAccount.name }}
{{- .Values.serviceAccount.name }}
{{- else }}
{{- include "facis-industrial-ingestion.fullname" . }}
{{- end }}
{{- end }}
