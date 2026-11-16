import type { MediaKind } from "../types";

/** Exact result-node contracts. Input types, titles and topic tags are not outputs. */
export const savedOutputContracts: Record<string, { kind: MediaKind; field: string }> = {
  SaveImage: { kind: "image", field: "images" },
  SaveImageAdvanced: { kind: "image", field: "images" },
  SaveVideo: { kind: "video", field: "images" },
  VHS_VideoCombine: { kind: "video", field: "gifs" },
  SaveAudio: { kind: "audio", field: "audio" },
  SaveAudioMP3: { kind: "audio", field: "audio" },
  SaveAudioAdvanced: { kind: "audio", field: "audio" },
  "easy showAnything": { kind: "text", field: "text" },
  PreviewAny: { kind: "text", field: "text" },
  PreviewImage: { kind: "image", field: "images" },
};
