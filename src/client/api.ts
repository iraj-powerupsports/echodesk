const KEY = "echodesk-token";
let memToken: string | null = null;

export function getToken(): string | null {
  try {
    return localStorage.getItem(KEY) ?? memToken;
  } catch {
    return memToken;
  }
}

export function setToken(token: string | null) {
  memToken = token;
  try {
    if (token) localStorage.setItem(KEY, token);
    else localStorage.removeItem(KEY);
  } catch {
    // private mode: memToken keeps it for this tab
  }
}

export class AuthError extends Error {}
export class ApiError extends Error {
  constructor(message: string, public data: Record<string, unknown>) {
    super(message);
  }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init?.method ?? "GET",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 401) throw new AuthError("Invalid token");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? res.statusText, data);
  return data as T;
}
