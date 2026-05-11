import type {
  LokiEvent,
  OpenClawContext,
  RedactionConfig,
  Severity,
  SlackBugReport,
  SlackBugReportConfig,
  SlackBugReportInput,
} from "./types.js";

const SEVERITY_ORDER: Severity[] = ["low", "medium", "high", "critical"];

export function normalizeSeverity(value: unknown): Severity {
  return value === "medium" || value === "high" || value === "critical" || value === "low" ? value : "medium";
}

export function createReportId(now = Date.now(), random = Math.random): string {
  const date = new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = Math.floor(random() * 0x1000000).toString(36).padStart(5, "0").slice(0, 6);
  return `br_${date}_${suffix}`;
}

export function sanitizeText(value: unknown, config: RedactionConfig = {}): string | undefined {
  if (typeof value !== "string") return undefined;
  const maxTextChars = Math.max(1, Math.floor(config.maxTextChars ?? 4000));
  let text = value.slice(0, maxTextChars);
  if (config.redactEmails !== false) {
    text = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]");
  }
  if (config.redactTokens !== false) {
    text = text
      .replace(/xox[baprs]-[A-Za-z0-9-]+/g, "[redacted-slack-token]")
      .replace(/\b(?:sk|pk|ghp|github_pat)_[A-Za-z0-9_\-]{16,}\b/g, "[redacted-token]")
      .replace(/\b[A-Za-z0-9_\-]{32,}\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}\b/g, "[redacted-token]");
  }
  return text;
}

export function extractOpenClawContext(input: SlackBugReportInput): Partial<OpenClawContext> {
  const explicit = input.openclaw ?? {};
  const haystack = [input.targetText, input.userNote, input.reproNotes].filter(Boolean).join("\n");
  return removeEmpty({
    sessionId: explicit.sessionId ?? matchFirst(haystack, /\bsession(?:Id| id)?[:= ]+([A-Za-z0-9_.:-]+)/i),
    sessionKey: explicit.sessionKey ?? matchFirst(haystack, /\b(agent:[A-Za-z0-9_.:-]+)/),
    agentId: explicit.agentId ?? matchFirst(haystack, /\bagent(?:Id| id)?[:= ]+([A-Za-z0-9_.:-]+)/i),
    clanker: explicit.clanker ?? matchFirst(haystack, /\bclanker[:= ]+([A-Za-z0-9_.:-]+)/i),
    model: explicit.model,
    host: explicit.host,
    node: explicit.node,
  });
}

export function shouldPostThreadSummary(report: Pick<SlackBugReport, "severity" | "postThreadSummary">, config: SlackBugReportConfig = {}): boolean {
  if (report.postThreadSummary) return true;
  if (config.postThreadSummary === true) return true;
  const threshold = config.threadSummarySeverityThreshold ?? "critical";
  if (threshold === "never") return false;
  return SEVERITY_ORDER.indexOf(report.severity) >= SEVERITY_ORDER.indexOf(threshold);
}

export function buildGrafanaUrl(template: string | undefined, reportId: string): string | undefined {
  return template ? template.replaceAll("{{report_id}}", encodeURIComponent(reportId)) : undefined;
}

export function createBugReport(input: SlackBugReportInput, config: SlackBugReportConfig = {}, opts: { now?: number; random?: () => number } = {}): SlackBugReport {
  if (!input.channelId) throw new Error("channelId is required");
  const now = opts.now ?? input.createdAt ?? Date.now();
  const reportId = createReportId(now, opts.random);
  const redaction = config.redaction ?? {};
  const severity = normalizeSeverity(input.severity);
  const report: SlackBugReport = {
    reportId,
    source: input.source,
    teamId: input.teamId,
    teamDomain: input.teamDomain,
    channelId: input.channelId,
    channelName: input.channelName,
    threadTs: input.threadTs,
    messageTs: input.messageTs,
    reporterUserId: input.reporterUserId,
    targetUserId: input.targetUserId,
    createdAt: now,
    permalink: input.permalink,
    severity,
    userNote: sanitizeText(input.userNote, redaction),
    expectedBehavior: sanitizeText(input.expectedBehavior, redaction),
    reproNotes: sanitizeText(input.reproNotes, redaction),
    targetText: sanitizeText(input.targetText, redaction),
    openclaw: extractOpenClawContext(input),
    grafanaUrl: buildGrafanaUrl(config.grafanaDashboardUrl, reportId),
    postThreadSummary: Boolean(input.postThreadSummary),
  };
  return report;
}

export function buildAckText(report: SlackBugReport, investigationStarted = false): string {
  const lines = [`Bug report logged: ${report.reportId}`];
  if (investigationStarted) lines.push("Investigation started.");
  if (report.grafanaUrl) lines.push(`Grafana: ${report.grafanaUrl}`);
  return lines.join("\n");
}

export function buildThreadSummary(report: SlackBugReport): string {
  const parts = [`Bug report ${report.reportId} captured`, `severity=${report.severity}`];
  if (report.grafanaUrl) parts.push(`Grafana: ${report.grafanaUrl}`);
  return parts.join(" • ");
}

export function buildCreatedLokiEvent(report: SlackBugReport, nowNs = BigInt(report.createdAt) * 1_000_000n): LokiEvent {
  const labels = removeEmpty({
    source: "slack_bug_report",
    event: "BUG_REPORT_CREATED",
    team: report.teamId,
    channel: report.channelId,
    severity: report.severity,
    agent: report.openclaw.agentId,
    clanker: report.openclaw.clanker,
  });
  const payload = {
    type: "BUG_REPORT_CREATED",
    report_id: report.reportId,
    source: report.source,
    permalink: report.permalink,
    thread_ts: report.threadTs,
    message_ts: report.messageTs,
    reporter: report.reporterUserId,
    timestamp: new Date(report.createdAt).toISOString(),
    severity: report.severity,
    user_note: report.userNote,
    expected_behavior: report.expectedBehavior,
    repro_notes: report.reproNotes,
    target_text: report.targetText,
    openclaw: report.openclaw,
    grafana_url: report.grafanaUrl,
  };
  return { streams: [{ stream: labels, values: [[nowNs.toString(), JSON.stringify(payload)]] }] };
}

export function isAllowed(input: SlackBugReportInput, config: SlackBugReportConfig = {}): boolean {
  if (config.allowedWorkspaces?.length && (!input.teamId || !config.allowedWorkspaces.includes(input.teamId))) return false;
  if (config.allowedChannels?.length && !config.allowedChannels.includes(input.channelId)) return false;
  return true;
}

function matchFirst(text: string, regex: RegExp): string | undefined {
  return regex.exec(text)?.[1];
}

function removeEmpty<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === "string" ? v.length > 0 : v != null)) as T;
}
