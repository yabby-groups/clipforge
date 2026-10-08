import { describe, expect, it } from "vitest";
import {
  getQwenNonRealtimeVoice,
  isQwenNonRealtimeTtsModel,
  QWEN_NON_REALTIME_VOICES,
} from "@/lib/qwen-tts-voices";

describe("Qwen non-realtime voice catalogue", () => {
  it("exposes the complete bundled voice list", () => {
    expect(QWEN_NON_REALTIME_VOICES).toHaveLength(48);
    expect(getQwenNonRealtimeVoice("Cherry")).toMatchObject({
      name: "芊悦",
      voice: "Cherry",
    });
  });

  it("recognizes only model identifiers declared by the catalogue", () => {
    expect(isQwenNonRealtimeTtsModel("qwen3-tts-flash")).toBe(true);
    expect(isQwenNonRealtimeTtsModel(" QWEN3-TTS-INSTRUCT-FLASH-2026-01-26 ")).toBe(true);
    expect(isQwenNonRealtimeTtsModel("tts-1")).toBe(false);
    expect(isQwenNonRealtimeTtsModel("qwen2.5-tts")).toBe(false);
  });
});
