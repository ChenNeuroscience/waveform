import { it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { EXPORTS } from "../src/worker/wasm";

it("the typed export table matches the compiled Wasm module", async () => {
  const module = await WebAssembly.compile(
      await readFile(new URL("../public/wasm/waveform_core.wasm", import.meta.url)),
    ),
    instance = await WebAssembly.instantiate(module, {}),
    actual = Object.fromEntries(
      WebAssembly.Module.exports(module)
        .filter((e) => e.kind === "function")
        .map((e) => [e.name, (instance.exports[e.name] as (...args: number[]) => number).length]),
    );
  expect(actual).toEqual(EXPORTS);
});
