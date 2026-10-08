// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("@/lib/providers", () => ({ createProvider: ({ name }: { name: string }) => ({ listModels: async () => {
  if (name === "failed") throw new Error("secret-api-key https://private.example/token");
  return name === "empty" ? [] : [{ id: "model", provider: name, mediaType: "image", name: "Model", modes: ["text-to-image"] }];
} }) }));
import { POST } from "@/app/api/ai/models/route";
describe("per-provider catalog status", () => {
  it("preserves successful results and reports redacted partial failure", async () => {
    const response = await POST(new NextRequest("http://localhost/api/ai/models", { method: "POST", body: JSON.stringify({ providers: [{ name: "huabot" }], mediaType: "image" }) }));
    const result = await response.json();
    expect(result.models).toHaveLength(1);
    expect(result.providers.map((provider: { status: string }) => provider.status)).toEqual(["ready"]);
    expect(JSON.stringify(result)).not.toMatch(/secret-api-key|private.example/);
    expect(result.providers.every((provider: { checkedAt: string }) => !!provider.checkedAt)).toBe(true);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("rejects malformed provider input", async () => {
    const response = await POST(new NextRequest("http://localhost/api/ai/models", { method: "POST", body: JSON.stringify({ providers: [{ name: "atlas-cloud" }] }) }));
    expect(response.status).toBe(400);
  });
});
