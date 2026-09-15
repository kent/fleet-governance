import { generateKeyPairSync, verify } from "node:crypto";
import { expect, it } from "vitest";
import { faucetJwt, walletNames } from "./wallets.js";

it("signs a short-lived Ed25519 JWT scoped to the official faucet operation", () => {
  const pair = generateKeyPairSync("ed25519");
  const seed = Buffer.from(pair.privateKey.export({ format: "der", type: "pkcs8" })).subarray(-32);
  const publicBytes = Buffer.from(pair.publicKey.export({ format: "der", type: "spki" })).subarray(-32);
  const jwt = faucetJwt("test-id", Buffer.concat([seed, publicBytes]).toString("base64"), 1000);
  const [header, payload, signature] = jwt.split(".");
  expect(verify(null, Buffer.from(`${header}.${payload}`), pair.publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
  expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toMatchObject({ nbf: 1000, exp: 1120, uri: "POST api.cdp.coinbase.com/platform/v2/evm/faucet", sub: "test-id" });
  expect(() => faucetJwt("test-id", Buffer.concat([seed, Buffer.alloc(32)]).toString("base64"))).toThrow("mismatch");
});

it("reserves separate operator and agent identities and refuses unsupported fleet sizes", () => {
  expect(walletNames(5)).toHaveLength(9);
  expect(new Set(walletNames(25)).size).toBe(29);
  for (const count of [0, 1, 2.5, 26, Number.NaN]) expect(() => walletNames(count)).toThrow();
});
