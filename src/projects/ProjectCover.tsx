import { useEffect, useState } from "react";
import { acquireAssetUrl } from "../assets/assets";
import type { Asset, Project } from "../types";
import { getBlob } from "./storage";

type CoverUrl = { url: string; release: () => void };

async function existingThumbnail(asset: Asset): Promise<CoverUrl | undefined> {
  try {
    const blob = await getBlob("thumb-" + asset.id, "image/webp");
    if (!blob.type.startsWith("image/")) return;
    const url = URL.createObjectURL(blob);
    let released = false;
    return {
      url,
      release: () => {
        if (released) return;
        released = true;
        URL.revokeObjectURL(url);
      },
    };
  } catch {
    // A cover can use an existing thumbnail, but never creates one on disk.
    return;
  }
}

export function ProjectCover({ project }: { project: Project }) {
  let image: Asset | undefined;
  let video: Asset | undefined;
  for (const asset of Object.values(project.assets)) {
    if (asset.kind === "image" && (!image || asset.createdAt > image.createdAt))
      image = asset;
    if (asset.kind === "video" && (!video || asset.createdAt > video.createdAt))
      video = asset;
  }
  // Only probe one newer video's existing thumbnail; never read video bytes.
  if (image && video && image.createdAt >= video.createdAt) video = undefined;
  const key = `${project.id}:${image?.id ?? ""}:${video?.id ?? ""}`;
  const [cover, setCover] = useState<{ key: string; url: string }>();

  useEffect(() => {
    let active = true;
    let release: (() => void) | undefined;
    const show = async (pending: Promise<CoverUrl | undefined>) => {
      const item = await pending;
      if (!active) {
        item?.release();
        return false;
      }
      if (!item) return false;
      release = item.release;
      setCover({ key, url: item.url });
      return true;
    };
    setCover(undefined);
    void (async () => {
      if (video && (await show(existingThumbnail(video)))) return;
      if (!active || !image) return;
      if (await show(existingThumbnail(image))) return;
      if (!active) return;
      // The normal preview path persists missing thumbnails. Full URLs share
      // the existing cache while keeping the home page completely read-only.
      await show(acquireAssetUrl(image, true));
    })().catch(() => {});
    return () => {
      active = false;
      release?.();
    };
  }, [key, image?.mime]);

  if (cover?.key === key)
    return (
      <img
        className="project-cover-image"
        src={cover.url}
        alt=""
        loading="lazy"
        draggable={false}
        onError={() =>
          setCover((current) => (current?.key === key ? undefined : current))
        }
      />
    );

  return (
    <div className="project-cover-placeholder" aria-hidden="true">
      <span>新</span>
      <small>暂无预览</small>
    </div>
  );
}
