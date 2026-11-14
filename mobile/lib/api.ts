import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";

const API = String(Constants.expoConfig?.extra?.apiUrl || "http://localhost:3000").replace(/\/$/, "");
export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export async function api(path: string, options: RequestInit = {}) {
  const response = await fetch(API + path, {
    ...options,
    credentials: "omit",
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new ApiError(data?.error || "Request failed", response.status);
  return data;
}
export async function setSession(access: string, refresh: string) {
  await SecureStore.setItemAsync("accessToken", access);
  await SecureStore.setItemAsync("refreshToken", refresh);
}
export async function clearSession() {
  await SecureStore.deleteItemAsync("accessToken");
  await SecureStore.deleteItemAsync("refreshToken");
}
export async function getAccess() { return SecureStore.getItemAsync("accessToken"); }
let refreshing: Promise<string> | null = null;
async function refreshSession(): Promise<string> {
  if (!refreshing) {
    refreshing = (async () => {
      const refreshToken = await SecureStore.getItemAsync("refreshToken");
      if (!refreshToken) throw new ApiError("Please sign in again", 401);
      const data = await api("/api/auth/refresh", { method: "POST", body: JSON.stringify({ refreshToken }) });
      await setSession(data.accessToken, data.refreshToken);
      return data.accessToken as string;
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}
export async function authorized(path: string, options: RequestInit = {}) {
  let access = await getAccess();
  if (!access) access = await refreshSession();
  const request = (token: string) => api(path, {
    ...options, headers: { ...options.headers, Authorization: "Bearer " + token },
  });
  try { return await request(access); }
  catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
    return request(await refreshSession());
  }
}
export async function revokeBackendSession() {
  const refreshToken = await SecureStore.getItemAsync("refreshToken");
  try {
    if (refreshToken) await api("/api/auth/logout", { method: "POST", body: JSON.stringify({ refreshToken }) });
  } finally { await clearSession(); }
}
