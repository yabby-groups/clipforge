import { afterEach, describe, expect, it, vi } from "vitest";
import { HuabotProvider, resolveHuabotVideoModel } from "@/lib/providers/huabot";

describe("HuabotProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the enabled Huabot catalog and maps only media-capable entries", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [
      { name: "openai/gpt-image-2", alias: "gpt-image-2", title: "GPT Image", api_modes: ["images"] },
      { name: "bytedance/seedance-2.0", alias: "seedance-2.0", title: "Seedance", api_modes: ["other"] },
      { name: "openai/gpt-4o-transcribe", alias: "gpt-4o-transcribe", title: "Transcribe", api_modes: ["other"] },
      { name: "qwen/qwen3.8-flash", alias: "qwen3.8-flash", title: "Qwen", api_modes: ["chat_completions"] },
    ] }))));
    const provider = new HuabotProvider({ name: "huabot", apiKey: "test", baseUrl: "https://huabot.com" });
    await expect(provider.listModels()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "gpt-image-2", name: "gpt-image-2", mediaType: "image" }),
      expect.objectContaining({ id: "seedance-2.0", name: "seedance-2.0", mediaType: "video" }),
    ]));
    await expect(provider.listModels()).resolves.not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "gpt-4o-transcribe" })]));
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("size=500&offset=0&enabled=1"), expect.any(Object));
  });

  it("submits a video once and returns the remote task id", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "task-1", status: "queued" }), { status: 200 })));
    const provider = new HuabotProvider({ name: "huabot", apiKey: "test", baseUrl: "https://huabot.com" });
    await expect(provider.submitVideoTask!({ modelId: "seedance-2.0", mode: "text-to-video", prompt: "test" })).resolves.toEqual({ taskId: "task-1", modelId: "doubao-seedance-2.0" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("only maps the Seedance aliases supported by Newversion", () => {
    expect(resolveHuabotVideoModel("seedance-2.0-mini")).toBe("doubao-seedance-2.0-mini");
    expect(resolveHuabotVideoModel("seedance-2.5")).toBe("doubao-seedance-2.5");
    expect(resolveHuabotVideoModel("seedance-2.0-fast")).toBeUndefined();
  });
});
