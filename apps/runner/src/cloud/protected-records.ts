import { CloudError, googleRequest } from "./google.js";
import { COMPUTE_BUCKET } from "./compute-store.js";

export async function protectedRecord<T>(name: string, bucket = COMPUTE_BUCKET): Promise<{ value: T; generation: string } | null> {
  const resource = `storage/v1/b/${bucket}/o/${encodeURIComponent(name)}`;
  try {
    const metadata = await (await googleRequest("storage", resource)).json() as { generation: string };
    if (!/^[0-9]+$/.test(metadata.generation)) throw new Error("Invalid protected object generation.");
    return { generation: metadata.generation, value: await (await googleRequest("storage", `${resource}?alt=media&generation=${metadata.generation}`)).json() as T };
  } catch (error) { if (error instanceof CloudError && error.status === 404) return null; throw error; }
}
export async function putProtected(name: string, value: unknown, generation = "0", bucket = COMPUTE_BUCKET): Promise<void> {
  if (!/^[0-9]+$/.test(generation)) throw new Error("Invalid protected object generation.");
  await googleRequest("storage", `upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(name)}&ifGenerationMatch=${generation}`, { method: "POST", body: JSON.stringify(value) });
}
export async function deleteProtected(name: string, generation: string, bucket = COMPUTE_BUCKET): Promise<void> {
  if (!/^[0-9]+$/.test(generation)) throw new Error("Invalid protected object generation.");
  await googleRequest("storage", `storage/v1/b/${bucket}/o/${encodeURIComponent(name)}?ifGenerationMatch=${generation}`, { method: "DELETE" });
}
