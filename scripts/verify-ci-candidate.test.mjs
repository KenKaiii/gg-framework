import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { candidateMode, reconstructLocal, reconstructPublic } from "./verify-ci-candidate.mjs";
import { prepareCandidate } from "./upstream-sync.mjs";
import { isolatedEnvironment } from "./consumer-contract.mjs";

const POLICY = JSON.parse(readFileSync(new URL("./upstream-sync-policy.json", import.meta.url)));
const WORKFLOW = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

// Focused source invariants, deliberately not presented as full YAML/schema validation.
function workflowInvariants(source) {
  const code = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(
    code,
    /continue-on-error|secrets:|write-all|:\s*write\b|self-hosted|pull_request_target|workflow_run|upload-artifact|environment:|\btoken\s*:|exclude:|include:|uses:.*(?:actions\/cache@|\/ci\.yml)/,
  );
  assert.doesNotMatch(code, /\|\|\s*true|^ {4}if:/m, "no-masked-or-skipped-required-jobs");
  assert.match(code, /permissions:\n {2}contents: read\n/);
  assert.equal((code.match(/permissions:/g) ?? []).length, 1);
  assert.match(code, /push:\n {4}branches: \[main\]\n {2}pull_request:\n {4}branches: \[main\]/);
  assert.match(code, /toJSON\(inputs\) != '\{\}' && 'kleio-reusable-ci' \|\| github.workflow/);
  assert.match(code, /github.head_ref \|\| github.run_id/);
  assert.match(code, /cancel-in-progress: true/);
  for (const key of ["base_sha", "upstream_sha", "imported_sha", "candidate_sha"])
    assert.ok(
      code.includes(`      ${key}:\n        type: string\n        required: true`),
      "typed-required-input",
    );
  const jobs = code.slice(code.indexOf("\njobs:\n") + 7);
  assert.deepEqual(
    [...jobs.matchAll(/^ {2}([\w-]+):$/gm)].map((match) => match[1]),
    ["test", "verify", "app"],
    "nine-blocking-executions-only",
  );
  const sections = [
    jobs.slice(0, jobs.indexOf("\n  verify:")),
    jobs.slice(jobs.indexOf("\n  verify:"), jobs.indexOf("\n  app:")),
    jobs.slice(jobs.indexOf("\n  app:")),
  ];
  const trustedTests =
    'node --test "$KLEIO_CONTROL_ROOT/scripts/upstream-sync.test.mjs" "$KLEIO_CONTROL_ROOT/scripts/identity-audit.test.mjs" "$KLEIO_CONTROL_ROOT/scripts/consumer-contract.test.mjs" "$KLEIO_CONTROL_ROOT/scripts/verify-ci-candidate.test.mjs"';
  // Both apt-get steps share this wrapper, so a slow mirror can't hold a job.
  const aptGet = [
    "apt_get() {",
    "limit=$1",
    "shift",
    "for try in 1 2 3; do",
    'if sudo timeout -k 20s "$limit" apt-get -o Acquire::Retries=3 \\',
    '-o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 "$@"; then',
    "return 0",
    "fi",
    'echo "::warning::apt-get $1 failed or ran past $limit (try $try of 3)"',
    "sudo dpkg --configure -a",
    "sleep 10",
    "done",
    "return 1",
    "}",
  ];
  const setup = [
    "node scripts/verify-ci-candidate.mjs materialize",
    "pnpm install --frozen-lockfile",
    "pnpm verify:versions\npnpm -r build",
  ];
  const runs = [
    [
      ...setup,
      [
        ...aptGet,
        'if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then',
        'case "$RUNNER_OS" in',
        "Linux)",
        "apt_get 2m update",
        "apt_get 4m install -y --no-install-recommends ffmpeg",
        ";;",
        "macOS) HOMEBREW_NO_AUTO_UPDATE=1 brew install ffmpeg ;;",
        "Windows) choco install ffmpeg --version=8.0.1 -y --no-progress ;;",
        '*) echo "Unsupported media-test runner: $RUNNER_OS" >&2; exit 1 ;;',
        "esac",
        "fi",
        "ffmpeg -version",
        "ffprobe -version",
      ].join("\n"),
      "pnpm -r test",
      "node packages/ggcoder/dist/cli.js --help\nnode packages/ggcoder/dist/cli.js --version\nnode packages/gg-boss/dist/cli.js --help\nnode packages/gg-boss/dist/cli.js --version",
    ],
    [
      ...setup,
      trustedTests,
      'node "$KLEIO_CONTROL_ROOT/scripts/consumer-contract.mjs" --sha "$KLEIO_CI_SHA" --root . --registry-read',
      "node bench/size-gate.mjs --only dist:ggcoder\nnode bench/startup-gate.mjs",
      "pnpm -r check",
      "pnpm audit:identity\npnpm audit:identity:packed\npnpm lint\npnpm format:check",
    ],
    [
      "node scripts/verify-ci-candidate.mjs materialize",
      "node --test scripts/check-link-locks.test.mjs\nnode scripts/check-link-locks.mjs",
      "cargo fmt --check\ncargo clippy --locked --all-targets --features host -- -D warnings\ncargo test --locked --features host",
      [
        ...aptGet,
        "apt_get 2m update",
        "apt_get 4m install -y libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev patchelf libayatana-appindicator3-dev",
      ].join("\n"),
      "pnpm install --frozen-lockfile",
      "pnpm --filter @kleio/coder... build",
      "pnpm --filter @kleio/host build\ncargo test --locked --features host --manifest-path packages/kleio-link/Cargo.toml --test end_to_end -- --ignored",
      "pnpm --filter gg-app stage:node\npnpm --filter gg-app bundle:sidecar",
      "node gg-app/scripts/smoke-sidecar.mjs",
      "node bench/size-gate.mjs --only sidecar",
      "pnpm --filter gg-app build\nnode bench/size-gate.mjs --only frontend:initial",
      "pnpm --filter gg-app test",
      "cargo test",
      "pnpm smoke:packaged",
    ],
  ];
  sections.forEach((section, index) => {
    const isApp = index === 2;
    // The test and verify jobs budget 30 minutes: on a slow Windows runner test
    // takes ~15 min and verify ~18 min (as one job they reached ~29.5). The app
    // jobs budget 45: the Windows leg builds an MSI, and a cold Rust cache took
    // it past 30.
    assert.ok(section.includes(`timeout-minutes: ${[30, 30, 45][index]}`), "existing-budget");
    assert.match(section, /runs-on: \$\{\{ matrix.os \}\}/);
    assert.match(section, /fail-fast: false/);
    assert.match(section, /os: \[ubuntu-latest, macos-latest, windows-latest\]/);
    assert.ok(
      section.includes(
        'shell: node "${{ github.workspace }}/control/scripts/verify-ci-candidate.mjs" shell bash {0}',
      ),
      "trusted-bash-wrapper",
    );
    assert.ok(
      section.includes(
        "ref: ${{ github.sha }}\n          persist-credentials: false\n          fetch-depth: 0\n          path: control",
      ),
      "pinned-credential-free-control",
    );
    assert.ok(section.includes("CANDIDATE_INPUTS: ${{ toJSON(inputs) }}"), "presence-input-mode");
    assert.ok(
      section.includes("cache: ${{ steps.candidate.outputs.mode == 'ordinary' && 'pnpm' || '' }}"),
      "candidate-cache-disabled",
    );
    assert.ok(
      section.includes("package-manager-cache: ${{ steps.candidate.outputs.mode == 'ordinary' }}"),
      "candidate-auto-cache-disabled",
    );
    assert.match(section, /cache-dependency-path: subject\/pnpm-lock.yaml/);
    assert.ok(
      section.includes(
        "package_json_file: subject/package.json\n          cache: false\n          cache_dependency_path: subject/pnpm-lock.yaml",
      ),
      "pnpm-setup-cache-and-subject",
    );
    assert.deepEqual(
      [...section.matchAll(/working-directory: (.+)/g)].map((m) => m[1]),
      isApp
        ? [
            "subject",
            "control",
            "subject/packages/kleio-link",
            "subject/gg-app/src-tauri",
            "subject/gg-app",
          ]
        : ["subject", "control"],
      "subject-working-directories",
    );
    assert.deepEqual(
      [...section.matchAll(/^ {8}if: (.+)/gm)].map((m) => m[1]),
      isApp ? ["runner.os == 'Linux'", "runner.os == 'Windows'"] : [],
      "no-skipped-checks",
    );
    const actual = [...section.matchAll(/^ {8}run: (.+)(?:\n((?: {10}.*(?:\n|$))*))?/gm)].map(
      (m) =>
        m[1] === "|"
          ? m[2]
              .trim()
              .split("\n")
              .map((line) => line.trim())
              .join("\n")
          : m[1],
    );
    assert.deepEqual(actual, runs[index], "all-existing-commands-and-new-gates");
    assert.equal((section.match(/^ {8}shell: /gm) ?? []).length, 2, "no-wrapper-bypass");
    assert.ok(
      section.indexOf("materialize") < section.indexOf("pnpm/action-setup"),
      "verify-before-install",
    );
    assert.ok(
      isApp
        ? section.includes("node-version: 22.x")
        : section.includes("node: [22.x]") && section.includes("node-version: ${{ matrix.node }}"),
      "node-22",
    );
  });
  assert.ok(sections[0].includes("name: ${{ matrix.os }} · node ${{ matrix.node }}"));
  assert.ok(sections[1].includes("name: verify · ${{ matrix.os }} · node ${{ matrix.node }}"));
  assert.ok(sections[2].includes("name: app · ${{ matrix.os }}"));
  assert.ok(
    sections[2].includes(
      "workspaces: |\n            subject/gg-app/src-tauri\n            subject/packages/kleio-link\n          save-if: ${{ steps.candidate.outputs.mode == 'ordinary' }}",
    ),
    "candidate-rust-restore-only",
  );
}

