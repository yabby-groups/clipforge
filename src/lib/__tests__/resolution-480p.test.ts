import { describe, expect, it } from "vitest";
import { buildVideoOptions, videoSize } from "@/lib/gen-params";
import { expectedDimensions } from "@/lib/video-composer/qc";
import { useSettingsStore } from "@/lib/stores/settings-store";

describe("480p video resolution", () => {
  it.each([
    ["9:16", 480, 854],
    ["16:9", 854, 480],
    ["1:1", 480, 480],
  ] as const)("uses matching generation and composition dimensions for %s", (aspectRatio, width, height) => {
    expect(videoSize("480p", aspectRatio)).toEqual({ width, height });
    expect(buildVideoOptions({ resolution: "480p", aspectRatio })).toMatchObject({ width, height });
    expect(expectedDimensions("480p", aspectRatio)).toEqual({ width, height });
  });

  it("applies the default resolution to actual generation parameters", () => {
    const before = useSettingsStore.getState();
    try {
      before.setDefaultResolution("480p");
      expect(useSettingsStore.getState().defaultResolution).toBe("480p");
      expect(useSettingsStore.getState().videoParams.resolution).toBe("480p");
    } finally {
      useSettingsStore.setState({ defaultResolution: before.defaultResolution, videoParams: before.videoParams });
    }
  });
});
