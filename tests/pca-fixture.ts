/** Four independent cross-channel signals with distinct known variances. */
export function pcaRecording(spikes = 64) {
  const raw = new Uint8Array(spikes * 216);
  const view = new DataView(raw.buffer);
  for (let i = 0; i < spikes; i++) {
    for (let ch = 0; ch < 4; ch++) {
      view.setUint32(i * 216 + ch * 54, (i + 1) * 1000);
      raw.fill(8 + ch, i * 216 + ch * 54 + 4, i * 216 + ch * 54 + 54);
      [30, 15, 8, 3].forEach((coefficient, pc) => {
        const sign = (i >> pc) & 1 ? 1 : -1;
        raw[i * 216 + ch * 54 + 4 + pc * 11 + 7] = 8 + ch + sign * (ch < 2 ? 1 : -1) * coefficient;
      });
    }
  }
  const header = `num_spikes ${spikes}\nnum_chans 4\nsamples_per_spike 50\ntimebase 96000 hz\nduration 10\nspike_format t,ch1,t,ch2,t,ch3,t,ch4\r\ndata_start`;
  const labels = Array.from({ length: spikes }, (_, i) => (i % 2) + 1);
  return { raw, header, labels, spikes };
}
