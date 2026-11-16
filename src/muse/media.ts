export type MuseReferenceKind = "image" | "video" | "audio";

export function museReferenceKind(mime: string): MuseReferenceKind | undefined {
  const match = /^(image|video|audio)\/[a-z0-9!#$&^_.+-]+(?:\s*;.*)?$/i.exec(mime.trim());
  return match?.[1].toLowerCase() as MuseReferenceKind | undefined;
}