test("CI keeps all nine blocking executions, trusted inputs, budgets and isolated caches", () =>
  workflowInvariants(WORKFLOW));
test("focused CI regression checks reject meaningful workflow mutations", () => {
  const consumerStep =
    '      - name: Packed public consumer contracts\n        run: node "$KLEIO_CONTROL_ROOT/scripts/consumer-contract.mjs" --sha "$KLEIO_CI_SHA" --root . --registry-read\n';
  const packagedStep =
    "      - name: Packaged app smoke (MSI build + launch)\n        if: runner.os == 'Windows'\n        working-directory: subject/gg-app\n        run: pnpm smoke:packaged\n";
  for (const [before, after] of [
    [consumerStep, ""],
    [
      "- name: Packed public consumer contracts",
      "- name: Packed public consumer contracts\n        if: false",
    ],
    ["--root . --registry-read", "--root . --registry-read || true"],
    [
      "- name: Packed public consumer contracts",
      "- name: Packed public consumer contracts\n        continue-on-error: true",
    ],
    ['--sha "$KLEIO_CI_SHA" --root', '--sha "$GITHUB_SHA" --root'],
    [packagedStep, ""],
    ["if: runner.os == 'Windows'", "if: runner.os == 'Windows' && false"],
    ["run: pnpm smoke:packaged", "run: pnpm smoke:packaged || true"],
    ["run: pnpm smoke:packaged", "continue-on-error: true\n        run: pnpm smoke:packaged"],
    ["  app:\n", "  app:\n    if: false\n"],
    ["  test:\n", "  test:\n    if: false\n"],
    ["  verify:\n", "  verify:\n    if: false\n"],
    ["ubuntu-latest, macos-latest, windows-latest", "ubuntu-latest, macos-latest"],
    ["pnpm -r check", "echo removed"],
    ["pnpm -r check", "pnpm -r check || true"],
    ["pnpm -r test", "pnpm -r test || true"],
    ["timeout-minutes: 30", "timeout-minutes: 60"],
    ["timeout-minutes: 45", "timeout-minutes: 60"],
    ['sudo timeout -k 20s "$limit" apt-get', "sudo apt-get"],
    ["fail-fast: false", "fail-fast: true"],
    ["ref: ${{ github.sha }}", "ref: main"],
    ["persist-credentials: false", "persist-credentials: true"],
    ["contents: read", "contents: write"],
    ["  contents: read", "  contents: read\nsecrets: inherit"],
    ["save-if: ${{ steps.candidate.outputs.mode == 'ordinary' }}", "save-if: true"],
    ["cache: ${{ steps.candidate.outputs.mode == 'ordinary' && 'pnpm' || '' }}", "cache: pnpm"],
    [
      "package-manager-cache: ${{ steps.candidate.outputs.mode == 'ordinary' }}",
      "package-manager-cache: true",
    ],
    ["working-directory: subject", "working-directory: control"],
    ["cache: false", "cache: true"],
    ["package_json_file: subject/package.json", "package_json_file: control/package.json"],
    ["run: cargo test", "continue-on-error: true\n        run: cargo test"],
  ]) {
    assert.ok(WORKFLOW.includes(before), before);
    assert.throws(() => workflowInvariants(WORKFLOW.replace(before, after)), undefined, before);
  }
  const noAppWindows = WORKFLOW.replace(
    /( {2}app:[\s\S]*?)ubuntu-latest, macos-latest, windows-latest/,
    "$1ubuntu-latest, macos-latest",
  );
  assert.notEqual(noAppWindows, WORKFLOW);
  assert.throws(() => workflowInvariants(noAppWindows));
  // Moving a gate back into `test` must fail too: the split keeps each job in budget.
  const consumerInTest = WORKFLOW.replace(consumerStep, "").replace(
    "      - name: Test framework packages\n",
    consumerStep + "\n      - name: Test framework packages\n",
  );
  assert.equal(consumerInTest.split(consumerStep).length, 2);
  assert.ok(consumerInTest.indexOf(consumerStep) < consumerInTest.indexOf("\n  verify:\n"));
  assert.throws(() => workflowInvariants(consumerInTest));
});
function callerInvariants(source) {
  const code = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  assert.deepEqual(
    [...code.matchAll(/^([\w-]+):/gm)].map((m) => m[1]),
    ["name", "on", "permissions", "concurrency", "jobs"],
  );
  assert.match(code, /^name: Upstream candidate verification\n/);
  const on = code.slice(code.indexOf("\non:\n"), code.indexOf("\npermissions:\n"));
  assert.deepEqual(
    [...on.matchAll(/^ {2}([\w-]+):/gm)].map((m) => m[1]),
    ["workflow_dispatch"],
  );
  assert.match(on, /workflow_dispatch:\n {4}inputs:\n/);
  const keys = ["base_sha", "upstream_sha", "imported_sha", "candidate_sha"];
  assert.deepEqual(
    [...on.matchAll(/^ {6}([\w-]+):/gm)].map((m) => m[1]),
    keys,
  );
  for (const key of keys)
    assert.ok(
      on.includes(`      ${key}:\n        type: string\n        required: true`),
      "direct-required-string-input",
    );
  assert.equal(
    code.slice(code.indexOf("\npermissions:\n"), code.indexOf("\nconcurrency:\n")).trim(),
    "permissions:\n  contents: read",
  );
  assert.equal(
    code.slice(code.indexOf("\nconcurrency:\n"), code.indexOf("\njobs:\n")).trim(),
    "concurrency:\n  group: kleio-upstream-dispatch-${{ github.run_id }}\n  cancel-in-progress: true",
  );
  assert.doesNotMatch(
    code,
    /\b(?:if|secrets|default|steps|strategy|runs-on|continue-on-error):|\|\| true|@main/,
  );
  assert.equal(
    code.slice(code.indexOf("\njobs:\n")).trim(),
    [
      "jobs:",
      "  candidate-ci:",
      "    uses: ./.github/workflows/ci.yml",
      "    with:",
      ...keys.map((key) => `      ${key}: \${{ inputs.${key} }}`),
    ].join("\n"),
    "single-pinned-reusable-call-with-no-substitutions",
  );
}

