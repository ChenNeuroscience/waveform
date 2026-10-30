<img src="img/icon.svg" width="96" height="96" alt="Waveform over blue, green and red tiles">

# Waveform

Waveform is a browser-based workspace for exploring tetrode recordings and editing spike clusters. Drop in a folder of LTX files to inspect waveforms and firing patterns, refine clusters and export your cuts.

**[Open Waveform](https://chenneuroscience.github.io/waveform/)**, then try the simulated data on the start screen or drop in your own files.

[![Waveform video introduction](img/demo_youtube.png)](https://www.youtube.com/watch?v=36o69CPu-1E)

## Developing

The engine is Rust compiled to WebAssembly (`core/`), running in a Web Worker; the interface is React and TypeScript, built with Vite and drawn with WebGL2. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together.

With Node 24 and stable Rust:

```sh
rustup target add wasm32-unknown-unknown
npm ci
npm run build:wasm
npm run dev          # http://localhost:5173
```

Checks:

```sh
npm run lint
npm run test:rust
npm test             # unit tests (Vitest)
npm run build
npx playwright install chromium
npm run test:e2e     # browser tests (Playwright)
```

The default browser stress test uses 1M spikes. To opt into the 9M case, run `WAVEFORM_STRESS_9M=1 npm run test:e2e -- e2e/synthetic.spec.ts`; it is skipped in ordinary runs and CI.

GitHub Actions runs these checks on pull requests and pushes to `main`, skipping Markdown-only changes. GitHub Pages deployment is restricted to `main` on pushes and manual workflow runs.

MIT licence.
