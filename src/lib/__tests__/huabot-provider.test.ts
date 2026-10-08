import { afterEach, describe, expect, it, vi } from "vitest";
import { HuabotProvider, resolveHuabotVideoModel } from "@/lib/providers/huabot";
import { toEditVariant } from "@/lib/gen-params";

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

  it("uses the OpenAI-compatible Images API for text-to-image", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: "aW1hZ2U=" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new HuabotProvider({ name: "huabot", apiKey: "test", baseUrl: "https://huabot.com" });

    await expect(provider.generateImage({ modelId: "gpt-image-2", mode: "text-to-image", prompt: "test", width: 1024, height: 1024 })).resolves.toMatchObject({ modelId: "gpt-image-2" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://huabot.com/v1/images/generations",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ model: "gpt-image-2", prompt: "test", n: 1, size: "1024x1024" }) }),
    );
  });

  it("uses the OpenAI-compatible edit endpoint and uploads reference images", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: "aW1hZ2U=" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new HuabotProvider({ name: "huabot", apiKey: "test", baseUrl: "https://huabot.com" });

    await provider.generateImage({
      modelId: toEditVariant("gpt-image-2"),
      mode: "image-to-image",
      prompt: "test",
      referenceImageUrls: ["data:image/png;base64,aW1hZ2U="],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://huabot.com/v1/images/edits");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.get("model")).toBe("gpt-image-2");
    expect(form.getAll("image[]")).toHaveLength(1);
  });

  it("uses Huabot's canonical GPT Image model for the edit endpoint", () => {
    expect(toEditVariant("gpt-image-2")).toBe("gpt-image-2");
    expect(toEditVariant("openai/gpt-image-2")).toBe("gpt-image-2");
  });

  it("only maps the Seedance aliases supported by Newversion", () => {
    expect(resolveHuabotVideoModel("seedance-2.0-mini")).toBe("doubao-seedance-2.0-mini");
    expect(resolveHuabotVideoModel("seedance-2.5")).toBe("doubao-seedance-2.5");
    expect(resolveHuabotVideoModel("seedance-2.0-fast")).toBeUndefined();
  });
});
