import { reconcileBatch } from "./batch-runner.js";
import { serveReconcile } from "./reconcile-server.js";

/** The batch controller. It advances only batches a signed-in operator authorised, under its
 * own narrow identity: it can start the agent VM, never stop it, and it cannot edit the
 * Guardian's halt records or its service. */
serveReconcile("batch_controller", reconcileBatch, "Batch reconciliation could not finish. No run was started or retired.");
