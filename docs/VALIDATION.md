# Verification record

Local verification on 26 October 2026, macOS arm64, Node 24.14.0, stable Rust, Chromium 156 through Playwright. Browser rendering used software WebGL2 (SwiftShader) for reproducibility. Hardware/browser/OS differences affect timings.

## Passing checks

| Check                                           | Result                                                                                                                                                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Production Rust/Wasm + TypeScript + Vite build  | Passed; Wasm module about 123 KB, main app JS about 308 KB before gzip                                                                                                                                                         |
| Rust tests                                      | 14 passed: decoding, cut streaming, exact edits/patches, inserted-cell split, density invalidation, position/analysis and 9-million-label integrity                                                                            |
| TypeScript unit tests                           | 12 passed: grouping, cut/CLu validation, binary boundary, patches, occupancy/AC and 96 kHz position clock/window/bearing regression, plot-bin geometry, original palette/contrast, clock formatting and viewport-safe geometry |
| Chromium browser tests                          | 35 passed, including two optional private-data tests                                                                                                                                                                           |
| Dependency audit after updating the test runner | Zero reported vulnerabilities                                                                                                                                                                                                  |
| Git diff whitespace check                       | Passed                                                                                                                                                                                                                         |

Browser scenarios:

1. Import the supplied private sample directory, organise three trials with 16 tetrodes each, switch among recordings, create a lasso cut, and undo it. The supplied data contains no cut files. No sample bytes are checked into the repository or sent to a server.
2. Import a generated **9,000,000-spike** tetrode and **100 cells plus noise**, drag-snap merge, undo, export, reparse the export, and compare a hash of **every label** with the original synthetic assignment vector.
3. Synthetic demo: merge, waveform split, undo/redo, switch away and back, tile wall, floating settings, direction view, Space comparison, alternative cut versions and cut export.
4. Serve the production build from an actual `/waveform/` static mount and load the demo, worker and Wasm module successfully.
5. Verify the 390-pixel mobile welcome screen fits the viewport.
6. Verify 350 px default / 240 px minimum, nested cut/CLu files, simultaneous movable/resizable header/settings windows, and nonblank density rendering.
7. Drag-merge and right-drag split a deterministic waveform fixture; adjust the preview from the spawned tile on a different sample/channel, then export and compare every label after commit, undo, redo and cancel. Preview must leave history unchanged.
8. Hover to show spikes, Space-copy a tile and retain it unchanged while navigating.
9. Resize panes/window and check square feature viewports and fixed waveform grids in density/flag modes.
10. Toggle plots and verify intrinsic tile widths, wrapping, shared density/flag canvas, absent tile checkboxes and larger numeric overlays only on hover.
11. Verify the drag placeholder, exact cross-column snap alignment, 1.5-second alpha cycle, simultaneous source/target position spikes, hidden stats, snap-only merge, unsnapped/Escape cancellation, and settling animation. Verify restoration after the source scrolls out of the virtual wall.
12. Space-click closes copies and tool windows without activating the plot or control underneath. Comparison content drags its window and has no resize handle; tool windows remain resizable. Copied tiles have no embedded title strip, a single window title, and a separate frozen hover-only stats overlay.
13. Import two folders with identical trial/tetrode/cut basenames and timestamps. Verify separate assignments, undo histories, and separate edited cuts without creating a spurious trial.

14. Verify collapsed/expanded inline cuts, automatic blue cut creation, independent imported/edited undo and redo, and inactive-cut drag payloads and label contents without changing the active recording.
15. Compare every pixel in the waveform region before/after hover; verify transparent wave hit targets, original bottom-right stats, badge positions and speed clearance, the absence of per-tile sampling warnings, and a page-layer halo above both the toolbar and snapped fade. Verify frozen copies retain the same badge behaviour.
16. Switch flag → density → flag three times, require the exact original flag pixels each time, and check for non-flat waveforms and no WebGL errors.
17. Check the centred feature grid has no footer, numeric split form or feature-pane checkboxes; recording details fit in the toolbar. Verify A1–A4 corner labels are baked into Space-copy PNGs, square feature viewports after resizing, and settings/divider/tool-window restoration on a smaller screen.
18. Check the original drop-title animation has 11 keyframes and an 800 ms cycle, stops on drag leave, and ignores internal cut drags.
19. Verify Ctrl/Cmd/Alt+R/W cannot toggle plot visibility before the unsaved-work warning; plain R still toggles rate maps. Verify the position canvas uses the entire pane.
20. Click trial rows and set/pos chips, keep the current tetrode, restore its last cut/history, and verify the always-visible recorded clock time/duration and left-aligned speed bars with a red vertical line and no horizontal axis. Auxiliary file counts and tooltip details stay beside set/pos markers without a skipped-file toast.

