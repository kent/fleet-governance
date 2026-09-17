"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Tenant from "@/lib/tenant/tenant";

/** Keep server-rendered tallies, proposal state and bond receipts current while
 * preserving the reader's scroll position and open client-side controls. */
export default function FleetProposalRefresh() {
  const router = useRouter();
  useEffect(() => {
    if (Tenant.current().namespace !== "fleet") return;
    const refresh = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const timer = window.setInterval(refresh, 15_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router]);
  return null;
}
