import { execFileSync } from "node:child_process";

export const PROJECT = "fleet-governance";
export const BUCKET = "fleet-governance-artifacts-449245570324";

export class CloudError extends Error {
  constructor(public readonly status: number, operation: string) { super(`${operation} failed (HTTP ${status}).`); }
}

let credential: { token: string; expires: number } | undefined;
export async function accessToken(): Promise<string> {
  if (credential && credential.expires > Date.now() + 60_000) return credential.token;
  if (process.env.FLEET_GCP_CLI_AUTH === "1") {
    const token = execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    credential = { token, expires: Date.now() + 240_000 };
  } else {
    const response = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new CloudError(response.status, "GCP identity");
    const data = await response.json() as { access_token: string; expires_in: number };
    credential = { token: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  }
  return credential.token;
}

/** Error messages never contain provider URLs, credentials or response bodies. */
export async function googleRequest(service: "storage" | "secretmanager" | "compute" | "run" | "cloudscheduler", resource: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`https://${service}.googleapis.com/${resource}`, {
      ...init, headers: { "content-type": "application/json", Authorization: `Bearer ${await accessToken()}`, ...init.headers }, signal: AbortSignal.timeout(30_000),
    });
  } catch { throw new Error(`${service} request failed; provider details withheld.`); }
  if (!response.ok) throw new CloudError(response.status, service);
  return response;
}

export async function readSecret(name: string, version = "1"): Promise<string> {
  if (!/^fleet-[a-z0-9-]+$/.test(name) || !/^[1-9][0-9]*$/.test(version)) throw new Error("Invalid secret reference.");
  const response = await googleRequest("secretmanager", `v1/projects/${PROJECT}/secrets/${name}/versions/${version}:access`);
  const data = await response.json() as { payload: { data: string } };
  return Buffer.from(data.payload.data, "base64").toString("utf8");
}

export async function readObject<T>(name: string): Promise<T | null> {
  try {
    return await (await googleRequest("storage", `storage/v1/b/${BUCKET}/o/${encodeURIComponent(name)}?alt=media`)).json() as T;
  } catch (error) { if (error instanceof CloudError && error.status === 404) return null; throw error; }
}

export async function writeObject(name: string, value: unknown, createOnly: boolean | string = false): Promise<void> {
  const generation = typeof createOnly === "string" ? createOnly : createOnly ? "0" : undefined;
  if (generation !== undefined && !/^[0-9]+$/.test(generation)) throw new Error("Invalid object generation.");
  await googleRequest("storage", `upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(name)}${generation !== undefined ? `&ifGenerationMatch=${generation}` : ""}`, { method: "POST", body: JSON.stringify(value) });
}

export async function readObjectVersion<T>(name: string): Promise<{ value: T; generation: string } | null> {
  try {
    const metadata = await (await googleRequest("storage", `storage/v1/b/${BUCKET}/o/${encodeURIComponent(name)}`)).json() as { generation: string };
    const value = await (await googleRequest("storage", `storage/v1/b/${BUCKET}/o/${encodeURIComponent(name)}?alt=media&generation=${metadata.generation}`)).json() as T;
    return { value, generation: metadata.generation };
  } catch (error) { if (error instanceof CloudError && error.status === 404) return null; throw error; }
}
