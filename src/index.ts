import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { WebClient } from "@slack/web-api";
import { registerSlackBugReportHandlers, type PluginApi } from "./plugin-handlers.js";

export default definePluginEntry({
  id: "slack-bug-report",
  name: "Slack Bug Report",
  description: "Captures Slack bug reports, writes durable Loki events, and optionally starts bounded read-only investigation context.",

  register(api: unknown) {
    const pluginApi = api as PluginApi;
    registerSlackBugReportHandlers(Object.assign(pluginApi, {
      createSlackWebClient: (token?: string) => new WebClient(token),
    }));
  },
});

export * from "./core.js";
export * from "./investigation.js";
export * from "./loki.js";
export * from "./plugin-handlers.js";
export * from "./types.js";
