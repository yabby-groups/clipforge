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
    const response = await this.request<{ data?: Array<{ url?: string; b64_json?: string }> }>("/api/v1/images", { method: "POST", body: { model: options.modelId, prompt: options.prompt, n: options.count ?? 1, ...(options.width && options.height ? { size: `${options.width}x${options.height}` } : {}), ...(options.referenceImageUrl ? { image: options.referenceImageUrl } : {}), ...options.extra } });
    const imageUrls = (response.data ?? []).map((item) => item.url ?? (item.b64_json ? `data:image/png;base64,${item.b64_json}` : "")).filter(Boolean);
    if (!imageUrls.length) throw new ProviderError("Huabot image response has no output", "NO_RESULT", this.name);
    return { taskId: `huabot-image-${Date.now()}`, imageUrls, modelId: options.modelId };
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
