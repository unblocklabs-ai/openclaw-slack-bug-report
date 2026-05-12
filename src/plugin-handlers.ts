import { WebClient } from "@slack/web-api";
import { buildAckText, buildCreatedLokiEvent, buildThreadSummary, createBugReport, isAllowed, shouldPostThreadSummary } from "./core.js";
import { createInvestigationStarted, shouldStartInvestigation } from "./investigation.js";
import { pushLokiEvent } from "./loki.js";
import type { Logger, SlackBugReportConfig, SlackBugReportInput } from "./types.js";

export type SlackWebClient = Pick<WebClient, "chat">;

export type PluginApi = {
  logger?: Logger;
  config?: unknown;
  pluginConfig?: SlackBugReportConfig;
  registrationMode?: string;
  on?: (hookName: string, handler: (event: unknown, ctx?: unknown) => void | Promise<void>) => unknown;
  registerCommand?: (command: PluginCommandDefinition) => unknown;
  createSlackWebClient?: (token?: string) => SlackWebClient;
  slack?: SlackWebClient;
  botToken?: string;
  runtime?: {
    tasks?: {
      spawn?: (params: { task: string; label: string; timeoutMs?: number; readOnly?: boolean }) => Promise<{ runId?: string }>;
    };
  };
};

export type PluginCommandContext = {
  senderId?: string;
  channel: string;
  channelId?: string;
  isAuthorizedSender: boolean;
  args?: string;
  commandBody: string;
  config?: unknown;
  from?: string;
  to?: string;
  accountId?: string;
  messageThreadId?: string | number;
  threadParentId?: string;
  sessionKey?: string;
  sessionId?: string;
  sessionFile?: string;
};

