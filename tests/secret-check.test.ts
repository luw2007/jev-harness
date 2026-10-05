import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const scanner = fileURLToPath(new URL("../scripts/check-secrets.mjs", import.meta.url));
// Construct synthetic pattern matches without checking in a key-shaped literal.
const candidate = "ghp_" + "A".repeat(36);
const scan = (cwd: string, ...args: string[]) => {
  const result = spawnSync(process.execPath, [scanner, ...args], { cwd, encoding: "utf8" });
  assert.ifError(result.error);
  const output = result.stdout + result.stderr;
  assert.equal(output.includes(candidate), false, "findings must never print matched values");
  return { status: result.status, output };
};

function withRepo(run: (dir: string, git: (...args: string[]) => void) => void) {
  const dir = mkdtempSync(join(tmpdir(), "jev-secret-check-"));
  const git = (...args: string[]) => { execFileSync("git", args, { cwd: dir, stdio: "pipe" }); };
  try { git("init", "--quiet"); run(dir, git); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test("secret checks retain exact Git paths with spaces, quotes, Unicode and newlines", () => {
  for (const path of ["with spaces.txt", 'with"quote.txt', "路径.txt", "with\nnewline.txt", "with\ttab.txt", "with\\slash.txt"]) {
    withRepo((dir, git) => {
      writeFileSync(join(dir, path), candidate);
      git("add", "--", path);
      for (const mode of ["--staged", "--all"]) {
        const result = scan(dir, mode);
        assert.equal(result.status, 1, `${mode} must scan ${JSON.stringify(path)}`);
        assert.ok(result.output.includes(JSON.stringify(path)), "findings escape control characters in paths");
      }
    });
  }
});

test("staged checks scan the index even when the worktree has a clean replacement", () => {
  withRepo((dir, git) => {
    writeFileSync(join(dir, "key.txt"), candidate);
    git("add", "--", "key.txt");
    writeFileSync(join(dir, "key.txt"), "<your-key>");
    assert.equal(scan(dir, "--staged").status, 1);
    assert.equal(scan(dir, "--all").status, 0);
  });
});

test("textual SVG content is scanned and fake-looking substrings cannot suppress findings", () => {
  withRepo((dir, git) => {
    const embeddedMarker = "ghp_" + "A".repeat(16) + "test" + "B".repeat(16);
    writeFileSync(join(dir, "image.svg"), `<svg><metadata>${embeddedMarker} ${candidate}</metadata></svg>`);
    git("add", "--", "image.svg");
    assert.equal(scan(dir, "--staged").status, 1);
    writeFileSync(join(dir, "single.txt"), embeddedMarker);
    assert.equal(scan(dir, "single.txt").status, 1);
  });
});

test("unreadable explicit or tracked inputs fail the check", () => {
  withRepo((dir, git) => {
    assert.equal(scan(dir, "missing.txt").status, 1);
    writeFileSync(join(dir, "removed.txt"), "placeholder");
    git("add", "--", "removed.txt");
    rmSync(join(dir, "removed.txt"));
    assert.equal(scan(dir, "--all").status, 1);
  });
});

test("unambiguous placeholders and the example env file pass", () => {
  withRepo((dir, git) => {
    writeFileSync(join(dir, ".env.example"), "TYPESAFE_API_KEY=<your-key>\nTYPESAFE_API_KEY=$ENV_VAR\nTYPESAFE_API_KEY=op://example/reference\nauthorization: bearer <your-key>\n");
    git("add", "--", ".env.example");
    assert.equal(scan(dir, "--staged").status, 0);
    writeFileSync(join(dir, ".env"), "TYPESAFE_API_KEY=<your-key>");
    git("add", "--", ".env");
    assert.equal(scan(dir, "--staged").status, 1);
  });
});