test("manual caller passes four required SHAs to only the existing reusable CI with read-only permissions", () => {
  callerInvariants(
    readFileSync(new URL("../.github/workflows/upstream-sync.yml", import.meta.url), "utf8"),
  );
});

test("manual caller mutations cannot substitute inputs, inherit secrets, mask failures, or duplicate CI", () => {
  const source = readFileSync(
    new URL("../.github/workflows/upstream-sync.yml", import.meta.url),
    "utf8",
  );
  const mutations = [
    ...["base_sha", "upstream_sha", "imported_sha", "candidate_sha"].map((key) =>
      source.replace(`\${{ inputs.${key} }}`, "${{ github.sha }}"),
    ),
    source.replace("workflow_dispatch:", "schedule:"),
    source.replace("type: string", "type: boolean"),
    source.replace("required: true", "required: false"),
    source.replace("contents: read", "contents: write"),
    source.replace("kleio-upstream-dispatch-", "kleio-reusable-ci-"),
    source.replace("    with:\n", "    secrets: inherit\n    with:\n"),
    source.replace("    with:\n", "    if: false\n    with:\n"),
    source.replace("    with:\n", "    continue-on-error: true\n    with:\n"),
    source.replace(
      "uses: ./.github/workflows/ci.yml",
      "uses: fmckie/gg-framework/.github/workflows/ci.yml@main",
    ),
    source + "  duplicate-ci:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm test\n",
    source +
      "  promotion:\n    needs: candidate-ci\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo success\n",
  ];
  for (const mutation of mutations) {
    assert.notEqual(mutation, source, "mutation-must-change-caller");
    assert.throws(() => callerInvariants(mutation));
  }
});

