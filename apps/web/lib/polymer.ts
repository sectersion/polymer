import { cookies } from "next/headers";

/** Base URL of the Polymer backend REST API (deployment config). */
export function apiUrl(): string {
  const base = process.env.POLYMER_API_URL ?? "http://127.0.0.1:8080";
  return base.replace(/\/$/, "");
}

export const ADMIN_COOKIE = "__Host-polymer_admin";

/** The administrator session token from the browser cookie, if any. */
export async function sessionToken(): Promise<string | undefined> {
  const jar = await cookies();
  return jar.get(ADMIN_COOKIE)?.value;
}

export interface BackendError {
  status: number;
  code: string;
}

/** GET a backend REST route with the browser session forwarded. */
export async function backendGet<T>(path: string): Promise<T> {
  const token = await sessionToken();
  const res = await fetch(`${apiUrl()}${path}`, {
    headers: token ? { cookie: `${ADMIN_COOKIE}=${token}` } : {},
    cache: "no-store",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
    };
    const err = new Error(body.error ?? `backend ${res.status}`) as Error & {
      status: number;
    };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

export interface Agent {
  agent_id: string;
  name: string;
  role: string;
  parent_agent_id: string | null;
  status: string;
  heartbeat_timeout_seconds: number;
  last_seen: string;
  connected_at: string;
  created_at: string;
}

export interface TaskItem {
  task_id: string;
  title: string;
  status: string;
  created_by: string;
  coordinator: string;
  assigned_to: string[];
  version: number;
  lease_generation: number;
  lease_expires_at: string | null;
  trace_parent: string | null;
  created_at: string;
}

export interface TaskDetail extends TaskItem {
  description: string | null;
  updated_at: string;
  comments: CommentItem[];
  has_more: boolean;
}

export interface CommentItem {
  comment_id: string;
  task_id: string;
  sender_agent_id: string | null;
  sender_type: string;
  content: string;
  trace_parent: string | null;
  created_at: string;
}

export interface TokenRow {
  credential_id: string;
  public_id: string | null;
  type: string;
  status: string;
  agent_id: string | null;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
}

export async function fetchAgents(): Promise<Agent[]> {
  const body = await backendGet<{ agents: Agent[] }>("/api/agents");
  return body.agents;
}

export async function fetchTasks(): Promise<TaskItem[]> {
  const body = await backendGet<{ tasks: TaskItem[] }>("/api/tasks");
  return body.tasks;
}

export async function fetchTask(id: string): Promise<TaskDetail> {
  return backendGet<TaskDetail>(`/api/tasks/${id}`);
}

export interface TelemetrySummary {
  total_comments: number;
  total_tasks: number;
  active_agents: number;
  total_tokens_used: number;
  total_cost_micro_usd: number;
}

export interface AgentTelemetryRow {
  agent_id: string;
  name: string;
  comments_sent: number;
  tasks_created: number;
  tokens_used: number;
  cost_micro_usd: number;
}

export interface TimelineEventRow {
  usage_id: string;
  agent_id: string;
  task_id: string | null;
  trace_id: string | null;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  reported_cost_micro_usd: number | null;
  cost_source: "reported" | "unknown";
  recorded_at: string;
}

export interface CostBucket {
  bucket_start: string;
  cost_micro_usd: number;
}

/** Loose-end C: telemetry reads for the Fleet cards + Telemetry page. */
export async function fetchSummary(): Promise<TelemetrySummary> {
  return backendGet<TelemetrySummary>("/api/telemetry/summary");
}

export async function fetchAgentTelemetry(): Promise<AgentTelemetryRow[]> {
  const body = await backendGet<{ agents: AgentTelemetryRow[] }>(
    "/api/telemetry/agents",
  );
  return body.agents;
}

export async function fetchTimeline(limit = 20): Promise<TimelineEventRow[]> {
  const body = await backendGet<{
    events: TimelineEventRow[];
    next_cursor: string | null;
  }>(`/api/telemetry/timeline?limit=${limit}`);
  return body.events;
}

export async function fetchDailyCosts(days = 7): Promise<CostBucket[]> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 3600 * 1000);
  const query =
    `granularity=daily&from=${encodeURIComponent(from.toISOString())}` +
    `&to=${encodeURIComponent(to.toISOString())}`;
  const body = await backendGet<{ time_series: CostBucket[] }>(
    `/api/telemetry/costs?${query}`,
  );
  return body.time_series;
}

export async function fetchTokens(): Promise<TokenRow[]> {
  const body = await backendGet<{ tokens: TokenRow[] }>("/api/tokens");
  return body.tokens;
}

export interface BreakdownBucketRow {
  key: string;
  tokens_used: number;
  cost_micro_usd: number;
  spans: number;
}

/** Telemetry depth: per-model/per-provider totals for stacked bars. */
export async function fetchBreakdown(
  dimension: "model" | "provider",
): Promise<BreakdownBucketRow[]> {
  const body = await backendGet<{
    dimension: string;
    buckets: BreakdownBucketRow[];
  }>(`/api/telemetry/breakdown?dimension=${dimension}`);
  return body.buckets;
}

export interface TraceSpanRow {
  span_id: string;
  parent_span_id: string | null;
  name: string;
  start_time_unix_ns: string;
  end_time_unix_ns: string;
  error: boolean;
  status_message: string | null;
  agent_id: string;
}

/** Telemetry depth: spans of one trace, oldest first. */
export async function fetchTraceSpans(
  traceId: string,
): Promise<TraceSpanRow[]> {
  const body = await backendGet<{ trace_id: string; spans: TraceSpanRow[] }>(
    `/api/telemetry/traces/${traceId}`,
  );
  return body.spans;
}