21. Click the simulated-files card to create five trials and eight tetrodes per trial. Verify the default 50k-spike/20-minute demo and 24–48 cells. Generate the stress preset without external fixtures, verify 9M spikes and 100 cells, merge/undo and compare a hash of the entire canonical cut export. Ordinary interaction tests use the same native generator with `?demo=quick`.

22. Browser Back/Forward restores trial/tetrode/cut selections and existing cut undo history. Duplicate choices, edits and display/window settings add no entries; navigation cancels a pending split preview.

23. Verify default paint, absence of select mode, the lasso icon, wrapped group chips, complete plot borders and 4 px gaps. Paint/lasso a known point cloud on the second projection and compare every exported label; clicking a gap must not edit. Space copies retain plot borders.

## Timings observed

| Workload                                    | Observed time | What is included                                                                                                                                                      |
| ------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9M synthetic records, Wasm benchmark        | 1.31 s        | Chunk generation/timestamp writes, copying chunks into Wasm, signed-wave amplitude extraction and timestamp decoding                                                  |
| Merge about 89K members of one of 100 cells | 7.94 ms       | Rust relabel + population recount; excludes patch persistence and UI                                                                                                  |
| Wasm memory after 9M decode                 | 93.81 MiB     | Includes full population arrays, allocator overhead and scratch allocation high-water mark; excludes JS/GPU/browser memory                                            |
| Generated 9M stress demo, browser ready     | 4.83 s        | Cut/position generation, chunk-by-chunk native record synthesis and full decoding, reservoir preparation and initial UI; excludes real disk I/O                       |
| 9M fixture, browser first load              | 3.3–5.8 s     | File picker automation, cut parsing, chunked file reads, Rust decoding, reservoir creation, population summary, bounded view transfer and initial React/GPU rendering |
| Real sample tetrode, 704,080 spikes         | 125 ms        | Node/Wasm chunked decoder benchmark, including local file reads                                                                                                       |

These timings do not establish a universal frame-rate or memory ceiling. The browser first-load measurement ends when the workspace reports that the recording is ready; selected-cell analysis can finish afterwards. Warm operating-system file caches may improve local IO timings. The two large fixtures are optional in CI so contributors do not need to download private data or generate 2 GB for routine checks.

## Reproduce

```sh
npm ci
rustup target add wasm32-unknown-unknown
npm run test:rust
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npm run bench

node scripts/make-stress.mjs /tmp/waveform-stress
WAVEFORM_SAMPLE_DIR=/absolute/path/to/sample_data \
WAVEFORM_STRESS_DIR=/tmp/waveform-stress npm run test:e2e
```

Screenshots and browser traces are written under ignored `test-results/`. Only the synthetic demo should be used for shared screenshots.

## Remaining verification boundaries

The local browser checks use Chromium. Native Windows Explorer/macOS Finder drop acceptance has not been exercised here; browser tests verify the prepared File/DownloadURL payload and reparse its exact assignments. Safari and Firefox have not been exercised here. Position processing and scientific metrics have sanity tests and were exercised with the supplied unlabelled recordings; numerical equivalence to the original algorithms has not been established with a curated labelled reference set. Full-population waveform-density images and exhaustive large autocorrelation pairs are outside this implementation's display model. Those differences are documented in [FEATURES.md](FEATURES.md).

The GitHub workflow builds and tests pull requests, then deploys pushes to upstream `main`. The real `/waveform/` static-mount check verifies the Pages asset paths locally; the deployment run is checked separately when this PR is merged.

The group-selection follow-up adds exact-label browser checks for the original destination/source set notation, right-click and Shift-right-click source toggles, hover E/F/Shift-F shortcuts, unused destinations and multi-source transfers. Coincident-point checks verify that tile focus changes the frontmost group colour without any feature-buffer uploads. Swaps verify hover-only entry, a centred prompt with a focused input, persistent source glow, number validation, both empty-neighbour choices, two occupied groups, cancellation, navigation cleanup and undo/redo. Completed merges and swaps reuse the 650 ms settling jiggle on their updated result tiles. Existing edit/history tests use painting or tile gestures through the restored UI.

Selector polish verifies short source sets hug their braces, long sets wrap between spanning braces, and the tools remain on the first line. Edit history omits storage-location text, export/duplicate buttons and completion checkmarks. Cut exports continue through Ctrl/Cmd-S and organiser drag data.
