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

export async function fetchTokens(): Promise<TokenRow[]> {
  const body = await backendGet<{ tokens: TokenRow[] }>("/api/tokens");
  return body.tokens;
}
