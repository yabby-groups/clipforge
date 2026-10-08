import voiceCatalog from "../../qwen_tts_non_realtime_voices.json";

export interface QwenTtsVoice {
  voice: string;
  name: string;
  description: string;
  languages?: string[];
  models: Record<string, string[]>;
}

interface QwenTtsVoiceCatalog {
  voices: QwenTtsVoice[];
}

export const QWEN_NON_REALTIME_VOICES = (voiceCatalog as QwenTtsVoiceCatalog).voices;

const QWEN_NON_REALTIME_MODEL_IDS = new Set(
  QWEN_NON_REALTIME_VOICES.flatMap((voice) => Object.values(voice.models).flat())
    .map((model) => model.toLowerCase())
);

/** Whether a model has an entry in the bundled Qwen non-realtime voice catalogue. */
export function isQwenNonRealtimeTtsModel(model: string | undefined | null): boolean {
  return Boolean(model && QWEN_NON_REALTIME_MODEL_IDS.has(model.trim().toLowerCase()));
}

export function getQwenNonRealtimeVoice(voiceId: string | undefined | null): QwenTtsVoice | undefined {
  const normalized = voiceId?.trim();
  return normalized ? QWEN_NON_REALTIME_VOICES.find((voice) => voice.voice === normalized) : undefined;
}
