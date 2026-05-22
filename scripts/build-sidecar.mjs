import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { platform, arch } from "node:os";

const triples = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "linux-x64": "x86_64-unknown-linux-gnu"
};

const target = triples[`${platform()}-${arch()}`];
if (!target) throw new Error(`Unsupported sidecar target: ${platform()}-${arch()}`);

const outDir = join("src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });

execFileSync("npx", ["--yes", "@yao-pkg/pkg", "sidecar/main.mjs", "--targets", "node20", "--output", join(outDir, "crawler-engine")], {
  stdio: "inherit"
});

const extension = platform() === "win32" ? ".exe" : "";
renameSync(join(outDir, `crawler-engine${extension}`), join(outDir, `crawler-engine-${target}${extension}`));
