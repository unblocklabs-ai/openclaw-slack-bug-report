import type { InvestigationCompleted, InvestigationConfig, InvestigationStarted, SlackBugReport } from "./types.js";

export function shouldStartInvestigation(report: SlackBugReport, config: InvestigationConfig = {}): boolean {
  if (config.enabled === false) return false;
  return Boolean(report.openclaw.sessionId || report.openclaw.sessionKey || report.openclaw.agentId || report.threadTs || report.permalink);
}

export function buildInvestigationPrompt(report: SlackBugReport, config: InvestigationConfig = {}): string {
  const readOnly = config.readOnly !== false;
  return [
    `Investigate Slack bug report ${report.reportId}.`,
    `Read-only: ${readOnly ? "yes" : "no"}.`,
    "Collect context only: recent transcript, tool failures, gateway/plugin errors, session id, agent id, model, host/node, Slack delivery state, likely failure layer, confidence, and recommended next step.",
    "Do not restart services, edit config, publish, push, delete data, or fix code unless the report explicitly allows writes.",
    `Slack permalink: ${report.permalink ?? "unknown"}`,
    `Slack channel: ${report.channelId}`,
    `thread_ts: ${report.threadTs ?? "unknown"}`,
    `message_ts: ${report.messageTs ?? "unknown"}`,
    `OpenClaw context: ${JSON.stringify(report.openclaw)}`,
    `User note: ${report.userNote ?? "none"}`,
  ].join("\n");
}

export function createInvestigationStarted(report: SlackBugReport, runId: string, config: InvestigationConfig = {}, now = Date.now()): InvestigationStarted {
  return {
    type: "INVESTIGATION_STARTED",
    reportId: report.reportId,
    runId,
    startedAt: now,
    readOnly: config.readOnly !== false,
    timeoutMs: config.timeoutMs ?? 120000,
  };
}

export function createStubInvestigationCompleted(report: SlackBugReport, now = Date.now()): InvestigationCompleted {
  return {
    type: "INVESTIGATION_COMPLETED",
    reportId: report.reportId,
    completedAt: now,
    summary: "Investigation enqueue is not wired to a stable OpenClaw spawn hook in this plugin build yet.",
    evidence: ["Report capture succeeded", "OpenClaw context fields were normalized into the report payload"],
    likelyLayer: "unknown",
    confidence: "low",
    recommendedNext: "Wire this plugin to the current runtime investigation/spawn API once the Slack slash/reaction event surface is confirmed.",
  };
}
