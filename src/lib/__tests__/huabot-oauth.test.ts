import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchHuabotKeys, refreshTokenIsInvalid } from "@/lib/huabot-oauth";

describe("fetchHuabotKeys", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates a Key when the account has no Keys", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ tokens: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: { id: 42, token_name: "Default", token_key: "created" } }))));

    await expect(fetchHuabotKeys("access-token")).resolves.toEqual([
      { id: 42, name: "Default", masked: "", key: "sk-created" },
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith("https://huabot.com/api/token_base/token/create/", expect.objectContaining({ method: "POST", headers: { Authorization: "Bearer access-token" } }));
  });

  it("uses an existing enabled Key without creating another", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ tokens: [
      { id: "7", status: 1, name: "Existing", secret: "already-prefixed", token_key_masked: "sk-...1234" },
    ] }))));

    await expect(fetchHuabotKeys("access-token")).resolves.toEqual([
      { id: 7, name: "Existing", masked: "sk-...1234", key: "sk-already-prefixed" },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("surfaces Key creation failures", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ tokens: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ err: "Key limit reached" }), { status: 429 })));

    await expect(fetchHuabotKeys("access-token")).rejects.toThrow("Key limit reached");
  });

  it("rejects an existing list without an importable enabled Key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ tokens: [
      { id: 1, status: 0, token_key: "disabled" },
      { id: 2, status: 1, token_name: "Missing secret" },
    ] }))));

    await expect(fetchHuabotKeys("access-token")).rejects.toThrow("Huabot did not return a usable Key");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("refreshTokenIsInvalid", () => {
  it("only discards the stored session when OAuth explicitly rejects the refresh token", () => {
    expect(refreshTokenIsInvalid(400, "invalid_grant")).toBe(true);
    expect(refreshTokenIsInvalid(400, "invalid_client")).toBe(false);
    expect(refreshTokenIsInvalid(401, "invalid_token")).toBe(false);
    expect(refreshTokenIsInvalid(503, "temporarily_unavailable")).toBe(false);
  });
});
