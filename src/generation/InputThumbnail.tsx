import { useState, type ReactNode } from "react";
import { AssetPreview, useAssetUrl } from "../assets/AssetPreview";
import type { Asset } from "../types";

export function InputThumbnail({
  asset,
  fallback,
}: {
  asset?: Asset;
  fallback: ReactNode;
}) {
  const url = useAssetUrl(asset?.kind === "image" ? asset : undefined);
  const [failedUrl, setFailedUrl] = useState("");
  if (asset?.kind === "audio" || asset?.kind === "text" || asset?.kind === "file")
    return <span className="input-audio-name">{asset.name}</span>;
  if (asset?.kind === "video") return <AssetPreview asset={asset} />;
  if (!asset || !url || failedUrl === url) return fallback;
  if (asset.kind === "image")
    return (
      <img
        src={url}
        alt={asset.name}
        draggable={false}
        onError={() => setFailedUrl(url)}
      />
    );
  return fallback;
}
