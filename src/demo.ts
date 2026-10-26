// Reproducible synthetic recordings, never presented as biological measurements.
export function demoFiles(): File[] {
  let seed = 4271;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const out: File[] = [];
  const enc = new TextEncoder();
  for (let trial = 0; trial < 2; trial++) {
    const base = `demo_${trial ? "linear-track" : "open-field"}`,
      duration = 600,
      npos = 30000;
    out.push(
      new File(
        [
          `duration ${duration}\ntrial_date SYNTHETIC\nexperimenter Demo data\n`,
        ],
        `${base}.set`,
        { lastModified: 1 },
      ),
    );
    const ph = enc.encode(
        `duration ${duration}\nnum_pos_samples ${npos}\nsample_rate 50 hz\ntimebase 50 hz\npixels_per_metre 300\nwindow_min_x 0\nwindow_min_y 0\nwindow_max_x 300\nwindow_max_y 300\npos_format t,x1,y1,x2,y2,numpix1,numpix2\r\ndata_start`,
      ),
      pb = new Uint8Array(npos * 20),
      pd = new DataView(pb.buffer);
    for (let i = 0; i < npos; i++) {
      const p = i * 20,
        x = 150 + 132 * Math.sin(i * 0.003) + 12 * Math.sin(i * 0.021),
        y = trial
          ? 150 + 20 * Math.sin(i * 0.0006)
          : 150 + 132 * Math.sin(i * 0.00413);
      pd.setUint32(p, i);
      pd.setUint16(p + 4, Math.round(x));
      pd.setUint16(p + 6, Math.round(y));
      pd.setUint16(p + 8, Math.round(x + 5));
      pd.setUint16(p + 10, Math.round(y + 3));
      pd.setUint16(p + 12, 12);
      pd.setUint16(p + 14, 7);
    }
    out.push(
      new File([ph, pb, enc.encode("\r\ndata_end")], `${base}.pos`, {
        lastModified: 1,
      }),
    );
    for (let tet = 1; tet <= 3; tet++) {
      const n = trial ? 18000 : 36000,
        h = enc.encode(
          `duration ${duration}\nnum_spikes ${n}\nnum_chans 4\nsamples_per_spike 50\nbytes_per_sample 1\nbytes_per_timestamp 4\ntimebase 96000 hz\nspike_format t,ch1,t,ch2,t,ch3,t,ch4\r\ndata_start`,
        ),
        b = new Uint8Array(n * 216),
        d = new DataView(b.buffer);
      let cut = `n_clusters: 13\nn_channels: 4\nn_params: 2\ntimes_used_in_Vt: 0 0 0 0\nExact_cut_for: ${base} spikes: ${n}\n`;
      const centers = Array.from({ length: 13 }, () =>
        Array.from({ length: 4 }, () => 15 + random() * 80),
      );
      for (let i = 0; i < n; i++) {
        const cell = Math.floor(random() * 13);
        cut += `${cell} `;
        for (let ch = 0; ch < 4; ch++) {
          const p = i * 216 + ch * 54;
          d.setUint32(p, Math.round((i / n) * duration * 96000));
          const amp = centers[cell][ch] * (0.85 + random() * 0.3);
          for (let t = 0; t < 50; t++) {
            const v =
              amp *
                (Math.exp(-(((t - 14) / 3) ** 2)) -
                  0.35 * Math.exp(-(((t - 23) / 6) ** 2))) +
              (random() - 0.5) * (cell === 0 ? 40 : 10);
            d.setInt8(p + 4 + t, Math.max(-128, Math.min(127, Math.round(v))));
          }
        }
      }
      out.push(
        new File([h, b, enc.encode("\r\ndata_end")], `${base}.${tet}`, {
          lastModified: 1,
        }),
        new File([cut], `${base}_${tet}.cut`, { lastModified: 1 }),
      );
    }
  }
  return out;
}
