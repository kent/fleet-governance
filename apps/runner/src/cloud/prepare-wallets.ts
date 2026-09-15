import { fundWallets, provisionWallets } from "./wallets.js";

try {
  await provisionWallets();
  console.log("Verified testnet-only wallet bundle in Secret Manager.");
  await fundWallets(5, async message => { console.log(message); });
  console.log("Five-agent Base Sepolia wallet funding complete.");
} catch (error) {
  // Provider exceptions can include the credential-bearing RPC URL. Keep diagnostics private.
  const message = error instanceof Error ? error.message : "unknown";
  console.error(message.includes("http") || message.includes("alch_") || message.includes("sk-") ? "Wallet setup failed; sensitive provider details withheld." : message);
  process.exitCode = 1;
}
