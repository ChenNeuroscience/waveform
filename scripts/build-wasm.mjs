import { spawnSync } from "node:child_process";
import { mkdir, copyFile } from "node:fs/promises";
const r = spawnSync(
  "cargo",
  [
    "build",
    "--manifest-path",
    "core/Cargo.toml",
    "--release",
    "--target",
    "wasm32-unknown-unknown",
  ],
  {
    stdio: "inherit",
    // Wasm SIMD lets LLVM vectorise per-record loops (amplitudes, record copies).
    env: { ...process.env, RUSTFLAGS: "-C target-feature=+simd128" },
  },
);
if (r.status !== 0) process.exit(r.status ?? 1);
await mkdir("public/wasm", { recursive: true });
await copyFile(
  "core/target/wasm32-unknown-unknown/release/waveform_core.wasm",
  "public/wasm/waveform_core.wasm",
);
await mkdir("src/generated", { recursive: true });
await copyFile(
  "core/target/wasm32-unknown-unknown/release/waveform_core.wasm",
  "src/generated/waveform_core.wasm",
);
