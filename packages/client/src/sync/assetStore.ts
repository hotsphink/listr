import { createSignal } from "solid-js";
import { db } from "../db/database.js";
import type { Asset } from "@listr/shared";

export function assetToSync(asset: Asset): Record<string, unknown> {
  let binary = "";
  for (let i = 0; i < asset.data.byteLength; i++) binary += String.fromCharCode(asset.data[i]);
  return { ...asset, data: btoa(binary) };
}

export function assetFromSync(data: Record<string, unknown>): Asset {
  const binary = atob(data.data as string);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { ...(data as any), data: bytes };
}

export const [assetUrls, setAssetUrls] = createSignal<Record<string, string>>({});

// Blob URLs (blob:https://...) pass through the HTML Sanitizer; data: URLs are stripped.
function toBlobUrl(asset: { data: Uint8Array; mime_type: string }): string {
  return URL.createObjectURL(new Blob([asset.data as Uint8Array<ArrayBuffer>], { type: asset.mime_type }));
}

export async function registerAsset(asset: Asset): Promise<void> {
  setAssetUrls((prev) => {
    const key = `hash://${asset.id}.${asset.ext}`;
    const old = prev[key];
    if (old?.startsWith("blob:")) URL.revokeObjectURL(old);
    return { ...prev, [key]: toBlobUrl(asset) };
  });
}

export async function initAssetStore(): Promise<void> {
  const assets = await db.assets.toArray();
  const entries: Record<string, string> = {};
  for (const asset of assets) {
    entries[`hash://${asset.id}.${asset.ext}`] = toBlobUrl(asset);
  }
  setAssetUrls(entries);
}
