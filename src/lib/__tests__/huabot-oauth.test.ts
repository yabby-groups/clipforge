// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let dataDir = "";
let originalDataDir: string | undefined;
let originalEncryptionKey: string | undefined;
let oauth: typeof import("@/lib/huabot-oauth");

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "clipforge-huabot-oauth-"));
  originalDataDir = process.env.APP_DATA_DIR;
  originalEncryptionKey = process.env.CLIPFORGE_OAUTH_ENCRYPTION_KEY;
  process.env.APP_DATA_DIR = dataDir;
  process.env.CLIPFORGE_OAUTH_ENCRYPTION_KEY = "test-oauth-encryption-key";
  vi.resetModules();
  oauth = await import("@/lib/huabot-oauth");
});

afterEach(() => vi.unstubAllGlobals());

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.APP_DATA_DIR;
  else process.env.APP_DATA_DIR = originalDataDir;
  if (originalEncryptionKey === undefined) delete process.env.CLIPFORGE_OAUTH_ENCRYPTION_KEY;
  else process.env.CLIPFORGE_OAUTH_ENCRYPTION_KEY = originalEncryptionKey;
  rmSync(dataDir, { recursive: true, force: true });
});

async function signedInSession(accessExpiresAt = Date.now() + 60 * 60 * 1000) {
  const id = await oauth.newSession();
  await oauth.saveSession(id, {
    tokens: {
      accessToken: "stale-access",
      refreshToken: "refresh-secret",
      accessExpiresAt,
    },
  });
  return id;
}

describe("fetchHuabotKeys", () => {
  it("creates a Key when the account has no Keys", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ tokens: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: { id: 42, token_name: "Default", token_key: "created" } }))));

    await expect(oauth.fetchHuabotKeys("access-token")).resolves.toEqual([
      { id: 42, name: "Default", masked: "", key: "sk-created" },
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith("https://huabot.com/api/token_base/token/create/", expect.objectContaining({ method: "POST", headers: { Authorization: "Bearer access-token" } }));
  });

  it("uses an existing enabled Key without creating another", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ tokens: [
      { id: "7", status: 1, name: "Existing", secret: "already-prefixed", token_key_masked: "sk-...1234" },
    ] }))));

    await expect(oauth.fetchHuabotKeys("access-token")).resolves.toEqual([
      { id: 7, name: "Existing", masked: "sk-...1234", key: "sk-already-prefixed" },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("surfaces Key creation failures", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ tokens: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ err: "Key limit reached" }), { status: 429 })));

    await expect(oauth.fetchHuabotKeys("access-token")).rejects.toThrow("Key limit reached");
  });

  it("rejects an existing list without an importable enabled Key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ tokens: [
      { id: 1, status: 0, token_key: "disabled" },
      { id: 2, status: 1, token_name: "Missing secret" },
    ] }))));

    await expect(oauth.fetchHuabotKeys("access-token")).rejects.toThrow("Huabot did not return a usable Key");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("Huabot OAuth refresh", () => {
  it("refreshes after a forbidden bearer, retains an unrotated refresh token, and retries once", async () => {
    const id = await signedInSession();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "fresh-access", expires_in: 3600 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tokens: [
        { id: 7, token_name: "Existing", token_key: "existing" },
      ] })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(oauth.listHuabotKeys(id)).resolves.toEqual([
      { id: 7, name: "Existing", masked: "", key: "sk-existing" },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://huabot.com/api/token_base/token/my/list/?offset=0&size=100", expect.objectContaining({ headers: { Authorization: "Bearer stale-access" } }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://huabot.com/oauth/token", expect.objectContaining({ method: "POST" }));
    expect((fetchMock.mock.calls[1][1] as RequestInit).body).toEqual(expect.any(URLSearchParams));
    expect((fetchMock.mock.calls[1][1] as RequestInit).body?.toString()).toContain("refresh_token=refresh-secret");
    expect(fetchMock).toHaveBeenNthCalledWith(3, "https://huabot.com/api/token_base/token/my/list/?offset=0&size=100", expect.objectContaining({ headers: { Authorization: "Bearer fresh-access" } }));
    await expect(oauth.loadSession(id)).resolves.toMatchObject({ tokens: { accessToken: "fresh-access", refreshToken: "refresh-secret" } });
  });

  it("does not retry a second authentication failure", async () => {
    const id = await signedInSession();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "fresh-access", expires_in: 3600 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(oauth.listHuabotKeys(id)).rejects.toThrow("forbidden");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("removes the session only when the refresh credential is explicitly invalid", async () => {
    const id = await signedInSession(Date.now());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })));

    await expect(oauth.authorizedSession(id)).rejects.toThrow("Huabot login expired");
    await expect(oauth.loadSession(id)).resolves.toBeNull();
  });
});

describe("refreshTokenIsInvalid", () => {
  it("only discards the stored session when OAuth explicitly rejects the refresh token", () => {
    expect(oauth.refreshTokenIsInvalid(400, "invalid_grant")).toBe(true);
    expect(oauth.refreshTokenIsInvalid(400, "invalid_client")).toBe(false);
    expect(oauth.refreshTokenIsInvalid(401, "invalid_token")).toBe(false);
    expect(oauth.refreshTokenIsInvalid(503, "temporarily_unavailable")).toBe(false);
  });
});
