import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";

import {
  buildAckText,
  buildCreatedLokiEvent,
  buildGrafanaUrl,
  createBugReport,
  createReportId,
  handleBugReportEvent,
  registerSlackBugReportHandlers,
  sanitizeText,
  shouldPostThreadSummary,
} from "../dist/index.js";

describe("slack bug report core", () => {
  it("creates stable report shape and keeps Slack metadata as the spine", () => {
    const report = createBugReport({
      source: "reaction",
      teamId: "T1",
      channelId: "C1",
      threadTs: "1700000000.000100",
      messageTs: "1700000000.000100",
      reporterUserId: "U1",
      permalink: "https://slack.example/archives/C1/p1700000000000100",
      severity: "high",
      targetText: "session id abc-123 agentId main xoxb-secret",
      userNote: "email me at user@example.com",
    }, {
      grafanaDashboardUrl: "https://grafana/d/bugs?var-report_id={{report_id}}",
    }, { now: Date.UTC(2026, 4, 11), random: () => 0 });

    assert.equal(report.reportId, "br_20260511_00000");
    assert.equal(report.threadTs, "1700000000.000100");
    assert.equal(report.openclaw.sessionId, "abc-123");
    assert.equal(report.openclaw.agentId, "main");
    assert.equal(report.userNote, "email me at [redacted-email]");
    assert.match(report.targetText, /\[redacted-slack-token\]/);
    assert.equal(report.grafanaUrl, "https://grafana/d/bugs?var-report_id=br_20260511_00000");
  });

  it("builds Loki created event with sane labels", () => {
    const report = createBugReport({ source: "slash_command", teamId: "T1", channelId: "C1", severity: "critical" }, {}, { now: 1000, random: () => 0.5 });
    const event = buildCreatedLokiEvent(report, 123n);
    assert.equal(event.streams[0].stream.source, "slack_bug_report");
    assert.equal(event.streams[0].stream.event, "BUG_REPORT_CREATED");
    assert.equal(event.streams[0].stream.team, "T1");
    assert.equal(event.streams[0].stream.channel, "C1");
    assert.equal(event.streams[0].stream.severity, "critical");
    const payload = JSON.parse(event.streams[0].values[0][1]);
    assert.equal(payload.report_id, report.reportId);
  });

  it("uses conservative thread summary policy", () => {
    assert.equal(shouldPostThreadSummary({ severity: "high", postThreadSummary: false }, { threadSummarySeverityThreshold: "critical" }), false);
    assert.equal(shouldPostThreadSummary({ severity: "critical", postThreadSummary: false }, { threadSummarySeverityThreshold: "critical" }), true);
    assert.equal(shouldPostThreadSummary({ severity: "low", postThreadSummary: true }, { threadSummarySeverityThreshold: "never" }), true);
  });

  it("redacts and truncates text", () => {
    assert.equal(sanitizeText("abc user@example.com def", { maxTextChars: 100 }), "abc [redacted-email] def");
    assert.equal(sanitizeText("abcdef", { maxTextChars: 3, redactEmails: false, redactTokens: false }), "abc");
  });

  it("keeps package and plugin versions in lockstep", () => {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const plugin = JSON.parse(fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    assert.equal(pkg.version, plugin.version);
  });
});

describe("plugin handlers", () => {
  it("registers idempotently and handles report event", async () => {
    const events = [];
    const posts = [];
    const api = {
      config: { loki: { endpoint: "https://loki.invalid" }, ackMode: "thread" },
      logger: {},
      on(name, handler) { events.push([name, handler]); },
      slack: { chat: { postMessage: async (msg) => posts.push(msg) } },
    };
    const shared = { registeredApis: new WeakSet() };
    registerSlackBugReportHandlers(api, shared);
    registerSlackBugReportHandlers(api, shared);
    assert.equal(events.length, 3);

    const oldFetch = globalThis.fetch;
    const pushes = [];
    globalThis.fetch = async (_url, init) => {
      pushes.push(JSON.parse(init.body));
      return { ok: true, status: 204, text: async () => "" };
    };
    try {
      const result = await handleBugReportEvent(api, { source: "manual", channelId: "C1", severity: "low", userNote: "broken" });
      assert.match(result.reportId, /^br_/);
      assert.equal(pushes.length, 1);
      assert.equal(posts.length, 1);
      assert.match(posts[0].text, /Bug report logged:/);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it("registers a Slack plugin command and handles its context", async () => {
    const commands = [];
    const events = [];
    const api = {
      config: { loki: { endpoint: "https://loki.invalid" } },
      logger: {},
      on(name, handler) { events.push([name, handler]); },
      registerCommand(command) { commands.push(command); },
    };
    const shared = { registeredApis: new WeakSet() };
    registerSlackBugReportHandlers(api, shared);

    assert.equal(commands.length, 1);
    assert.equal(commands[0].name, "bug-report");
    assert.deepEqual(commands[0].channels, ["slack"]);
    assert.equal(commands[0].acceptsArgs, true);
    assert.equal(commands[0].requireAuth, true);
    assert.equal(events.length, 3);

    const oldFetch = globalThis.fetch;
    const pushes = [];
    globalThis.fetch = async (_url, init) => {
      pushes.push(JSON.parse(init.body));
      return { ok: true, status: 204, text: async () => "" };
    };
    try {
      const result = await commands[0].handler({
        channel: "slack",
        channelId: "slack",
        isAuthorizedSender: true,
        senderId: "U1",
        args: "broken from slash command",
        commandBody: "/bug-report broken from slash command",
        from: "slack:channel:C1",
        to: "slash:U1",
        accountId: "default",
        sessionKey: "agent:main:slack:slash:u1",
        sessionId: "session-1",
        config: {},
      });
      assert.match(result.text, /Bug report logged:/);
      assert.equal(pushes.length, 1);
      const payload = JSON.parse(pushes[0].streams[0].values[0][1]);
      assert.equal(payload.source, "slash_command");
      assert.equal(pushes[0].streams[0].stream.channel, "C1");
      assert.equal(payload.user_note, "broken from slash command");
      assert.equal(payload.reporter, "U1");
      assert.equal(payload.openclaw.sessionKey, "agent:main:slack:slash:u1");
    } finally {
      globalThis.fetch = oldFetch;
    }
  });
});
