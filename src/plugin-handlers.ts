import { WebClient } from "@slack/web-api";
import { buildAckText, buildCreatedLokiEvent, buildThreadSummary, createBugReport, isAllowed, shouldPostThreadSummary } from "./core.js";
import { createInvestigationStarted, shouldStartInvestigation } from "./investigation.js";
import { pushLokiEvent } from "./loki.js";
import type { Logger, SlackBugReportConfig, SlackBugReportInput } from "./types.js";

export type SlackWebClient = Pick<WebClient, "chat">;

export type PluginApi = {
  logger?: Logger;
  config?: { slackBugReport?: SlackBugReportConfig } & SlackBugReportConfig;
  registrationMode?: string;
  on?: (hookName: string, handler: (event: unknown, ctx?: unknown) => void | Promise<void>) => unknown;
  createSlackWebClient?: (token?: string) => SlackWebClient;
  slack?: SlackWebClient;
  botToken?: string;
  runtime?: {
    tasks?: {
      spawn?: (params: { task: string; label: string; timeoutMs?: number; readOnly?: boolean }) => Promise<{ runId?: string }>;
    };
  };
};

export type SharedState = {
  registeredApis: WeakSet<object>;
};

const SHARED_STATE_KEY = "__openclawSlackBugReportState";

export function createSharedState(): SharedState {
  return { registeredApis: new WeakSet<object>() };
}

export function getSharedState(): SharedState {
  const globalWithState = globalThis as typeof globalThis & { [SHARED_STATE_KEY]?: SharedState };
  globalWithState[SHARED_STATE_KEY] ??= createSharedState();
  return globalWithState[SHARED_STATE_KEY];
}

export function registerSlackBugReportHandlers(api: PluginApi, shared = getSharedState()): void {
  if (typeof api !== "object" || api === null) return;
  if (shared.registeredApis.has(api)) return;
  shared.registeredApis.add(api);

  const hooks = api.on;
  if (typeof hooks !== "function") {
    api.logger?.warn?.("slack-bug-report: plugin loaded without hook API; core functions are available but live Slack handlers were not registered");
    return;
  }

  hooks.call(api, "slack_bug_report", (event, ctx) => {
    void handleBugReportEvent(api, event, ctx).catch((error) => api.logger?.warn?.("slack-bug-report: report handler failed", { error: stringifyError(error) }));
  });
  hooks.call(api, "slack_slash_command:bug-report", (event, ctx) => {
    void handleBugReportEvent(api, normalizeSlashEvent(event), ctx).catch((error) => api.logger?.warn?.("slack-bug-report: slash handler failed", { error: stringifyError(error) }));
  });
  hooks.call(api, "slack_reaction_added", (event, ctx) => {
    const config = getConfig(api);
    const reaction = event as { reaction?: string };
    if (reaction.reaction !== (config.triggerEmoji ?? "bug")) return;
    void handleBugReportEvent(api, normalizeReactionEvent(event), ctx).catch((error) => api.logger?.warn?.("slack-bug-report: reaction handler failed", { error: stringifyError(error) }));
  });
  api.logger?.info?.("slack-bug-report plugin registered");
}

export async function handleBugReportEvent(api: PluginApi, event: unknown, _ctx?: unknown): Promise<{ reportId?: string; skipped?: string }> {
  const config = getConfig(api);
  const input = event as SlackBugReportInput;
  if (!isAllowed(input, config)) return { skipped: "not_allowed" };

  const report = createBugReport(input, config);
  await pushLokiEvent(config.loki, buildCreatedLokiEvent(report));

  let investigationStarted = false;
  if (shouldStartInvestigation(report, config.investigation)) {
    const runId = await enqueueInvestigation(api, report.reportId, report, config);
    investigationStarted = Boolean(runId);
    if (runId) {
      await pushLokiEvent(config.loki, {
        streams: [{
          stream: { source: "slack_bug_report", event: "INVESTIGATION_STARTED", team: report.teamId ?? "unknown", channel: report.channelId },
          values: [[(BigInt(Date.now()) * 1_000_000n).toString(), JSON.stringify(createInvestigationStarted(report, runId, config.investigation))]],
        }],
      });
    }
  }

  await sendAck(api, report.channelId, report.threadTs ?? report.messageTs, buildAckText(report, investigationStarted), config.ackMode ?? "ephemeral");
  if (shouldPostThreadSummary(report, config)) {
    await sendThreadSummary(api, report.channelId, report.threadTs ?? report.messageTs, buildThreadSummary(report));
  }
  return { reportId: report.reportId };
}

function getConfig(api: PluginApi): SlackBugReportConfig {
  const raw = api.config ?? {};
  return (raw.slackBugReport ?? raw) as SlackBugReportConfig;
}

async function enqueueInvestigation(api: PluginApi, reportId: string, report: { openclaw: unknown; permalink?: string }, config: SlackBugReportConfig): Promise<string | undefined> {
  const spawn = api.runtime?.tasks?.spawn;
  if (typeof spawn !== "function") {
    api.logger?.debug?.("slack-bug-report: investigation spawn hook unavailable", { reportId });
    return undefined;
  }
  const result = await spawn({
    label: `bug-report-${reportId}`,
    readOnly: config.investigation?.readOnly !== false,
    timeoutMs: config.investigation?.timeoutMs ?? 120000,
    task: `Read-only investigation for bug report ${reportId}. Slack permalink: ${report.permalink ?? "unknown"}. OpenClaw context: ${JSON.stringify(report.openclaw)}. Return likely layer, confidence, evidence, and recommended next step.`,
  });
  return result.runId;
}

async function sendAck(api: PluginApi, channel: string, threadTs: string | undefined, text: string, ackMode: "ephemeral" | "thread"): Promise<void> {
  if (ackMode === "thread") return sendThreadSummary(api, channel, threadTs, text);
  api.logger?.info?.("slack-bug-report: ephemeral ack requested", { channel, threadTs, text });
}

async function sendThreadSummary(api: PluginApi, channel: string, threadTs: string | undefined, text: string): Promise<void> {
  const client = api.slack ?? api.createSlackWebClient?.(api.botToken);
  if (!client?.chat?.postMessage) {
    api.logger?.debug?.("slack-bug-report: Slack client unavailable for thread summary", { channel, threadTs });
    return;
  }
  await client.chat.postMessage({ channel, thread_ts: threadTs, text, parse: "none" });
}

function normalizeSlashEvent(event: unknown): SlackBugReportInput {
  const e = event as Record<string, unknown>;
  return {
    source: "slash_command",
    teamId: asString(e.team_id ?? e.teamId),
    channelId: asString(e.channel_id ?? e.channelId) ?? "",
    channelName: asString(e.channel_name ?? e.channelName),
    reporterUserId: asString(e.user_id ?? e.userId),
    userNote: asString(e.text),
    severity: "medium",
    createdAt: Date.now(),
  };
}

function normalizeReactionEvent(event: unknown): SlackBugReportInput {
  const e = event as Record<string, unknown>;
  const item = (e.item ?? {}) as Record<string, unknown>;
  return {
    source: "reaction",
    teamId: asString(e.team_id ?? e.teamId),
    channelId: asString(item.channel ?? e.channelId) ?? "",
    threadTs: asString(item.ts ?? e.threadTs),
    messageTs: asString(item.ts ?? e.messageTs),
    reporterUserId: asString(e.user),
    severity: "medium",
    createdAt: Date.now(),
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
