import { afterEach, describe, expect, it, vi } from "vitest";
import { HuabotProvider, resolveHuabotVideoModel, huabotVideoUnitPrice } from "@/lib/providers/huabot";
import { estimateFilmSpend } from "@/lib/storyboard-film";
import { toEditVariant } from "@/lib/gen-params";
import { buildVideoControlPlan } from "@/lib/video-control-plan";

describe("HuabotProvider", () => {
  it.each(["seedance-2.0-mini", "seedance-2.0", "seedance-2.5"])("sends per-shot product references to Huabot %s", async (modelId) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "shot-1" })));
    vi.stubGlobal("fetch", fetchMock);
    const plan = buildVideoControlPlan({
      provider: "huabot", modelId, locale: "en",
      firstFrameUrl: "https://e.com/key.png", lastFrameUrl: "https://e.com/end.png",
      characterReferenceUrl: "https://e.com/person.png", productReferenceUrl: "https://e.com/product.png",
    });
    const provider = new HuabotProvider({ name: "huabot", apiKey: "test", baseUrl: "https://huabot.com" });
    await provider.submitVideoTask({
      modelId, mode: plan.mode, prompt: plan.promptSuffix,
      firstFrameUrl: plan.firstFrameUrl, lastFrameUrl: plan.lastFrameUrl,
      referenceImageUrls: plan.referenceInputs.filter((item) => item.mediaType === "image").map((item) => item.url),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://huabot.com/api/v1/videos");
    const body = JSON.parse(init.body as string);
    expect(body.input_references).toEqual(["key", "end", "person", "product"].map((name) => ({
      type: "image_url", image_url: { url: `https://e.com/${name}.png` },
    })));
    expect(body.omni_reference_task_type).toBe("reference");
    expect(body.prompt).toContain("@Image4=product appearance");
    expect(body.frame_images).toBeUndefined();
    expect(body.image).toBeUndefined();
    expect(body.last_image).toBeUndefined();
  });

  it.each(["firstFrameUrl", "lastFrameUrl"] as const)("rejects references mixed with %s before upload or submission", async (frame) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const provider = new HuabotProvider({ name: "huabot", apiKey: "test" });
    await expect(provider.submitVideoTask({ modelId: "seedance-2.0-mini", mode: "image-to-video", prompt: "test",
      [frame]: "https://e.com/frame.png", referenceImageUrls: ["data:image/png;base64,aW1hZ2U="] })).rejects.toThrow("首尾帧不能与参考图混用");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([false, true])("sends native data URL frames with last frame enabled: %s", async (withLastFrame) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "frames-1" })));
    vi.stubGlobal("fetch", fetchMock);
    const first = "data:image/png;base64,aW1hZ2U=";
    const last = "data:image/png;base64,bGFzdA==";
    const provider = new HuabotProvider({ name: "huabot", apiKey: "test", baseUrl: "https://huabot.com" });
    await provider.submitVideoTask({ modelId: "seedance-2.0-mini", mode: "image-to-video", prompt: "test",
      firstFrameUrl: first, ...(withLastFrame && { lastFrameUrl: last }) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.frame_images).toEqual([
      { type: "image_url", image_url: { url: first }, frame_type: "first_frame" },
      ...(withLastFrame ? [{ type: "image_url", image_url: { url: last }, frame_type: "last_frame" }] : []),
    ]);
    expect(body.input_references).toBeUndefined();
  });

  it.each([
    { output: "https://e.com/output.mp4" },
    { output: ["https://e.com/output.mp4"], unsigned_urls: ["https://e.com/other.mp4"] },
    { unsigned_urls: ["", "https://e.com/output.mp4"] },
    { unsigned_urls: [""], url: "https://e.com/output.mp4" },
    { url: "https://e.com/output.mp4" },
  ])("reads completed video URLs from %j", async (result) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "completed", ...result }))));
    const provider = new HuabotProvider({ name: "huabot", apiKey: "test", baseUrl: "https://huabot.com" });
    await expect(provider.getTaskStatus("task-1")).resolves.toMatchObject({
      status: "completed", result: { videoUrls: ["https://e.com/output.mp4"] },
    });
  });

  it("reads the published resolution rate without applying a second tier multiplier", () => {
    const description = "480p $0.1028/second\n\n720p $0.2311/second\n\n1080p $0.52/second\n\n4K $2.08/second";
    expect(huabotVideoUnitPrice(description, 1280, 720)).toBe(0.2311);
    expect(huabotVideoUnitPrice(description, 720, 1280)).toBe(0.2311);
    expect(huabotVideoUnitPrice(description, 1080, 1920)).toBe(0.52);
    expect(huabotVideoUnitPrice(description, 480, 854)).toBe(0.1028);
    expect(estimateFilmSpend(huabotVideoUnitPrice(description), 30)).toMatchObject({ unitUsd: 0.2311, maxUsd: 6.933, tierMultiplier: 1 });
    expect(huabotVideoUnitPrice("720p $0.09072/每秒")).toBe(0.09072);
    expect(huabotVideoUnitPrice("720p $0.09/秒")).toBe(0.09);
  });

  it("keeps absent, unsupported-unit and missing-tier prices unknown", () => {
    expect(huabotVideoUnitPrice(undefined)).toBeUndefined();
    expect(huabotVideoUnitPrice("480p $0.03/second")).toBeUndefined();
    expect(huabotVideoUnitPrice("720p $0.03/call")).toBeUndefined();
    expect(huabotVideoUnitPrice("720p CNY 0.03/second")).toBeUndefined();
  });
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

  it("uploads local film references and sends video output settings", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ file: { url: "/upload/a_/bc/a_bc12_34.png" } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "film-1" })));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new HuabotProvider({ name: "huabot", apiKey: "test", baseUrl: "https://huabot.com" });
    await provider.submitVideoTask({ modelId: "seedance-2.0-mini", mode: "video-to-video", prompt: "film",
      referenceImageUrls: ["data:image/png;base64,aW1hZ2U=", "https://example.com/shot.png"],
      duration: 15, width: 720, height: 1280, audioEnabled: true });
    expect(fetchMock.mock.calls[0][0]).toBe("https://huabot.com/api/file/run/");
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body).toMatchObject({ model: "doubao-seedance-2.0-mini", duration: 15, resolution: "720p", ratio: "9:16", generate_audio: true,
      input_references: [
        { type: "image_url", image_url: { url: "https://huabot.com/upload/a_/bc/a_bc12_34.png" } },
        { type: "image_url", image_url: { url: "https://example.com/shot.png" } },
      ] });
  });

  it.each([
    { file: { url: "/upload/gl/7q/gl7qe_YhxiKbVhckzAig7Nty7pjTeplleNphNcuKgoo.png" } },
    { file: { url: "https://huabot.com/upload/gl/7q/gl7qe_YhxiKbVhckzAig7Nty7pjTeplleNphNcuKgoo.png" } },
  ])("uses the returned upload URL from %j", async (result) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(result)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "film-1" })));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new HuabotProvider({ name: "huabot", apiKey: "test" });
    await provider.submitVideoTask({ modelId: "seedance-2.0-mini", mode: "video-to-video", prompt: "film",
      referenceImageUrls: ["data:image/png;base64,aW1hZ2U="] });
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.input_references[0].image_url.url).toBe("https://huabot.com/upload/gl/7q/gl7qe_YhxiKbVhckzAig7Nty7pjTeplleNphNcuKgoo.png");
  });

  it("rejects overlong Mini films before uploading references or submitting a paid task", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const provider = new HuabotProvider({ name: "huabot", apiKey: "test", baseUrl: "https://huabot.com" });
    await expect(provider.submitVideoTask({ modelId: "seedance-2.0-mini", mode: "video-to-video", prompt: "film", duration: 30 })).rejects.toThrow("4-15");
    expect(fetchMock).not.toHaveBeenCalled();
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
