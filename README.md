# OpenClaw Slack Bug Report

OpenClaw plugin scaffold for Slack-native bug reports.

It captures a report from `/bug-report`, a configured reaction such as `:bug:`, or a normalized internal `slack_bug_report` event, then writes a durable `BUG_REPORT_CREATED` event to Loki. If runtime investigation hooks are available, it starts a bounded read-only investigation run and writes `INVESTIGATION_STARTED`.

## Initial contract

- Slack metadata is the spine: team, channel, `thread_ts`, `message_ts`, reporter, permalink, and timestamp.
- OpenClaw session id / agent id / clanker are bonus fields inferred from explicit metadata or recognizable text.
- Ephemeral ack is the default. Thread summaries are off unless the reporter requests one or severity crosses the configured threshold.
- Investigation is read-only by default. No restarts, config writes, publishing, pushing, deletion, or code fixes.

## Config

```json
{
  "slashCommandName": "/bug-report",
  "triggerEmoji": "bug",
  "ackMode": "ephemeral",
  "postThreadSummary": false,
  "threadSummarySeverityThreshold": "critical",
  "grafanaDashboardUrl": "https://grafana.example/d/bug-reports?var-report_id={{report_id}}",
  "loki": {
    "endpoint": "https://loki.example/loki/api/v1/push",
    "bearerToken": "secret-or-secretRef"
  },
  "allowedWorkspaces": ["T123"],
  "allowedChannels": ["C123"],
  "redaction": {
    "maxTextChars": 4000,
    "redactEmails": true,
    "redactTokens": true
  },
  "investigation": {
    "enabled": true,
    "readOnly": true,
    "timeoutMs": 120000
  }
}
```

## Events

The implementation registers conservative hooks:

- `slack_bug_report` for already-normalized report events.
- `slack_slash_command:bug-report` for slash command adapters that expose command-specific hooks.
- `slack_reaction_added` filtered by `triggerEmoji`.

OpenClaw's live Slack command/reaction event surface should be confirmed before enabling this in production. The core functions are intentionally pure and tested so adapters can be swapped without changing report semantics.

## Loki labels

`BUG_REPORT_CREATED` uses bounded labels:

- `source=slack_bug_report`
- `event=BUG_REPORT_CREATED`
- `team`
- `channel`
- `severity`
- `agent` when known
- `clanker` when known

Detailed report fields live in the JSON log body, not labels.

## Development

```sh
npm install
npm run check
npm test
```

## Release

Use the single release path documented in [RELEASING.md](./RELEASING.md):

```sh
npm run release -- X.Y.Z
```
