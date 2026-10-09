// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { NextRequest } from "next/server";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import type { ComposeConfig } from "@/lib/video-composer/composer";

const state = vi.hoisted(() => ({
  db: null as unknown,
  dir: "",
  speechSeconds: 2,
  speech: vi.fn(),
  compose: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/paths", async (original) => ({ ...await original<object>(), getDataDir: () => state.dir }));
vi.mock("@/lib/edge-tts", async (original) => ({ ...await original<object>(), generateSpeechFreeDetailed: state.speech }));
vi.mock("@/lib/video-composer/composer", async (original) => ({ ...await original<object>(), composeVideo: state.compose }));
vi.mock("@/lib/video-composer/frame-extract", () => ({ extractFirstFrame: vi.fn().mockResolvedValue(undefined) }));
vi.mock("child_process", async (original) => ({
  ...await original<object>(),
  exec: (command: string, callback: (error: null, result: { stdout: string; stderr: string }) => void) => {
    callback(null, {
      stdout: command.includes("format=duration") ? String(command.includes(".mp3") ? state.speechSeconds : 4) : "audio",
      stderr: "max_volume: -3 dB",
    });
  },
}));
import { POST } from "@/app/api/project/[id]/compose/route";

const sqlite = new Database(":memory:");
const db = drizzle(sqlite, { schema });
beforeAll(async () => {
  state.db = db;
  migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });
  state.dir = await mkdtemp(join(tmpdir(), "clipforge-compose-narration-"));
  await mkdir(join(state.dir, "uploads", "project"), { recursive: true });
  await writeFile(join(state.dir, "uploads", "project", "clip.mp4"), "mock video");
});
beforeEach(() => {
  db.delete(schema.projects).run();
  db.insert(schema.projects).values({ id: "project", name: "test", productImages: ["/api/files/project/clip.mp4"] }).run();
  db.insert(schema.scripts).values({
    projectId: "project", title: "test", styleType: "scene", selected: true,
    shots: Array.from({ length: 6 }, (_, index) => ({
      shotId: index + 1, type: "demo", duration: 3, description: "test", camera: "static",
      visualSource: "ai_generate", transition: "direct_concat", voiceover: `台词${index + 1}`,
    })),
  }).run();
  state.speechSeconds = 2;
  state.speech.mockReset().mockResolvedValue({ audio: Buffer.alloc(128), words: [] });
  state.compose.mockReset().mockImplementation(async () => join(state.dir, "final.mp4"));
});
afterAll(async () => { sqlite.close(); await rm(state.dir, { recursive: true, force: true }); });

async function render() {
  const response = await POST(new NextRequest("http://localhost/api/project/project/compose", {
    method: "POST", body: JSON.stringify({ freeTts: { enabled: true } }),
  }), { params: Promise.resolve({ id: "project" }) });
  expect(response.status).toBe(202);
  const { compositionId } = await response.json();
  await vi.waitFor(() => {
    expect(db.select().from(schema.compositions).all().find((row) => row.id === compositionId)?.status).not.toBe("composing");
  });
  return db.select().from(schema.compositions).all().find((row) => row.id === compositionId)!;
}

describe("script narration composition", () => {
  it("reads all six shots despite audible source audio and aligns captions to their narration", async () => {
    const result = await render();
    expect(result.status).toBe("done");
    expect(state.speech.mock.calls.map(([text]) => text)).toEqual(Array.from({ length: 6 }, (_, i) => `台词${i + 1}`));
    const config = state.compose.mock.calls[0][0] as ComposeConfig;
    expect(config.clips).toHaveLength(6);
    config.clips.forEach((clip, index) => {
      expect(clip.hasAudio).toBe(false);
      expect(clip.audioPath).toContain(`shot-${index + 1}-${result.id}.mp3`);
      expect(clip.duration).toBeCloseTo(2.45);
    });
    for (let index = 0; index < 6; index++) {
      const cues = config.subtitle!.texts.filter((cue) => cue.startTime >= index * 2.45 - 0.001 && cue.startTime < (index + 1) * 2.45 - 0.001);
      expect(cues.map((cue) => cue.text).join("")).toBe(`台词${index + 1}`);
      expect(cues[0].startTime).toBeCloseTo(index * 2.45);
      expect(cues.at(-1)!.endTime).toBeCloseTo((index + 1) * 2.45);
    }
  });

  it("keeps speech longer than twenty seconds intact", async () => {
    state.speechSeconds = 25;
    expect((await render()).status).toBe("done");
    const config = state.compose.mock.calls[0][0] as ComposeConfig;
    expect(config.clips[0].duration).toBeCloseTo(25.45);
    expect(config.subtitle?.texts[1].startTime).toBeCloseTo(25.45);
  });

  it("fails composition when a later shot cannot be voiced", async () => {
    state.speech.mockResolvedValueOnce({ audio: Buffer.alloc(128), words: [] }).mockRejectedValueOnce(new Error("TTS unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await render()).status).toBe("failed");
      expect(state.compose).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); error.mockRestore(); }
  });
});
