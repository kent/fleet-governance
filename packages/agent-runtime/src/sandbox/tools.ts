import type { ActionClass, ActionDescriptor, CharterV1 } from "@fleet/schemas";
import { describeAction, evaluateAction } from "@fleet/gateway";
import type { DraftProposal, GatewayLogRecord, GatewayVerdict, LedgerSnapshot, LedgerWatcher } from "@fleet/gateway";
import { payloadHashForAction } from "@fleet/sdk";
import type { Workspace } from "./workspace.js";
import { dockerRunTests as realDockerRunTests, npmTestInProcess, runCommand } from "./docker.js";

export type ToolCall = { class: ActionClass; target: string; args: Record<string, unknown> };

export type ToolResult =
  | { ok: true; output: string }
  | { ok: false; blocked: GatewayVerdict & { verdict: "BLOCK" } }
  | { ok: false; error: string };

/** What `run_tests`'s `output` string decodes to (`JSON.parse`d). `fallback: "no-docker"` is
 *  present only when Docker was unavailable and the suite ran in-process instead, so a report
 *  can flag the run as having lost `--network none` isolation (amendment 4). */
export type RunTestsOutput = { passed: boolean; output: string; fallback?: "no-docker" };

type SpawnResult = { code: number | null; output: string };
type CommandRunner = (cmd: string, args: string[], opts: { cwd?: string }) => Promise<SpawnResult>;

export type ToolRouterOpts = {
  workspace: Workspace;
  watcher: LedgerWatcher;
  agentId: number;
  /** The task's running tool-call usage as of construction (not a maximum: the maximum is
   *  `charter.budget.toolCalls`, read fresh from the ledger snapshot on every call). Lets a
   *  resumed run seed the counter from wherever a prior process left off, rather than always
   *  starting at 0. */
  budget: { toolCalls: number };
  log: (r: GatewayLogRecord) => void;
  fetchImpl?: typeof fetch;
  dockerRunTests?: (dir: string) => Promise<{ passed: boolean; output: string }>;
  /**
   * Deviation from the brief's illustrative constructor snippet, which lists no injection point
   * for `package_install`: amendment 6 requires tests to "assert the command that would run
   * (inject a fake runner) rather than installing anything", and there is no way to satisfy that
   * without one. Defaults to a real `npm install` (argv array, never a shell string, so `pkg`
   * cannot inject additional shell commands regardless of its content).
   */
  packageInstallRunner?: CommandRunner;
};

/** Marker string an operator writes into `charter.forbiddenActions` to mean "no writes under a
 *  top-level `test/` directory", spec'd by the task brief. This is not an `ActionClass` or a
 *  `class:target` pair `evaluateAction` already understands (those are exact-string matches; this
 *  is a glob over every path under `test/`), so it is checked here, once, only for `write_repo`,
 *  after the gateway's own charter/exception/escalation/budget checks have already run. */
