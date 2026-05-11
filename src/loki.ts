import type { LokiConfig, LokiEvent } from "./types.js";

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export function buildLokiHeaders(config: LokiConfig = {}): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json", ...(config.extraHeaders ?? {}) };
  if (config.bearerToken) headers.authorization = `Bearer ${config.bearerToken}`;
  if (config.basicAuth?.username && config.basicAuth.password) {
    const token = Buffer.from(`${config.basicAuth.username}:${config.basicAuth.password}`).toString("base64");
    headers.authorization = `Basic ${token}`;
  }
  return headers;
}

export async function pushLokiEvent(config: LokiConfig | undefined, event: LokiEvent, fetchLike: FetchLike = fetch as FetchLike): Promise<void> {
  if (!config?.endpoint) return;
  const response = await fetchLike(config.endpoint, {
    method: "POST",
    headers: buildLokiHeaders(config),
    body: JSON.stringify(event),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Loki push failed: HTTP ${response.status}${body ? ` ${body.slice(0, 300)}` : ""}`);
  }
}
