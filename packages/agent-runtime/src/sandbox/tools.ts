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
  /** This is the task's *starting* tool-call usage count, plainly: not a maximum. The maximum
   *  comes from `charter.budget.toolCalls`, read fresh from the ledger snapshot on every call.
   *  Lets a resumed run seed the counter from wherever a prior process left off, rather than
   *  always starting at 0. (M7) */
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

/** Marker string an operator writes into `charter.forbiddenActions` to mean "no writes that
 *  modify a test", spec'd by the task brief. This is not an `ActionClass` or a `class:target`
 *  pair `evaluateAction` already understands (those are exact-string matches; this is a pattern
 *  over paths and file names), so it is checked here, once, only for `write_repo`, after the
 *  gateway's own charter/exception/escalation/budget checks have already run. */
const MODIFY_TESTS_MARKER = "modify_tests";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Directory names that mark a path as test-owned, wherever they occur (F6 ruling: not just a
 *  top-level `test/`, and not a substring match either - `src/testing/helpers.ts` is not a test
 *  file just because "testing" contains "test"). */
const TEST_DIR_SEGMENTS: ReadonlySet<string> = new Set(["test", "tests", "__tests__"]);

/** Matches a base file name like `foo.test.ts` or `foo.spec.tsx`: `.test.` or `.spec.` appears
 *  somewhere in the name, followed by at least one more character (the extension). */
const TEST_FILE_NAME_PATTERN = /\.(test|spec)\./;

/**
 * True when `target` names a test file, F6's widened ruling: any path segment exactly equals
 * `test`, `tests`, or `__tests__` (a directory, not a substring - `testing/` does not count), or
 * the base file name matches `*.test.*` / `*.spec.*`. Deliberately broader than the brief's
 * literal `test/**`: the rule exists to stop an agent faking a green suite by editing the tests
 * that check its own work, and a write this catches that was actually a legitimate edit still
 * has a governance path out (`GRANT_EXCEPTION`, see F3's exception check in `call`).
 */
function isTestModification(target: string): boolean {
  const normalized = target.startsWith("./") ? target.slice(2) : target;
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => TEST_DIR_SEGMENTS.has(segment))) return true;
  const fileName = segments[segments.length - 1] ?? "";
  return TEST_FILE_NAME_PATTERN.test(fileName);
}

/**
 * npm's package-name grammar plus an optional `@<version-range>` suffix (F4). The character
 * classes here still permit a leading `-` (`~-` at the end of `[a-z0-9~-]` is literal, not a
 * range), which is exactly what would let a name like `-g` be read by npm as an option flag
 * rather than a package name, so `isValidPackageSpec` rejects that separately rather than
 * relying on the regex alone.
 */
const NPM_PACKAGE_SPEC_PATTERN = /^(@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*(@[A-Za-z0-9.^~<>=*|+-]+)?$/;
const NPM_PACKAGE_SPEC_MAX_LENGTH = 214;

/** Validates `pkg` before it ever reaches a subprocess (F4): the npm package-name grammar, a
 *  214-char length cap, no leading `-` (would be read as an npm option flag), and no whitespace
 *  (a separate-argv-element injection attempt). `packageInstall` additionally puts `pkg` after a
 *  literal `--` in argv, so even a spec that somehow slipped past this check could not be read
 *  as an option by npm's own parser; the two defenses are independent, neither relies on the
 *  other. */
function isValidPackageSpec(pkg: string): boolean {
  if (pkg.length === 0 || pkg.length > NPM_PACKAGE_SPEC_MAX_LENGTH) return false;
  if (pkg.startsWith("-")) return false;
  if (/\s/.test(pkg)) return false;
  return NPM_PACKAGE_SPEC_PATTERN.test(pkg);
}

/** F5: `network_fetch`'s response body is capped at 1 MiB so a malicious or merely huge response
 *  cannot exhaust memory or fill a report. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

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
      // F3: this block is waivable like any other forbidden_action (spec 7.6, evaluate.ts's
      // forbidden_action arm), so its own GRANT_EXCEPTION draft has to actually mean something.
      // Check the exact payload the draft carries against the exception registry before
      // committing to the block; a granted exception lets the write proceed as basis:"exception",
      // logged that way, exactly like a charter-based exception would.
      const forbidden = this.forbiddenTestWriteVerdict(descriptor);
      const exceptionVersion = await snapshot.exceptionVersion(forbidden.payloadHash);
      verdict = exceptionVersion !== 0 ? { verdict: "ALLOW", basis: "exception", payloadHash: forbidden.payloadHash } : forbidden;
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
    return charter.forbiddenActions.includes(MODIFY_TESTS_MARKER) && isTestModification(target);
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
    if (!isValidPackageSpec(pkg)) {
      // F4: rejected before any subprocess, argument-injection attempts included ("-g", "foo
      // bar", "foo;rm" are all invalid specs, not commands that ever reach npm).
      throw new Error("invalid_package_name");
    }
    const cmd = "npm";
    // F4: "--" ends npm's own option parsing, so pkg (already validated, and now also argv's
    // very last element rather than interpolated into a flag) cannot be read as another flag
    // even if some future change to the validation above let something unexpected through.
    const args = ["install", "--registry", `https://${tc.target}`, "--", pkg];
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

    // F2: never auto-follow a redirect. A 3xx response might point anywhere, including a host
    // the gateway never evaluated or allowlisted; "manual" hands the raw redirect response back
    // instead of chasing it, so the handler can refuse it outright rather than ever issuing a
    // second request this router never asked the gateway about.
    const response = await this.fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location") ?? "";
      let locationHost = location;
      try {
        locationHost = new URL(location, url).host;
      } catch {
        // Location did not parse as a URL (relative to url or otherwise); fall back to the raw
        // header value rather than throwing out of this branch.
      }
      // Deliberately not the full URL/Location text: only the status and the target host, so
      // the error string cannot itself carry a query string or credentials from the redirect.
      throw new Error(`redirect_refused: ${response.status} -> ${locationHost}`);
    }

    return this.readCappedBody(response);
  }

  /** F5: reads `response`'s body up to `MAX_RESPONSE_BYTES`, honoring `content-length` when
   *  present (rejects before reading anything), and otherwise counting bytes as they stream in
   *  and aborting the moment the cap is crossed, so an unbounded or mislabeled body can never be
   *  buffered in full first. */
  private async readCappedBody(response: Response): Promise<string> {
    const contentLengthHeader = response.headers.get("content-length");
    if (contentLengthHeader !== null) {
      const contentLength = Number(contentLengthHeader);
      if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
        throw new Error("response_too_large");
      }
    }

    const body = response.body;
    if (!body) {
      return response.text();
    }

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error("response_too_large");
        }
        chunks.push(value);
      }
    }
    return Buffer.concat(chunks).toString("utf8");
  }
}