const MODIFY_TESTS_MARKER = "modify_tests";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when `target` names a path under a top-level `test/` directory (`test/**` in the
 *  brief's glob notation): the first path segment, after stripping a leading `./`, is `test`. */
function isUnderTestDir(target: string): boolean {
  const normalized = target.startsWith("./") ? target.slice(2) : target;
  const first = normalized.split("/")[0];
  return first === "test";
}

/**
 * Routes one agent's tool calls through the charter gateway: describes the call as an
 * `ActionDescriptor`, asks `evaluateAction` for a verdict against the task's current ledger
 * snapshot, executes the matching handler only on ALLOW, and logs the final decision every
 * time, allowed or blocked. No handler ever runs before the gateway has ruled on the call; no
 * handler reads `args` for anything beyond the one or two fields it needs to act (a file's new
 * content, a fetch path, a package name), so text inside `args` cannot change what the gateway
 * decided, only what a handler that was already allowed to run does with it.
 */
export class ToolRouter {
  private readonly workspace: Workspace;
  private readonly watcher: LedgerWatcher;
  private readonly agentId: number;
  private readonly usageState: { toolCalls: number };
  private readonly logSink: (r: GatewayLogRecord) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly runDockerTests: (dir: string) => Promise<{ passed: boolean; output: string }>;
  private readonly packageInstallRunner: CommandRunner;

  constructor(opts: ToolRouterOpts) {
    this.workspace = opts.workspace;
    this.watcher = opts.watcher;
    this.agentId = opts.agentId;
    this.usageState = { toolCalls: opts.budget.toolCalls };
    this.logSink = opts.log;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.runDockerTests = opts.dockerRunTests ?? realDockerRunTests;
    this.packageInstallRunner =
      opts.packageInstallRunner ?? ((cmd, args, runOpts) => runCommand(cmd, args, { ...runOpts, timeoutMs: 120_000 }));
  }

  usage(): { toolCalls: number } {
    return { toolCalls: this.usageState.toolCalls };
  }

  async call(tc: ToolCall): Promise<ToolResult> {
    const descriptor = describeAction({ class: tc.class, target: tc.target, args: tc.args });
    const snapshot = await this.watcher.snapshot();

    let verdict: GatewayVerdict = await evaluateAction(snapshot, descriptor, this.usageState);
    // Every call counts against the budget, allowed or blocked (amendment 7): a fleet that keeps
    // calling tools after it has run out of budget keeps getting blocked, not a fresh chance.
    this.usageState.toolCalls += 1;

    if (verdict.verdict === "ALLOW" && tc.class === "write_repo" && this.isForbiddenTestWrite(snapshot.charter, tc.target)) {
      verdict = this.forbiddenTestWriteVerdict(descriptor);
    }

    this.logSink(this.buildLogRecord(snapshot, descriptor, verdict));

    if (verdict.verdict === "BLOCK") {
      return { ok: false, blocked: verdict };
    }

    try {
      const output = await this.execute(tc);
      return { ok: true, output };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }

  private isForbiddenTestWrite(charter: CharterV1, target: string): boolean {
    return charter.forbiddenActions.includes(MODIFY_TESTS_MARKER) && isUnderTestDir(target);
  }

  private forbiddenTestWriteVerdict(descriptor: ActionDescriptor): GatewayVerdict & { verdict: "BLOCK" } {
    const payloadHash = payloadHashForAction(descriptor);
    const draft: DraftProposal = {
      kind: "GRANT_EXCEPTION",
      payloadHash,
      summary: `Grant exception: ${descriptor.class} ${descriptor.target}`,
    };
    return { verdict: "BLOCK", reason: "forbidden_action", payloadHash, draft };
  }

  private buildLogRecord(snapshot: LedgerSnapshot, descriptor: ActionDescriptor, verdict: GatewayVerdict): GatewayLogRecord {
    return {
      ts: new Date().toISOString(),
      blockNumber: snapshot.blockNumber.toString(),
      taskId: snapshot.taskId.toString(),
      agentId: this.agentId,
      charterVersion: snapshot.charterVersion,
      descriptor,
      payloadHash: verdict.payloadHash,
      verdict: verdict.verdict,
      ...(verdict.verdict === "BLOCK" ? { reason: verdict.reason } : {}),
      ...(verdict.verdict === "ALLOW" ? { basis: verdict.basis } : {}),
    };
  }

  private async execute(tc: ToolCall): Promise<string> {
    switch (tc.class) {
      case "read_repo":
        return this.readRepo(tc);
      case "write_repo":
        return this.writeRepo(tc);
      case "run_tests":
        return this.runTests();
      case "package_install":
        return this.packageInstall(tc);
      case "network_fetch":
        return this.networkFetch(tc);
      case "shell":
        // Unreachable: evaluateAction hard-blocks `shell` (spec 10.2) before ALLOW is ever
        // returned, so `call` never reaches `execute` for this class.
        throw new Error("ToolRouter: shell must never reach execution");
    }
  }

  private async readRepo(tc: ToolCall): Promise<string> {
    return this.workspace.readFile(tc.target);
  }

  private async writeRepo(tc: ToolCall): Promise<string> {
    const content = typeof tc.args.content === "string" ? tc.args.content : "";
    await this.workspace.writeFile(tc.target, content);
    return `wrote ${tc.target}`;
  }

  private async runTests(): Promise<string> {
    try {
      const result = await this.runDockerTests(this.workspace.dir);
      const payload: RunTestsOutput = { passed: result.passed, output: result.output };
      return JSON.stringify(payload);
    } catch (err) {
      const warning =
        `run_tests: Docker unavailable (${errorMessage(err)}); falling back to an in-process ` +
        `npm test with no --network none isolation`;
      // eslint-disable-next-line no-console
      console.warn(warning);
      const fallback = await npmTestInProcess(this.workspace.dir);
      const payload: RunTestsOutput = {
        passed: fallback.passed,
        output: `${warning}\n${fallback.output}`,
        fallback: "no-docker",
      };
      return JSON.stringify(payload);
    }
  }

  private async packageInstall(tc: ToolCall): Promise<string> {
    // Gateway already confirmed tc.target is on charter.externalAllowlist (package_install is a
    // host-allowlisted class, evaluate.ts's isTargetAllowed) before this handler ever runs.
    const pkg = typeof tc.args.pkg === "string" ? tc.args.pkg : "";
    const cmd = "npm";
    const args = ["install", pkg, "--registry", `https://${tc.target}`];
    const result = await this.packageInstallRunner(cmd, args, { cwd: this.workspace.dir });
    return JSON.stringify({ command: `${cmd} ${args.join(" ")}`, code: result.code, output: result.output });
  }

  private async networkFetch(tc: ToolCall): Promise<string> {
    // Gateway already confirmed tc.target is on charter.externalAllowlist before this handler
    // runs. args.path is forced to start with "/" so it can only ever extend the path of
    // http(s)://<target>, never smuggle a different authority in ahead of the first "/" (a
    // path like "@attacker.example" would otherwise be read as `<target>@attacker.example`,
    // moving the actual request to a host the gateway never evaluated).
    const rawPath = typeof tc.args.path === "string" ? tc.args.path : "";
    const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    const scheme = tc.args.scheme === "http" ? "http" : "https";
    const url = `${scheme}://${tc.target}${path}`;

    const response = await this.fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(10_000) });
    return response.text();
  }
}