test("manual caller contexts reject malformed/stale inputs and non-default branches, not skip them", (t) => {
  const f = fixture(t);
  const context = {
    ...f.context,
    event: "workflow_dispatch",
    workflowRef: "fmckie/gg-framework/.github/workflows/upstream-sync.yml@refs/heads/main",
  };
  assert.equal(candidateMode(f.inputs, context), "candidate");
  for (const [inputs, change, reason] of [
    [{ ...f.inputs, base_sha: "main" }, {}, /invalid-candidate-input/],
    [{ ...f.inputs, base_sha: "f".repeat(40) }, {}, /base-caller-mismatch/],
    [f.inputs, { ref: "refs/heads/feature" }, /non-default-caller/],
  ])
    assert.throws(() => candidateMode(inputs, { ...context, ...change }), reason);
  assert.throws(
    () =>
      reconstructLocal({
        ...f.options,
        context,
        inputs: { ...f.inputs, candidate_sha: "f".repeat(40) },
      }),
    /expected-candidate-mismatch/,
  );
  assert.equal(existsSync(f.options.destination), false);
});

const json = (value) => JSON.stringify(value, null, 2) + "\n";
function fixture(t) {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "kleio-ci-test-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = {
    ...isolatedEnvironment(join(home, "home")),
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@localhost",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@localhost",
    GIT_AUTHOR_DATE: "@1767225600 +0000",
    GIT_COMMITTER_DATE: "@1767225600 +0000",
  };
  const repo = join(home, "source.git");
  function git(args, directory = repo, overrides = {}) {
    const result = spawnSync(
      "git",
      ["-c", "core.hooksPath=" + join(home, "no-hooks"), "--git-dir=" + directory, ...args],
      {
        env: { ...env, ...overrides },
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git(["init", "--bare", "--template=", repo]);
  function commit(files, parents = [], message = "fixture\n", overrides = {}) {
    const indexEnv = { GIT_INDEX_FILE: join(home, "index") };
    git(["read-tree", "--empty"], repo, indexEnv);
    for (const [path, content] of files) {
      const file = join(home, "blob");
      writeFileSync(file, content);
      const oid = git(["hash-object", "-w", file]);
      git(["update-index", "--add", "--cacheinfo", `100644,${oid},${path}`], repo, indexEnv);
    }
    const tree = git(["write-tree"], repo, indexEnv);
    return git(
      ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", message],
      repo,
      overrides,
    );
  }
  const files = new Map(POLICY.requiredFiles.map((path) => [path, "preserved\n"]));
  for (const directory of POLICY.retainedProjects) files.set(directory + "/retained.txt", "keep\n");
  files.set("package.json", json({ name: "fixture", scripts: { test: "node --test" } }));
  for (const [path, name] of Object.entries(POLICY.canonicalPackages))
    files.set(
      path,
      json({
        name,
        version: "5.66.2-kleio.1",
        exports: { ".": "./dist/index.js" },
        repository: { directory: dirname(path) },
      }),
    );
  const provenance = {
    downstream: { scope: "@kleio", currentFixedVersion: "5.66.2-kleio.1" },
    upstream: { lastImportedCommit: "0".repeat(40) },
    localIntegration: { preservedProjects: POLICY.retainedProjects },
    packages: Object.fromEntries(
      Object.values(POLICY.canonicalPackages).map((name) => ["legacy/" + name, name]),
    ),
  };
  files.set("fork-provenance.json", json(provenance));
  files.set("ordinary.txt", "baseline\n");
  const imported = commit(files);
  const upstreamFiles = new Map(files).set("upstream.txt", "upstream addition\n");
  const upstream = commit(upstreamFiles, [imported]);
  const baseFiles = new Map(files).set(
    "fork-provenance.json",
    json({ ...provenance, upstream: { lastImportedCommit: imported } }),
  );
  const base = commit(baseFiles, [imported]);
  git(["update-ref", "refs/heads/main", base]);
  git(["update-ref", "refs/heads/upstream", upstream]);
  git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  const upstreamRepo = join(home, "upstream.git");
  const clone = spawnSync("git", ["clone", "--bare", "--no-hardlinks", repo, upstreamRepo], {
    env,
    encoding: "utf8",
  });
  assert.equal(clone.status, 0, clone.stderr);
  git(["symbolic-ref", "HEAD", "refs/heads/upstream"], upstreamRepo);
  const prepared = prepareCandidate({ repo, base, upstream, imported });
  assert.equal(prepared.status, "candidate-ready", json(prepared));
  const inputs = {
    base_sha: base,
    upstream_sha: upstream,
    imported_sha: imported,
    candidate_sha: prepared.candidate,
  };
  const context = {
    repository: "fmckie/gg-framework",
    ref: "refs/heads/main",
    sha: base,
    event: "push",
    workflowRef: "fmckie/gg-framework/.github/workflows/caller.yml@refs/heads/main",
    workflowSha: base,
  };
  const options = { repo, upstreamRepo, inputs, context, destination: join(home, "subject") };
  return {
    home,
    repo,
    upstreamRepo,
    env,
    git,
    commit,
    files,
    baseFiles,
    upstreamFiles,
    inputs,
    context,
    options,
    prepared,
  };
}

test("trusted shell checks HEAD, propagates pipeline failure and scrubs candidate tokens", (t) => {
  const f = fixture(t);
  const result = reconstructLocal(f.options);
  const script = join(f.home, "step.sh");
  const checker = fileURLToPath(new URL("./verify-ci-candidate.mjs", import.meta.url));
  const env = {
    ...f.env,
    KLEIO_CI_ROOT: result.directory,
    KLEIO_CI_SHA: result.sha,
    KLEIO_CI_MODE: "candidate",
    GITHUB_TOKEN: "credential-sentinel",
    NPM_TOKEN: "credential-sentinel",
    ACTIONS_RUNTIME_TOKEN: "credential-sentinel",
    GITHUB_ENV: "command-file-sentinel",
    NODE_PATH: "workspace-sentinel",
  };
  writeFileSync(script, "node -e 'console.log(JSON.stringify(process.env))'\n");
  const invoke = (overrides = {}) =>
    spawnSync(process.execPath, [checker, "shell", "bash", script], {
      cwd: result.directory,
      env: { ...env, ...overrides },
      encoding: "utf8",
      timeout: 30_000,
    });
  const positive = invoke();
  assert.equal(positive.status, 0, positive.stderr);
  assert.doesNotMatch(
    positive.stdout,
    /credential-sentinel|command-file-sentinel|workspace-sentinel/,
  );
  const child = JSON.parse(positive.stdout);
  assert.notEqual(child.HOME, env.HOME);
  assert.equal(child.GITHUB_WORKSPACE, result.directory);
  const wrong = invoke({ KLEIO_CI_SHA: "f".repeat(40) });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /execution-head-mismatch/);
  assert.equal(wrong.stdout, "");
  const outside = spawnSync(process.execPath, [checker, "shell", "bash", script], {
    cwd: f.home,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.notEqual(outside.status, 0);
  assert.match(outside.stderr, /execution-directory-mismatch/);
  assert.equal(outside.stdout, "");
  writeFileSync(script, "false | cat\nprintf 'must-not-run'\n");
  const failed = invoke();
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /ci-child-failed/);
  assert.doesNotMatch(failed.stdout, /must-not-run/);

  // Real consumer CLI: valid local packages but missing their built export targets.
  // Only the disposable fixture changes; the trusted harness and shell run unchanged.
  writeFileSync(join(result.directory, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
  writeFileSync(
    script,
    'node "$KLEIO_CONTROL_ROOT/scripts/consumer-contract.mjs" --sha "$KLEIO_CI_SHA" --root .\nprintf must-not-run > consumer-success-marker\n',
  );
  const consumerFailure = invoke();
  assert.equal(consumerFailure.error, undefined);
  assert.equal(consumerFailure.status, 1, consumerFailure.stderr);
  assert.equal(existsSync(join(result.directory, "consumer-success-marker")), false);
  const reports = consumerFailure.stderr
    .trim()
    .split(/\r?\n(?=\{)/)
    .map(JSON.parse);
  assert.equal(reports.length, 2);
  assert.equal(reports[0].candidateSha, f.inputs.candidate_sha);
  assert.equal(reports[0].status, "failed");
  assert.equal(reports[0].outcomes.at(-1).reason, "missing-packed-target: dist/index.js");
  assert.deepEqual(reports[0].stages, {
    pack: "passed",
    population: "not-run",
    install: "failed",
    runtime: "not-run",
    declarations: "not-run",
    identity: "not-run",
  });
  assert.deepEqual(reports[1], { status: "rejected", reason: "ci-child-failed" });
});

test("independent local reconstruction checks exact tree, ordered parents and materialized HEAD", (t) => {
  const f = fixture(t);
  const result = reconstructLocal(f.options);
  assert.equal(result.sha, f.prepared.candidate);
  assert.equal(result.tree, f.prepared.tree);
  assert.deepEqual(result.parents, [f.inputs.base_sha, f.inputs.upstream_sha]);
  assert.equal(readFileSync(join(result.directory, "upstream.txt"), "utf8"), "upstream addition\n");
  assert.equal(
    f.git(["rev-parse", "HEAD"], join(result.directory, ".git")),
    f.inputs.candidate_sha,
  );
  assert.equal(f.git(["rev-parse", "refs/heads/main"]), f.inputs.base_sha, "source ref unchanged");
  const second = reconstructLocal({ ...f.options, destination: join(f.home, "other") });
  assert.equal(second.sha, result.sha);
});

test("input presence, not SHA truthiness or the caller event, selects candidate mode", (t) => {
  const f = fixture(t);
  assert.equal(candidateMode({}, {}), "ordinary");
  assert.equal(candidateMode(f.inputs, f.context), "candidate");
  for (const inputs of [
    { base_sha: "" },
    { ...f.inputs, candidate_sha: "" },
    { ...f.inputs, base_sha: "main" },
    { ...f.inputs, url: "https://example.invalid" },
  ])
    assert.throws(
      () => candidateMode(inputs, f.context),
      /invalid-(?:candidate-input|verification-options)/,
    );
  for (const key of Object.keys(f.inputs)) {
    const inputs = { ...f.inputs };
    delete inputs[key];
    assert.throws(() => candidateMode(inputs, f.context), /invalid-verification-options/);
  }
});

test("non-default, privileged, wrong-repository and unpinned caller contexts fail before transport", (t) => {
  const f = fixture(t);
  for (const [change, reason] of [
    [{ ref: "refs/heads/feature" }, /non-default-caller/],
    [{ event: "pull_request_target" }, /privileged-or-untrusted-caller-event/],
    [{ event: "workflow_run" }, /privileged-or-untrusted-caller-event/],
    [{ event: "pull_request" }, /privileged-or-untrusted-caller-event/],
    [{ repository: "other/project" }, /untrusted-caller-repository/],
    [{ sha: "f".repeat(40) }, /base-caller-mismatch/],
    [{ workflowSha: "f".repeat(40) }, /unpinned-caller-workflow/],
    [
      { workflowRef: f.context.workflowRef.replace("/main", "/feature") },
      /non-default-caller-workflow/,
    ],
  ])
    assert.throws(
      () =>
        reconstructPublic({
          inputs: f.inputs,
          context: { ...f.context, ...change },
          destination: f.options.destination,
        }),
      reason,
    );
  assert.throws(
    () =>
      reconstructPublic({
        inputs: f.inputs,
        context: f.context,
        destination: f.options.destination,
        url: "file:///tmp/fixture",
      }),
    /invalid-verification-options/,
  );
  assert.throws(
    () => reconstructLocal({ ...f.options, policy: {} }),
    /invalid-verification-options/,
  );
  assert.equal(existsSync(f.options.destination), false);
});

test("wrong SHA and equal-tree commits with different metadata/parents fail before materialization", (t) => {
  const f = fixture(t);
  const mergedFiles = new Map(f.baseFiles).set("upstream.txt", "upstream addition\n");
  const changed = [
    "f".repeat(40),
    f.commit(mergedFiles, [f.inputs.upstream_sha, f.inputs.base_sha]),
    f.commit(mergedFiles, [f.inputs.base_sha]),
    f.commit(mergedFiles, [f.inputs.base_sha, f.inputs.upstream_sha], "different message"),
    f.commit(
      mergedFiles,
      [f.inputs.base_sha, f.inputs.upstream_sha],
      "Local-only upstream candidate; structural checks only",
      { GIT_COMMITTER_DATE: "@1767225601 +0000" },
    ),
  ];
  for (const sha of changed) {
    if (sha !== changed[0]) assert.equal(f.git(["rev-parse", sha + "^{tree}"]), f.prepared.tree);
    assert.throws(
      () => reconstructLocal({ ...f.options, inputs: { ...f.inputs, candidate_sha: sha } }),
      /expected-candidate-mismatch/,
    );
    assert.equal(existsSync(f.options.destination), false);
  }
});

test("advancing source refs retains pinned inputs; rewritten upstream membership rejects", (t) => {
  const f = fixture(t);
  const later = f.commit(new Map(f.upstreamFiles).set("later.txt", "not a build input\n"), [
    f.inputs.upstream_sha,
  ]);
  f.git(["update-ref", "refs/heads/upstream", later]);
  // Copy public fixture objects through a local-only fetch into the independent membership repository.
  f.git(["fetch", "--no-tags", f.repo, later], f.upstreamRepo);
  f.git(["update-ref", "refs/heads/upstream", later], f.upstreamRepo);
  f.git(["update-ref", "refs/heads/main", later]);
  const result = reconstructLocal(f.options);
  assert.equal(result.sha, f.inputs.candidate_sha);
  assert.equal(existsSync(join(result.directory, "later.txt")), false);
  f.git(["update-ref", "refs/heads/upstream", f.inputs.imported_sha], f.upstreamRepo);
  assert.throws(
    () => reconstructLocal({ ...f.options, destination: join(f.home, "rewritten") }),
    /rewritten-upstream-membership/,
  );
  assert.equal(existsSync(join(f.home, "rewritten")), false);
});

test("missing objects, no-op, conflict and changed verification policy reject without fallback", async (t) => {
  const f = fixture(t);
  // A rejected git call names the subcommand and carries git's own reason, so a
  // CI log never again reads just "rev-parse" with nothing to act on.
  assert.throws(
    () => reconstructLocal({ ...f.options, inputs: { ...f.inputs, upstream_sha: "f".repeat(40) } }),
    (error) =>
      /^verification-git-failed: cat-file\n/.test(error.message) &&
      /\nfatal: .*(object|cat-file)/.test(error.message) &&
      error.message.length < 1200,
  );
  assert.throws(
    () =>
      reconstructLocal({
        ...f.options,
        inputs: { ...f.inputs, upstream_sha: f.inputs.imported_sha },
      }),
    /preparation-rejected/,
  );
  for (const [label, files, base, reason] of [
    [
      "policy",
      new Map(f.upstreamFiles).set("scripts/upstream-sync-policy.json", "{}\n"),
      f.inputs.base_sha,
      /protected-change/,
    ],
    [
      "conflict",
      new Map(f.upstreamFiles).set("ordinary.txt", "upstream conflict\n"),
      f.commit(new Map(f.baseFiles).set("ordinary.txt", "fork conflict\n"), [f.inputs.base_sha]),
      /merge-conflict/,
    ],
  ])
    await t.test(label, () => {
      const upstream = f.commit(files, [f.inputs.imported_sha]);
      f.git(["fetch", "--no-tags", f.repo, upstream], f.upstreamRepo);
      f.git(["update-ref", "refs/heads/upstream", upstream], f.upstreamRepo);
      const inputs = { ...f.inputs, base_sha: base, upstream_sha: upstream };
      const context = { ...f.context, sha: base, workflowSha: base };
      assert.throws(() => reconstructLocal({ ...f.options, inputs, context }), reason);
      assert.equal(existsSync(f.options.destination), false);
    });
});

test("verifier git calls carry safe.directory so a dropped global config cannot reject the pinned checkout", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "verify-ci-candidate.mjs"),
    "utf8",
  );
  // Hosted Windows runners own the workspace as BUILTIN\\Administrators; the only
  // safe.directory entry lives in the global config that isolatedEnvironment drops.
  assert.match(source, /"safe\.directory=\*",?\n\];/);
  // Per-invocation only: the verifier never writes git config anywhere.
  assert.doesNotMatch(source, /["']config["'],\s*["']--(global|system)["']/);
});
