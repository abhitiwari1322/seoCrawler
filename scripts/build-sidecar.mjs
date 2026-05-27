import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { platform, arch } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

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

const pkgArgs = ["sidecar/main.mjs", "--targets", "node20", "--output", join(outDir, "crawler-engine")];

execFileSync(process.execPath, [resolvePkgCli(), ...pkgArgs], {
  stdio: "inherit"
});

const extension = platform() === "win32" ? ".exe" : "";
renameSync(join(outDir, `crawler-engine${extension}`), join(outDir, `crawler-engine-${target}${extension}`));

function resolvePkgCli() {
  try {
    const pkgJsonPath = require.resolve("@yao-pkg/pkg/package.json");
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    const bin = typeof pkgJson.bin === "string" ? pkgJson.bin : pkgJson.bin?.pkg;
    if (!bin) throw new Error("No pkg binary is declared in @yao-pkg/pkg/package.json");
    return join(dirname(pkgJsonPath), bin);
  } catch {
    throw new Error("Unable to resolve @yao-pkg/pkg. Run npm ci before building the sidecar.");
  }
}
