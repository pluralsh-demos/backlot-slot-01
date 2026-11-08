{{/*
Chart name. Workload names stay unqualified (api, web) because each slot
has its own namespace.
*/}}
{{- define "poster-meteor.name" -}}
{{- .Chart.Name -}}
{{- end }}

{{/*
Chart name and version, used by the standard Helm chart label.
*/}}
{{- define "poster-meteor.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end }}

{{/*
Ingress host: <pack.hostnamePrefix>-<slot.number>.<domain>
Example: poster-meteor-01.backlot.plural.sh
*/}}
{{- define "poster-meteor.hostname" -}}
{{- printf "%s-%s.%s" .Values.pack.hostnamePrefix .Values.slot.number .Values.domain -}}
{{- end }}

{{/*
CNPG Cluster name. The operator creates the <name>-app secret; its uri key is DATABASE_URL.
*/}}
{{- define "poster-meteor.clusterName" -}}
poster-meteor
{{- end }}

{{- define "poster-meteor.databaseSecret" -}}
{{- printf "%s-app" (include "poster-meteor.clusterName" .) -}}
{{- end }}

{{- define "poster-meteor.api.image" -}}
{{- printf "%s:%s" .Values.api.image.repository .Values.api.image.tag -}}
{{- end }}

{{/*
Hook Job name: poster-meteor-<kind>-<tag>. The tag is api.image.tag, lowercased,
with characters outside DNS-1123 removed. The name is kept within 63 characters.
*/}}
{{- define "poster-meteor.hookJobName" -}}
{{- $tag := .root.Values.api.image.tag | toString | lower -}}
{{- $tag = regexReplaceAll "[^a-z0-9-]" $tag "" | trimAll "-" -}}
{{- printf "poster-meteor-%s-%s" .kind $tag | trunc 63 | trimAll "-" -}}
{{- end }}

{{- define "poster-meteor.web.image" -}}
{{- printf "%s:%s" .Values.web.image.repository .Values.web.image.tag -}}
{{- end }}

{{- define "poster-meteor.worker.image" -}}
{{- printf "%s:%s" .Values.worker.image.repository .Values.worker.image.tag -}}
{{- end }}

{{/*
CNPG parameter values are strings.
*/}}
{{- define "poster-meteor.postgres.maxConnections" -}}
{{- .Values.postgres.maxConnections | toString | quote -}}
{{- end }}

{{- define "poster-meteor.labels" -}}
helm.sh/chart: {{ include "poster-meteor.chart" . }}
app.kubernetes.io/name: {{ include "poster-meteor.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: poster-meteor
{{- end }}

{{- define "poster-meteor.selectorLabels" -}}
app.kubernetes.io/name: {{ include "poster-meteor.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Workload labels. api and web keep distinct names so their selectors do not overlap.
*/}}
{{- define "poster-meteor.workloadLabels" -}}
helm.sh/chart: {{ include "poster-meteor.chart" .root }}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/version: {{ .root.Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
app.kubernetes.io/part-of: poster-meteor
app.kubernetes.io/component: {{ .name }}
{{- end }}

{{- define "poster-meteor.workloadSelectorLabels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- end }}

{{/*
Shell for migrate and seed. Waits until Postgres accepts a connection, then
runs .steps. The pre-install migrate hook sets skipIfUnset because the CNPG
app secret does not exist until the Cluster manifest is applied.
*/}}
{{- define "poster-meteor.db.script" -}}
set -eu
{{- if .skipIfUnset }}
if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is unset; skipping"
  exit 0
fi
{{- end }}
i=0
until node --input-type=module -e 'import { createRequire } from "node:module"; const { Pool } = createRequire("/app/package.json")("pg"); const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 2000 }); try { const client = await pool.connect(); await client.query("SELECT 1"); client.release(); } finally { await pool.end(); }'; do
  i=$((i + 1))
  if [ "$i" -ge 150 ]; then
    echo "postgres did not become ready" >&2
    exit 1
  fi
  echo "waiting for postgres ($i)"
  sleep 2
done
{{- range .steps }}
{{ . }}
{{- end }}
{{- end }}

{{/*
Pod template shared by the seed hook Job and the poster-meteor-seed CronJob.
*/}}
{{- define "poster-meteor.seed.podTemplate" -}}
metadata:
  labels:
    {{- include "poster-meteor.workloadLabels" (dict "root" . "name" "seed") | nindent 4 }}
spec:
  restartPolicy: Never
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
  containers:
    - name: seed
      image: {{ include "poster-meteor.api.image" . | quote }}
      imagePullPolicy: IfNotPresent
      command: ["sh", "-c"]
      args:
        - |
{{ include "poster-meteor.db.script" (dict "steps" (list "node apps/api/dist/migrate.js" "exec node apps/api/dist/seed.js")) | indent 10 }}
      env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: {{ include "poster-meteor.databaseSecret" . }}
              key: uri
      securityContext:
        allowPrivilegeEscalation: false
        capabilities:
          drop:
            - ALL
{{- end }}