export type PluginCommandDefinition = {
  name: string;
  nativeNames?: Partial<Record<string, string>> & { default?: string };
  nativeProgressMessages?: Partial<Record<string, string>> & { default?: string };
  description: string;
  channels?: readonly string[];
  acceptsArgs?: boolean;
  requireAuth?: boolean;
  handler: (ctx: PluginCommandContext) => { text?: string; continueAgent?: boolean } | Promise<{ text?: string; continueAgent?: boolean }>;
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

  const config = getConfig(api);
  const commandName = normalizeCommandName(config.slashCommandName ?? "/bug-report");
  if (typeof api.registerCommand === "function") {
    api.registerCommand({
      name: commandName,
      description: "Capture a Slack bug report and start a read-only investigation when configured.",
      channels: ["slack"],
      acceptsArgs: true,
      requireAuth: true,
      nativeNames: { slack: commandName },
      nativeProgressMessages: { slack: "Logging bug report..." },
      handler: async (ctx) => handleBugReportCommand(api, ctx),
    });
    api.logger?.info?.("slack-bug-report command registered", { command: `/${commandName}` });
  }

  const hooks = api.on;
  if (typeof hooks !== "function") {
    if (typeof api.registerCommand !== "function") {
      api.logger?.warn?.("slack-bug-report: plugin loaded without command or hook API; core functions are available but live Slack handlers were not registered");
    }
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

export async function handleBugReportEvent(api: PluginApi, event: unknown, _ctx?: unknown): Promise<{ reportId?: string; skipped?: string; ackText?: string }> {
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

  const ackText = buildAckText(report, investigationStarted);
  await sendAck(api, report.channelId, report.threadTs ?? report.messageTs, ackText, config.ackMode ?? "ephemeral");
  if (shouldPostThreadSummary(report, config)) {
    await sendThreadSummary(api, report.channelId, report.threadTs ?? report.messageTs, buildThreadSummary(report));
  }
  return { reportId: report.reportId, ackText };
}

function getConfig(api: PluginApi): SlackBugReportConfig {
  if (isRecord(api.pluginConfig)) return api.pluginConfig as SlackBugReportConfig;
  const raw = isRecord(api.config) ? api.config : {};
  if (isRecord(raw.slackBugReport)) return raw.slackBugReport as SlackBugReportConfig;
  const pluginEntryConfig = getPluginEntryConfig(raw);
  if (isRecord(pluginEntryConfig)) return pluginEntryConfig as SlackBugReportConfig;
  return raw as SlackBugReportConfig;
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

async function handleBugReportCommand(api: PluginApi, ctx: PluginCommandContext): Promise<{ text: string }> {
  api.logger?.info?.("slack-bug-report: command received", {
    channel: ctx.channel,
    from: ctx.from,
    senderId: ctx.senderId,
  });
  try {
    const result = await handleBugReportEvent(api, normalizePluginCommandEvent(ctx), ctx);
    if (result.skipped === "not_allowed") {
      return { text: "Bug report skipped: this workspace or channel is not allowed." };
    }
    return { text: result.ackText ?? `Bug report logged: ${result.reportId ?? "unknown"}` };
  } catch (error) {
    api.logger?.warn?.("slack-bug-report: command handler failed", { error: stringifyError(error) });
    return { text: "Sorry, something went wrong logging that bug report." };
  }
}

function normalizePluginCommandEvent(ctx: PluginCommandContext): SlackBugReportInput {
  const raw = ctx as PluginCommandContext & Record<string, unknown>;
  const channelId = resolveCommandChannelId(ctx);
  return {
    source: "slash_command",
    teamId: asString(raw.teamId ?? raw.team_id ?? raw.GroupSpace ?? raw.groupSpace),
    channelId,
    reporterUserId: ctx.senderId ?? parseSlackUserId(ctx.from) ?? parseSlackUserId(ctx.to),
    userNote: ctx.args ?? commandArgsFromBody(ctx.commandBody),
    severity: "medium",
    createdAt: Date.now(),
    openclaw: {
      sessionId: ctx.sessionId,
      sessionKey: ctx.sessionKey,
    },
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

function normalizeCommandName(raw: string): string {
  const candidate = raw.trim().replace(/^\/+/, "").toLowerCase();
  return /^[a-z][a-z0-9_-]*$/.test(candidate) ? candidate : "bug-report";
}

function commandArgsFromBody(commandBody: string): string | undefined {
  const trimmed = commandBody.trim();
  const spaceIndex = trimmed.indexOf(" ");
  return spaceIndex === -1 ? undefined : trimmed.slice(spaceIndex + 1).trim() || undefined;
}

function resolveCommandChannelId(ctx: PluginCommandContext): string {
  return (
    parseSlackChannelId(ctx.from) ??
    parseSlackChannelId(ctx.to) ??
    asSlackChannelId(ctx.threadParentId) ??
    asSlackChannelId(ctx.channelId) ??
    asString(ctx.threadParentId) ??
    asString(ctx.channelId) ??
    "unknown"
  );
}

function asSlackChannelId(value: unknown): string | undefined {
  const text = asString(value);
  return text && /^[CDG][A-Z0-9]+$/i.test(text) ? text : undefined;
}

function parseSlackChannelId(value: unknown): string | undefined {
  const text = asString(value);
  if (!text) return undefined;
  const explicit = /^slack:(?:channel|group|dm):([CDG][A-Z0-9]+)$/i.exec(text);
  if (explicit?.[1]) return explicit[1];
  const direct = /^slack:([CDG][A-Z0-9]+)$/i.exec(text);
  return direct?.[1];
}

function parseSlackUserId(value: unknown): string | undefined {
  const text = asString(value);
  if (!text) return undefined;
  const explicit = /^slack:(?:user:)?([UW][A-Z0-9]+)$/i.exec(text);
  return explicit?.[1];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPluginEntryConfig(config: Record<string, unknown>): unknown {
  const plugins = config.plugins;
  if (!isRecord(plugins)) return undefined;
  const entries = plugins.entries;
  if (!isRecord(entries)) return undefined;
  const entry = entries["slack-bug-report"];
  return isRecord(entry) ? entry.config : undefined;
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
