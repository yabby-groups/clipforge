import { BaseProvider, ProviderError } from "./base";
import type { ImageOptions, ImageResult, MediaType, Model, ProviderConfig, TaskStatus, TaskStatusEnum, VideoOptions, VideoResult } from "./types";

type Task = { id?: string; status?: string; error?: { message?: string } | string; output?: string | string[]; data?: Array<{ url?: string }> };
type HuabotCatalogEntry = { name?: string; title?: string; alias?: string; api_modes?: string[] };

const VIDEO_MODEL_IDS: Record<string, string> = {
  "seedance-2.0-mini": "doubao-seedance-2.0-mini",
  "seedance-2.0": "doubao-seedance-2.0",
  "seedance-2.5": "doubao-seedance-2.5",
};

export function resolveHuabotVideoModel(alias: string): string | undefined {
  return VIDEO_MODEL_IDS[alias];
}

export function huabotTextAliases(entries: HuabotCatalogEntry[]): string[] {
  return entries
    .filter((entry) => entry.api_modes?.some((mode) => mode === "chat_completions" || mode === "responses"))
    .map((entry) => String(entry.alias || "").trim())
    .filter(Boolean);
}

export async function fetchHuabotCatalog(baseUrl = "https://huabot.com", apiKey = ""): Promise<HuabotCatalogEntry[]> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/token_base/model/list/?size=500&offset=0&enabled=1`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    signal: AbortSignal.timeout(8_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Huabot catalog unavailable");
  const json = await response.json() as { models?: HuabotCatalogEntry[] };
  return json.models ?? [];
}

export class HuabotProvider extends BaseProvider {
  readonly name = "huabot";
  readonly displayName = "Huabot";
  catalogMetadata?: { source: "static" | "live" | "cache" | "stale"; updatedAt?: string; fallback?: boolean };
  constructor(config: ProviderConfig) { super({ ...config, baseUrl: (config.baseUrl || "https://huabot.com").replace(/\/$/, "") }); }

  async generateImage(options: ImageOptions): Promise<ImageResult> {
    const hasReferences = Boolean(options.referenceImageUrl || options.referenceImageUrls?.length);
    const response = hasReferences
      ? await this.editImage(options)
      : await this.request<{ data?: Array<{ url?: string; b64_json?: string }> }>("/v1/images/generations", {
          method: "POST",
          body: {
            model: options.modelId,
            prompt: options.prompt,
            n: options.count ?? 1,
            ...(options.width && options.height ? { size: `${options.width}x${options.height}` } : {}),
            ...options.extra,
          },
        });
    const imageUrls = (response.data ?? []).map((item) => item.url ?? (item.b64_json ? `data:image/png;base64,${item.b64_json}` : "")).filter(Boolean);
    if (!imageUrls.length) throw new ProviderError("Huabot image response has no output", "NO_RESULT", this.name);
    return { taskId: `huabot-image-${Date.now()}`, imageUrls, modelId: options.modelId };
  }

  /** OpenAI-compatible image editing is multipart; preserve all ordered references. */
  private async editImage(options: ImageOptions): Promise<{ data?: Array<{ url?: string; b64_json?: string }> }> {
    const references = [
      ...(options.referenceImageUrls ?? []),
      ...(options.referenceImageUrl && !options.referenceImageUrls?.length ? [options.referenceImageUrl] : []),
    ];
    const form = new FormData();
    form.append("model", options.modelId);
    form.append("prompt", options.prompt);
    form.append("n", String(options.count ?? 1));
    if (options.width && options.height) form.append("size", `${options.width}x${options.height}`);
    for (const reference of references) {
      const { blob, filename } = await this.fetchReferenceImage(reference);
      form.append("image[]", blob, filename);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout ?? 120_000);
    try {
      const response = await fetch(`${this.config.baseUrl}/v1/images/edits`, {
        method: "POST",
        headers: this.getAuthHeaders(),
        body: form,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ProviderError(
          `API 请求失败: ${response.status} ${response.statusText} - ${await response.text().catch(() => "")}`,
          "API_ERROR",
          this.name,
          response.status,
        );
      }
      return await response.json() as { data?: Array<{ url?: string; b64_json?: string }> };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      const timedOut = error instanceof DOMException && error.name === "AbortError";
      throw new ProviderError(timedOut ? "请求超时（120000ms）" : `网络请求异常: ${error instanceof Error ? error.message : String(error)}`, timedOut ? "TIMEOUT" : "NETWORK_ERROR", this.name);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async fetchReferenceImage(reference: string): Promise<{ blob: Blob; filename: string }> {
    if (reference.startsWith("data:")) {
      const comma = reference.indexOf(",");
      if (comma === -1) throw new ProviderError("参考图 data URI 解析失败", "BAD_REFERENCE", this.name);
      const mime = reference.slice(5, comma).split(";")[0] || "image/png";
      const encoded = reference.slice(comma + 1);
      const bytes = /;base64/i.test(reference.slice(0, comma)) ? Buffer.from(encoded, "base64") : Buffer.from(decodeURIComponent(encoded));
      return { blob: new Blob([new Uint8Array(bytes)], { type: mime }), filename: `image.${this.extensionFromMime(mime)}` };
    }
    const response = await fetch(reference);
    if (!response.ok) throw new ProviderError(`参考图下载失败: ${response.status}`, "BAD_REFERENCE", this.name);
    const blob = await response.blob();
    const mime = blob.type || response.headers.get("content-type") || "image/png";
    return { blob, filename: `image.${this.extensionFromMime(mime)}` };
  }

  private extensionFromMime(mime: string): string {
    if (mime.includes("webp")) return "webp";
    if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
    return "png";
  }

  async submitVideoTask(options: VideoOptions): Promise<{ taskId: string; modelId: string }> {
    const modelId = resolveHuabotVideoModel(options.modelId);
    if (!modelId) throw new ProviderError("Huabot does not support this video model", "MODEL_NOT_SUPPORTED", this.name);
    const response = await this.request<Task>("/api/v1/videos", { method: "POST", timeout: 60_000, body: { model: modelId, prompt: options.prompt, ...(options.firstFrameUrl ? { image: options.firstFrameUrl } : {}), ...(options.lastFrameUrl ? { last_image: options.lastFrameUrl } : {}), ...(options.duration ? { duration: options.duration } : {}), ...(options.audioEnabled !== undefined ? { generate_audio: options.audioEnabled } : {}), ...options.extra } });
    if (!response.id) throw new ProviderError("Huabot video response has no task id", "NO_TASK_ID", this.name);
    return { taskId: response.id, modelId };
  }
  async generateVideo(options: VideoOptions): Promise<VideoResult> {
    const started = Date.now(); const submitted = await this.submitVideoTask(options); const status = await this.pollTaskStatus(submitted.taskId, { interval: 5000 });
    const result = status.result as VideoResult | undefined;
    if (!result) throw new ProviderError(status.error || "Huabot video failed", "NO_RESULT", this.name);
    return { ...result, taskId: submitted.taskId, modelId: options.modelId, processingTime: Date.now() - started };
  }
  async waitForTask(taskId: string, options?: { interval?: number; maxAttempts?: number }): Promise<TaskStatus> {
    return this.pollTaskStatus(taskId, { interval: options?.interval, maxAttempts: options?.maxAttempts });
  }
  async getTaskStatus(taskId: string): Promise<TaskStatus> {
    const response = await this.request<Task>(`/api/v1/videos/${encodeURIComponent(taskId)}`);
    const raw = String(response.status || "").toLowerCase();
    const status: TaskStatusEnum = /complete|success/.test(raw) ? "completed" : /fail|error/.test(raw) ? "failed" : /cancel/.test(raw) ? "cancelled" : /queue|pending/.test(raw) ? "pending" : "processing";
    const output = Array.isArray(response.output) ? response.output : response.output ? [response.output] : [];
    return { taskId, status, ...(status === "completed" ? { result: { taskId, modelId: "", videoUrls: output.length ? output : [`${this.config.baseUrl}/api/v1/videos/${encodeURIComponent(taskId)}/content`] } as VideoResult } : {}), ...(status === "failed" ? { error: typeof response.error === "string" ? response.error : response.error?.message || "Huabot video failed" } : {}) };
  }
  async listModels(mediaType?: MediaType): Promise<Model[]> {
    try {
      const entries = await fetchHuabotCatalog(this.config.baseUrl, this.config.apiKey);
      const models = entries.flatMap((entry): Model[] => {
        const alias = String(entry.alias || "").trim(); const modes = entry.api_modes ?? [];
        if (!alias) return [];
        if (modes.includes("images")) return [{ id: alias, name: alias, description: entry.title, mediaType: "image", provider: this.name, modes: ["text-to-image", "image-to-image"] }];
        if (modes.includes("other") && resolveHuabotVideoModel(alias)) return [{ id: alias, name: alias, description: entry.title, mediaType: "video", provider: this.name, modes: ["text-to-video", "image-to-video"] }];
        return [];
      });
      this.catalogMetadata = { source: "live", updatedAt: new Date().toISOString() };
      return mediaType ? models.filter((model) => model.mediaType === mediaType) : models;
    } catch { this.catalogMetadata = { source: "static", fallback: true }; return []; }
  }
}
