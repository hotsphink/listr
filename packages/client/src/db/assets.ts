import { db } from "./database.js";
import { syncClient } from "../sync/SyncClient.js";
import { registerAsset, assetToSync } from "../sync/assetStore.js";
import type { Asset } from "@listr/shared";

export async function createAsset(file: File): Promise<Asset> {
  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const id = hashHex.slice(0, 20);

  const nameParts = file.name.split(".");
  const ext = nameParts.length > 1 ? nameParts.pop()! : "";
  const mime_type = file.type || "application/octet-stream";
  const n = Date.now();

  const asset: Asset = {
    id,
    data: bytes,
    mime_type,
    ext,
    filename: file.name,
    size: bytes.length,
    created_at: n,
    updated_at: n,
  };

  await db.assets.put(asset);
  await registerAsset(asset);
  syncClient.pushEntity("asset", assetToSync(asset));
  return asset;
}
