export type Severity = "low" | "medium" | "high" | "critical";
export type AckMode = "ephemeral" | "thread";
export type FailureLayer = "slack_delivery" | "agent_runtime" | "tooling" | "plugin" | "model" | "unknown";
export type Confidence = "low" | "medium" | "high";

export type RedactionConfig = {
  maxTextChars?: number;
  redactEmails?: boolean;
  redactTokens?: boolean;
};

export type LokiConfig = {
  endpoint?: string;
  bearerToken?: string;
  basicAuth?: { username?: string; password?: string };
  extraHeaders?: Record<string, string>;
};

export type InvestigationConfig = {
  enabled?: boolean;
  readOnly?: boolean;
  timeoutMs?: number;
};

export type SlackBugReportConfig = {
  slashCommandName?: string;
  triggerEmoji?: string;
  ackMode?: AckMode;
  postThreadSummary?: boolean;
  threadSummarySeverityThreshold?: Severity | "never";
  grafanaDashboardUrl?: string;
  loki?: LokiConfig;
  allowedWorkspaces?: string[];
  allowedChannels?: string[];
  redaction?: RedactionConfig;
  investigation?: InvestigationConfig;
};

export type SlackBugReportInput = {
  source: "slash_command" | "reaction" | "manual";
  teamId?: string;
  teamDomain?: string;
  channelId: string;
  channelName?: string;
  threadTs?: string;
  messageTs?: string;
  reporterUserId?: string;
  targetUserId?: string;
  createdAt?: number;
  permalink?: string;
  severity?: Severity;
  userNote?: string;
  expectedBehavior?: string;
  reproNotes?: string;
  targetText?: string;
  postThreadSummary?: boolean;
  openclaw?: Partial<OpenClawContext>;
};

export type OpenClawContext = {
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  clanker?: string;
  model?: string;
  host?: string;
  node?: string;
};

export type SlackBugReport = {
  reportId: string;
  source: SlackBugReportInput["source"];
  teamId?: string;
  teamDomain?: string;
  channelId: string;
  channelName?: string;
  threadTs?: string;
  messageTs?: string;
  reporterUserId?: string;
  targetUserId?: string;
  createdAt: number;
  permalink?: string;
  severity: Severity;
  userNote?: string;
  expectedBehavior?: string;
  reproNotes?: string;
  targetText?: string;
  openclaw: Partial<OpenClawContext>;
  grafanaUrl?: string;
  postThreadSummary: boolean;
};

export type InvestigationStarted = {
  type: "INVESTIGATION_STARTED";
  reportId: string;
  runId: string;
  startedAt: number;
  readOnly: boolean;
  timeoutMs: number;
};

export type InvestigationCompleted = {
  type: "INVESTIGATION_COMPLETED";
  reportId: string;
  runId?: string;
  completedAt: number;
  summary: string;
  evidence: string[];
  likelyLayer: FailureLayer;
  confidence: Confidence;
  recommendedNext?: string;
};

export type LokiEvent = {
  streams: Array<{
    stream: Record<string, string | undefined>;
    values: Array<[string, string]>;
  }>;
};

export type Logger = {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  info?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  error?: (message: string, meta?: Record<string, unknown>) => void;
};
