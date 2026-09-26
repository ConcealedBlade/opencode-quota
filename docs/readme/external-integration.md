[← Back to README](../../README.md)

# Use quota data in other tools

OpenCode Quota can share its cached quota data with scripts, status bars, CI, and monitoring tools. These options do not make extra provider requests.

## Choose one option

| What you need | Use |
| --- | --- |
| Run a command and get JSON | `opencode-quota show --json` |
| Read the same JSON often | Export file |
| Send numbers to a monitoring system | OpenTelemetry metrics |

## 1. Get JSON from a command

Use this for scripts and CI:

```bash
opencode-quota show --json
```

Useful variations:

```bash
# Only Copilot
opencode-quota show --json --provider copilot

# Exit with an error when comparable quota is below 5%
opencode-quota show --json --threshold 5
```

Threshold exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Quota is available and above the threshold |
| `1` | At least one comparable cached percentage is below the threshold |
| `2` | Results were incomplete or no comparable percentage was found |

### CI example

```bash
npx @slkiser/opencode-quota@4 show --json --threshold 5
```

### Read Copilot's percentage with `jq`

Some Copilot results contain values instead of percentages. Select a percentage row instead of assuming the first row is one:

```bash
opencode-quota show --json --provider copilot \
  | jq -r '(.providers.copilot.entries? // []) | map(select(.renderType == "percent" and .percentRemaining != null)) | first | .percentRemaining // empty'
```

## 2. Read an export file

Use this for a status bar or another tool that checks quota often.

Add this to `opencode-quota/quota-toast.json`:

```jsonc
{
  "export": {
    "enabled": true,
  },
}
```

The file is normally written here:

```text
~/.cache/opencode/quota-export.json
```

If you set `XDG_CACHE_HOME`, the file is written to `$XDG_CACHE_HOME/opencode/quota-export.json` instead.

The TUI refreshes the file about once a minute. A write error is logged, but it does not break the TUI.

### tmux example

Add this to your tmux config:

```bash
set -g status-interval 30
set -g status-right '#(jq -r "[.providers|to_entries[]|select(.value.status==\"ok\")|first(.value.entries[]?|select(.renderType==\"percent\" and .percentRemaining!=null))|(.percentRemaining|floor|tostring)+\"%\"]|join(\" | \")" ~/.cache/opencode/quota-export.json 2>/dev/null)'
```

### Starship example

Add this to `starship.toml`:

```toml
[custom.quota]
command = "opencode-quota show --json 2>/dev/null | jq -r '[.providers|to_entries[]|select(.value.status==\"ok\")|first(.value.entries[]?|select(.renderType==\"percent\" and .percentRemaining!=null))|(.percentRemaining|floor|tostring)+\"%\"]|join(\" \")'"
when = "true"
interval = 60
```

## 3. Send OpenTelemetry metrics

Use this only when your OpenCode host already has an OpenTelemetry metrics provider and exporter. OpenCode Quota does not create or configure them.

Add this to `opencode-quota/quota-toast.json`:

```jsonc
{
  "telemetry": {
    "enabled": true,
  },
}
```

OpenCode Quota then publishes two gauges:

| Metric | Meaning |
| --- | --- |
| `opencode.quota.consumed` | Used quota from `0` to `1` |
| `opencode.quota.cache.age` | Age of cached data in seconds |

If the host has no global metrics provider, nothing is sent and OpenCode Quota continues normally.

<details>
<summary><strong>Metric fields and privacy</strong></summary>

`opencode.quota.consumed` uses percentage rows only. Its value is `(100 - percentRemaining) / 100`, limited to the range `0` to `1`. Quantity, boolean, legacy value, percentage-basis, and supplementary metadata do not create consumed gauges.

| Metric | Labels |
| --- | --- |
| `opencode.quota.consumed` | `quota.provider`, `quota.result_type`, `quota.window` |
| `opencode.quota.cache.age` | `quota.provider` |

Label values stay limited:

- `quota.provider` is a maintained provider ID, `custom`, or `other`.
- `quota.result_type` is `quota`, `rate_limit`, `usage`, `spend`, `budget`, `balance`, or `status`.
- `quota.window` is `rpm`, `five_hour`, `hour`, `day`, `week`, `month`, `year`, `mcp`, `code_review`, or `unknown`.

