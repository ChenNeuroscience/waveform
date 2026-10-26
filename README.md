# Waveform 2

## WARNING: v2 is not quite ready for use - see [Waveform v1](https://github.com/ChenNeuroscience/waveform/tree/waveform-v1).

A local-first workspace for LTX neural recordings, rebuilt with **Rust / WebAssembly, React, TypeScript and WebGL2**. Import recording files, move quickly between trials and tetrodes, inspect cells, and edit/export cuts with a separate undo/redo history for each cut.

The replacement starts from the original `gh-pages` implementation at `bf0f51bd75cd44a6edecfa09e10e5ae68c5961c8`. Abandoned rewrite branches were not used. The original application and source are preserved on the [waveform-v1 branch](https://github.com/ChenNeuroscience/waveform/tree/waveform-v1).

## Features

- Drop files or folders, or use the file/folder picker. Group `.set`, `.pos`, numeric tetrode files, `.cut` and `.clu.N` by trial and tetrode. Add files incrementally and select alternative cuts.
- Six GPU amplitude projections, cell isolation, time colouring, additive point density, point size and a configurable display budget.
- Compact light desktop layout: files, position and feature projections on the left, a scrolling cell tile wall on the right. Tiles size to visible plots and wrap into columns; numeric details appear on hover. The feature grid centres within its pane, with rendering controls in Settings; recording details sit at the top right of the toolbar. There is no footer or numeric waveform-split form. The left pane starts at 350 px and can shrink to 240 px.
- Four-channel waveforms with cached density images or flag traces, rate maps, direction/speed tuning and autocorrelation in every tile. Hover to see spikes on the position path.
- Drag a cell tile onto another to compare aligned plots with an alternating fade and both spike sets on the position path; release while snapped to merge. An unsnapped drop cancels and returns the tile with a settling jiggle. Stats stay hidden during dragging; right-drag over a waveform to enter split mode, adjust from either tile, then left-click anywhere to finish (Escape cancels). Hold Space and click a tile, position path or feature plot to make a floating comparison copy, or click any floating window to close it. Copies have fixed sizes and drag from anywhere inside the window. Copied tiles keep frozen stats as a hover overlay and show their title once in the header. Settings and file headers also use movable, resizable windows. Data bins keep their proportions when panes resize.
- Exact population edits: lasso, paint, waveform-sample threshold, merge, swap and renumber by count. Cell 0 remains noise when renumbering. Every edit supports undo/redo; original disk files are never overwritten.
- Cut files sit inline beside each tetrode, visible even when collapsed; auxiliary file counts and names sit beside the set/pos markers. Editing an original creates a blue local cut with its own undo/redo history; switch among cuts or duplicate them. Drag a prepared cut out of the organiser, or export `.cut` / legacy 1-based `.clu.N` assignments from Edit history or Ctrl/Cmd+S.
- Spatial firing-rate maps, trajectory/spike overlays, head-direction tuning, speed tuning, temporal autocorrelograms, spike counts and spatial/directional peak rates on hover. The position pane shows recorded start/end clock times, duration and a left-aligned speed occupancy plot over a faint white backing.
- Position processing with one/two LEDs, continuity-based swap correction, jump rejection, interpolation and boxcar smoothing. Inspect searchable file headers and use keyboard shortcuts.
- Settings, plot visibility, dividers and tool-window geometry persist in localStorage; restored panes/windows fit the current screen. Feature plots use square bins and compact A1–A4 axis labels, retained in Space copies. The original cell palette, favicon, hover glow and drop-title animation are preserved.
- Runs as a static browser app. Recordings are not uploaded; there is no analytics, server or remote font dependency.

See the complete [original feature inventory and migration notes](docs/FEATURES.md), [architecture and memory model](docs/ARCHITECTURE.md), and [verification results](docs/VALIDATION.md).

## Run locally

Install Node 24, npm and stable Rust, then:

```sh
rustup target add wasm32-unknown-unknown
npm ci
npm run build:wasm
npm run dev
```

Open the URL printed by Vite. Use **Explore a synthetic demo** without supplying recordings, or drop LTX files into the workspace. For a production build:

```sh
npm run build
npm run preview
```

The Rust core has no dependencies and uses a small explicit Wasm ABI, so neither `wasm-pack` nor `wasm-bindgen` is needed.

## Scale and accuracy

The target workload is approximately **9 million spikes and 100 cells per tetrode**. Tetrodes are read in 32,768-spike chunks (about 6.75 MiB). Retained population features require **10 bytes per spike**: 32-bit timestamp, four 8-bit amplitudes, and a 16-bit cell label. The original 1.94 GB of waveform records is not retained or expanded into float vertices.

Counts, assignments, lasso/paint/gate edits and cut exports use the **full spike population**. GPU feature views use an evenly spaced sample; waveform views use a stratified reservoir. Hovering sampled plots shows **WARNING: using sampled rendering**; full-population waveform rendering is deferred. Newly split cells have their waveform sample replenished from small file slices. Large/bursty autocorrelograms use bounded reference/pair sampling and are labelled accordingly. Cuts operate across the complete recording.

A local Chromium test loaded a synthetic 9-million-spike recording with 100 cells in about **3.3–5.8 seconds**, then merged, undid and exported it. The Wasm-only decoder benchmark processed the same population in about **1.31 seconds**, with about **94 MiB** of Wasm memory. These are measurements on one development machine, not cross-device performance guarantees. See `docs/VALIDATION.md` for commands and scope.

Undo patches are saved to IndexedDB, with no fixed action limit. History metadata and open-file references live for the current workspace tab. Switching trials, tetrodes or cuts preserves history; refreshing/closing the tab does not restore the workspace. Export modified cuts before closing. Browser storage quota can limit history: an edit is rolled back if its undo patch cannot be stored.

## GitHub Pages

[`.github/workflows/pages.yml`](.github/workflows/pages.yml) installs Node/Rust, runs Rust/unit/browser checks, builds Wasm + React, uploads `dist/`, and deploys after a push to the upstream `main` branch. Pull requests and forks build without deploying to the upstream site.

A repository administrator must select **Settings → Pages → Build and deployment → Source: GitHub Actions** once. The deployment then serves `https://ChenNeuroscience.github.io/waveform/`. Relative assets and an absolute worker-initialisation URL support the `/waveform/` subpath. No COOP/COEP headers or SharedArrayBuffer are required.

GitHub documents the [custom Pages workflow and required deployment permissions](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages); Vite documents [static deployment](https://vite.dev/guide/static-deploy.html).

## Verify

```sh
npm run test:rust
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npm run bench
```

Private recordings are optional local tests and are never committed:

```sh
WAVEFORM_SAMPLE_DIR=/absolute/path/to/sample_data npm run test:e2e
node scripts/make-stress.mjs /tmp/waveform-stress
WAVEFORM_STRESS_DIR=/tmp/waveform-stress npm run test:e2e
```

The stress fixture occupies about 2 GB. Its browser test verifies all 9 million exported labels against the original synthetic assignments after undo. A real tetrode can also be benchmarked without loading its waveform bytes at once:

```sh
node scripts/benchmark.mjs /absolute/path/to/trial.1
```

## Format support

LTX tetrodes: four channels, 50 signed 8-bit waveform samples per channel, repeated big-endian 32-bit timestamps, 216 bytes per spike. Position records: `t,x1,y1,x2,y2,numpix1,numpix2`, 20 bytes per record. Internal cell labels support 0–1023. Unsupported formats and mismatched/truncated cut data produce an error rather than a partial result. EEG/EGF/TTL and auxiliary feature/log files are skipped.

The MIT licence and original project attribution are retained.
