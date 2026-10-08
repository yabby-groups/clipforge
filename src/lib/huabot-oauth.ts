import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";

export const HUABOT_ORIGIN = "https://huabot.com";
export const HUABOT_CLIENT_ID = "SeI30eRwrJkyIIgdmpC5UvOQiy20OCRA";
export const HUABOT_SCOPES = "profile:read token_base:read offline_access";
export const HUABOT_SESSION_COOKIE = "clipforge_huabot_session";

type DeviceGrant = { deviceCode: string; interval: number; expiresAt: number; verificationUriComplete: string; userCode: string };
type Tokens = { accessToken: string; refreshToken: string; accessExpiresAt: number };
type OAuthSession = { device?: DeviceGrant; tokens?: Tokens; profile?: { id?: number | string; nick_name?: string; name?: string; profile?: { avatar_url?: string } } };
export type HuabotKey = { id: number; name: string; masked: string; key: string };

function encryptionKey(): Buffer {
  const configured = process.env.CLIPFORGE_OAUTH_ENCRYPTION_KEY?.trim();
  if (!configured) throw new Error("OAuth secure storage is not configured");
  return createHash("sha256").update(configured).digest();
}

function encrypt(value: OAuthSession): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

function decrypt(value: string): OAuthSession | null {
  try {
    const payload = Buffer.from(value, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), payload.subarray(0, 12));
    decipher.setAuthTag(payload.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8")) as OAuthSession;
  } catch { return null; }
}

const storageKey = (id: string) => `huabot-oauth:${id}`;

export async function newSession(): Promise<string> {
  const id = randomUUID();
  await saveSession(id, {});
  return id;
}
export async function loadSession(id?: string): Promise<OAuthSession | null> {
  if (!id) return null;
  const row = await db.select().from(settings).where(eq(settings.key, storageKey(id))).get();
  return typeof row?.value === "string" ? decrypt(row.value) : null;
}
export async function saveSession(id: string, value: OAuthSession): Promise<void> {
  await db.insert(settings).values({ key: storageKey(id), value: encrypt(value), updatedAt: new Date() }).onConflictDoUpdate({ target: settings.key, set: { value: encrypt(value), updatedAt: new Date() } });
}
export async function removeSession(id?: string): Promise<void> {
  if (id) await db.delete(settings).where(eq(settings.key, storageKey(id)));
}