When several rows map to the same safe labels, OpenCode Quota reports the highest consumed ratio or oldest cache age. Display names, account IDs, configured source IDs, credentials, URLs, paths, errors, and raw responses are never labels.

</details>

<details>
<summary><strong>Minimal host setup example</strong></summary>

Register the provider before OpenCode loads OpenCode Quota. Replace the console exporter with your real exporter.

```javascript
import { metrics } from "@opentelemetry/api";
import {
  ConsoleMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";

const reader = new PeriodicExportingMetricReader({
  exporter: new ConsoleMetricExporter(),
  exportIntervalMillis: 60_000,
});
const provider = new MeterProvider({ readers: [reader] });
metrics.setGlobalMeterProvider(provider);

export async function shutdownMetrics() {
  await provider.shutdown();
}
```

</details>

## JSON basics

The command and export file both use JSON schema version `2`.

Every provider has `status`. Other fields depend on that status:

- `ok`: `fetchedAt` and `entries`
- `partial`: `fetchedAt`, `entries`, and `errors`
- `error`: `fetchedAt` and a safe `error` message
- `unavailable`: no other fields are required

Provider statuses:

| Status | Meaning |
| --- | --- |
| `ok` | Data is available |
| `partial` | Some data worked and some failed |
| `error` | The provider failed |
| `unavailable` | No matching cached data exists |

A percentage entry uses `renderType: "percent"` and `percentRemaining`. A value entry uses `renderType: "value"` and `value`. Internally typed quantities flatten into formatted value strings (for example, `USD 12.50`), and booleans flatten to `Enabled` or `Disabled`.

Version 2 does not expose internal semantic metrics, primary/supplementary prominence, used/limit/remaining basis facts, or per-fact authority. The export uses the complete cached provider snapshot, so `accountingDetail`, `formatStyle`, and `percentDisplayMode` do not change machine output and supplementary rows can add more value entries. Scripts must not assume the first row is a percentage or that one provider produces only one row; select `renderType`, `resultType`, and any other required fields explicitly. Threshold checks consider percentage rows only.

Optional entry fields include `window`, `resetAt`, `observedAt`, and `sourceId`. A provider can also include `rawDetails`: sanitized provider-owned key/value facts that stay out of normal quota displays.

Configured `quotaProviders` entries include `sourceId`. The `quota-providers` result includes a `sources` list so tools can match each result to its configured source. Treat `status: "partial"` as incomplete.

`rawDetails` is curated and safe to export. Secrets, credentials, URLs, checked paths, and raw provider responses remain excluded from public JSON. Use `/quota_status` when you need live diagnostics.

<details>
<summary><strong>Configured source details</strong></summary>

Rows from a configured `quotaProviders` definition appear under `providers["quota-providers"]` and keep their stable `sourceId`:

```json
{
  "sourceId": "openrouter-primary",
  "renderType": "percent",
  "percentRemaining": 40
}
```

The provider also includes a summary for every configured source:

```json
"sources": [
  {
    "id": "openrouter-primary",
    "providerId": "openrouter",
    "status": "ok",
    "entryCount": 1
  }
]
```

Each summary is exactly `id`, effective `providerId`, coarse `status`, and `entryCount`. A source can be `ok` after producing valid rows while failed mapping candidates can still make the aggregate provider `partial`.

</details>

<details>
<summary><strong>Small JSON example</strong></summary>

```json
{
  "version": 2,
  "exportedAt": 1748736000,
  "fromCache": true,
  "cacheAgeSeconds": 42,
  "providers": {
    "copilot": {
      "status": "ok",
      "fetchedAt": 1748735958,
      "entries": [
        {
          "name": "Premium Requests",
          "resultType": "quota",
          "acquisitionMethod": "remote_api",
          "ownership": "maintained",
          "authority": "provider_reported",
          "renderType": "percent",
          "percentRemaining": 62.3
        }
      ]
    }
  }
}
```

</details>

## Important behavior

- All options use data collected during normal OpenCode Quota activity.
- The command and export file read cached data instead of contacting providers.
- The OpenTelemetry integration reads in-memory results and never starts its own refresh loop.
- OpenTelemetry metric labels are limited to safe provider, result type, and quota-window values.
- Display names, account IDs, source IDs, credentials, paths, URLs, errors, and raw responses are never metric labels.
