# Waveform

[![Waveform video introduction](img/demo_youtube.png)](https://www.youtube.com/watch?v=36o69CPu-1E)

Waveform is a browser-based GUI for working with extra-neuronal tetrode waveform data. Drop in a folder of LTX files (`.set`, `.pos`, tetrode and cut files) to see every cell's waveforms, feature-space projections, rate maps, tuning and temporal/spatial autocorrelograms, then merge, split, paint and relabel cells and export the cut.

**[Open Waveform](https://chenneuroscience.github.io/waveform/)**, or try it with the simulated data on its start screen.

> [!WARNING]
> This version (October 2026) was rebuilt with AI under human oversight. It likely still has bugs and feature gaps that are being ironed out. The previous version is on the [waveform-v1 branch](https://github.com/ChenNeuroscience/waveform/tree/waveform-v1).

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

GitHub Actions runs these checks on every push and pull request, and deploys `main` to GitHub Pages.

MIT licence.