async function form(path: string, values: Record<string, string>) {
  const body = new URLSearchParams(values);
  const response = await fetch(`${HUABOT_ORIGIN}${path}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, cache: "no-store" });
  const json = await response.json().catch(() => ({})) as Record<string, unknown>;
  return { response, json };
}

export async function beginDeviceAuthorization(id: string): Promise<DeviceGrant> {
  const { response, json } = await form("/oauth/device/code", { client_id: HUABOT_CLIENT_ID, scope: HUABOT_SCOPES, completion_action: "close" });
  if (!response.ok || typeof json.device_code !== "string" || typeof json.verification_uri_complete !== "string") throw new Error(String(json.error_description || "Unable to start Huabot login"));
  const device: DeviceGrant = { deviceCode: json.device_code, interval: Math.max(3, Number(json.interval) || 3), expiresAt: Date.now() + (Number(json.expires_in) || 600) * 1000, verificationUriComplete: json.verification_uri_complete, userCode: String(json.user_code || "") };
  await saveSession(id, { device });
  return device;
}

export async function refreshIfNeeded(id: string, session: OAuthSession): Promise<OAuthSession> {
  if (!session.tokens || session.tokens.accessExpiresAt > Date.now() + 60_000) return session;
  const { response, json } = await form("/oauth/token", { grant_type: "refresh_token", client_id: HUABOT_CLIENT_ID, refresh_token: session.tokens.refreshToken });
  if (!response.ok || typeof json.access_token !== "string" || typeof json.refresh_token !== "string") { await removeSession(id); throw new Error("Huabot login expired. Please sign in again."); }
  session.tokens = { accessToken: json.access_token, refreshToken: json.refresh_token, accessExpiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000 };
  await saveSession(id, session);
  return session;
}

export async function pollDeviceAuthorization(id: string, session: OAuthSession): Promise<{ state: "pending" | "authorized" | "failed"; retryAfter?: number; message?: string; session?: OAuthSession }> {
  if (!session.device || session.device.expiresAt <= Date.now()) return { state: "failed", message: "Login code expired. Start again." };
  const { response, json } = await form("/oauth/token", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: HUABOT_CLIENT_ID, device_code: session.device.deviceCode });
  if (typeof json.access_token === "string" && typeof json.refresh_token === "string") {
    const tokens: Tokens = { accessToken: json.access_token, refreshToken: json.refresh_token, accessExpiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000 };
    const next: OAuthSession = { tokens };
    const profile = await fetch(`${HUABOT_ORIGIN}/api/user/me/`, { headers: { Authorization: `Bearer ${tokens.accessToken}` }, cache: "no-store" }).then((r) => r.ok ? r.json() : null).catch(() => null);
    next.profile = (profile?.user ?? profile ?? undefined) as OAuthSession["profile"];
    await saveSession(id, next);
    return { state: "authorized", session: next };
  }
  const error = String(json.error || "");
  if (error === "authorization_pending") return { state: "pending", retryAfter: session.device.interval };
  if (error === "slow_down") { session.device.interval += 5; await saveSession(id, session); return { state: "pending", retryAfter: session.device.interval }; }
  return { state: "failed", message: String(json.error_description || (response.ok ? "Login failed" : "Huabot login failed")) };
}

export async function authorizedSession(id?: string) {
  const session = await loadSession(id);
  if (!session?.tokens) throw new Error("Not signed in to Huabot");
  return refreshIfNeeded(id!, session);
}

function tokenString(token: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const value = token[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizeHuabotKey(value: string): string {
  return value && !value.startsWith("sk-") ? `sk-${value}` : value;
}

function parseHuabotKey(token: Record<string, unknown>): HuabotKey | null {
  const status = typeof token.status === "number" ? token.status : Number(token.status ?? 1);
  const id = Number(token.id ?? token.uuid);
  const key = normalizeHuabotKey(tokenString(token, "token_key", "token", "key", "api_key", "secret"));
  if (status !== 1 || !Number.isFinite(id) || !key) return null;
  return {
    id,
    name: tokenString(token, "token_name", "name") || "Huabot Key",
    masked: tokenString(token, "token_key_masked"),
    key,
  };
}

async function huabotJson(path: string, accessToken: string, method = "GET") {
  const response = await fetch(`${HUABOT_ORIGIN}${path}`, {
    method,
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({})) as {
    tokens?: Array<Record<string, unknown>>;
    token?: Record<string, unknown>;
    err?: string;
    error?: string;
  };
  if (!response.ok) throw new Error(body.err || body.error || "Unable to load Huabot keys");
  return body;
}

export async function fetchHuabotKeys(accessToken: string): Promise<HuabotKey[]> {
  const listed = await huabotJson("/api/token_base/token/my/list/?offset=0&size=100", accessToken);
  const tokens = Array.isArray(listed.tokens) && listed.tokens.length > 0
    ? listed.tokens
    : [await huabotJson("/api/token_base/token/create/", accessToken, "POST").then((created) => created.token)];
  const keys = tokens
    .filter((token): token is Record<string, unknown> => Boolean(token))
    .map(parseHuabotKey)
    .filter((key): key is HuabotKey => key !== null);
  if (!keys.length) throw new Error("Huabot did not return a usable Key");
  return keys;
}

export async function listHuabotKeys(id?: string): Promise<HuabotKey[]> {
  const session = await authorizedSession(id);
  return fetchHuabotKeys(session.tokens!.accessToken);
}

export async function revokeAndRemove(id?: string): Promise<void> {
  const session = await loadSession(id);
  if (session?.tokens?.refreshToken) await form("/oauth/revoke", { client_id: HUABOT_CLIENT_ID, token: session.tokens.refreshToken });
  await removeSession(id);
}
