import { NextRequest, NextResponse } from "next/server";
import { createProvider } from "@/lib/providers";
import type { CatalogProvider, ModelCatalogStatus } from "@/lib/model-catalog";
import type { Model } from "@/lib/providers/types";

export async function POST(req: NextRequest) {
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const providers = body?.providers ?? [];
  const mediaType = body?.mediaType;
  if (!Array.isArray(providers) || providers.length > 1 || (mediaType !== undefined && mediaType !== "image" && mediaType !== "video") || providers.some((p) => !p || p.name !== "huabot" || (p.apiKey !== undefined && (typeof p.apiKey !== "string" || p.apiKey.length > 4096)) || (p.baseUrl !== undefined && (typeof p.baseUrl !== "string" || p.baseUrl.length > 2048)))) {
    return NextResponse.json({ error: "Invalid catalog request" }, { status: 400 });
  }
  const types: ("image" | "video")[] = mediaType ? [mediaType] : ["image", "video"];
  const unique = [...new Map((providers as CatalogProvider[]).map((p) => [p.name, p])).values()];
  const results = await Promise.all(unique.flatMap((p) => types.map(async (type) => {
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const provider = createProvider({ name: p.name, apiKey: p.apiKey ?? "", baseUrl: p.baseUrl ?? "", timeout: 10_000 });
      const models = await Promise.race([
        provider.listModels(type, { refresh: body.refresh === true }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("CATALOG_TIMEOUT")), 12_000); }),
      ]);
      const metadata = provider.catalogMetadata;
      const status: ModelCatalogStatus = { provider: p.name, mediaType: type, status: metadata?.fallback ? "fallback" : models.length ? "ready" : "empty", checkedAt: new Date().toISOString(), durationMs: Date.now() - started, count: models.length, source: metadata?.source ?? "static", catalogUpdatedAt: metadata?.updatedAt, ...(metadata?.fallback ? { errorCode: "CATALOG_UNAVAILABLE" as const } : {}) };
      return { models, status };
    } catch (error) {
      // Raw upstream errors can contain request URLs or credentials. Return only a stable code.
      const status: ModelCatalogStatus = { provider: p.name, mediaType: type, status: "error", checkedAt: new Date().toISOString(), durationMs: Date.now() - started, count: 0, errorCode: error instanceof Error && error.message === "CATALOG_TIMEOUT" ? "CATALOG_TIMEOUT" : "CATALOG_UNAVAILABLE" };
      return { models: [] as Model[], status };
    } finally { if (timer) clearTimeout(timer); }
  })));
  return NextResponse.json({ models: results.flatMap((result) => result.models), providers: results.map((result) => result.status) }, { headers: { "Cache-Control": "no-store" } });
}
