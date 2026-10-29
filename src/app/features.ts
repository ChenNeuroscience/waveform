import { useEffect, useMemo, useRef, useState } from "react";
import type { FeatureCoordinates, FeatureMode, PcaFeatures, ViewData } from "../types";
import { request } from "../worker/client";
import { Superseded } from "../worker/protocol";

/** One cached PCA result, independent of cut labels. Changing the fit size or
 * recording hides stale coordinates until the worker confirms the new basis. */
export function useFeatureSpace(data: ViewData | null, mode: FeatureMode, sampleLimit: number) {
  const asset = data?.key || "";
  const session = data?.session || "";
  const samples = Math.max(4, Math.min(20_000, Math.round(sampleLimit)));
  const key = `${asset}|${mode}|${samples}`;
  const cache = useRef<PcaFeatures | null>(null);
  const [state, setState] = useState<{
    key: string;
    result?: PcaFeatures;
    message: string;
    error?: string;
  }>({ key: "", message: "" });
  useEffect(() => {
    let current = true;
    if (!asset) {
      cache.current = null;
      setState({ key, message: "" });
      return;
    }
    if (mode === "amplitudes") {
      // Also cancels a long projection if the user switches back to amplitudes.
      request("features", { asset, mode, samples }).catch(() => {});
      setState({ key, message: "" });
      return;
    }
    setState({ key, message: "Preparing principal components…" });
    const cached = cache.current?.asset === asset ? cache.current : null;
    request("features", { asset, mode, samples, knownKey: cached?.key }, (_fraction, message) => {
      if (current) {
        setState({ key, message });
      }
    })
      .then((result) => {
        if (!current || !result) {
          return;
        }
        const values = result.values ?? (cached?.key === result.key ? cached.values : undefined);
        if (!values) {
          throw new Error("PCA coordinates are unavailable.");
        }
        const complete = { ...result, values };
        cache.current = complete;
        setState({ key, result: complete, message: "" });
      })
      .catch((error) => {
        if (current && !(error instanceof Superseded)) {
          setState({ key, message: "", error: error.message });
        }
      });
    return () => {
      current = false;
    };
  }, [asset, session, mode, samples, key]);

  const values =
    mode === "amplitudes" ? data?.features : state.key === key ? state.result?.values : undefined;
  const coordinates = useMemo<FeatureCoordinates | null>(
    () =>
      values
        ? {
            key: mode === "amplitudes" ? `${asset}|amplitudes` : state.result!.key,
            mode,
            values,
          }
        : null,
    [values, mode, asset, state.result],
  );
  return {
    coordinates,
    message:
      mode === "pca" && !coordinates ? state.message || "Preparing principal components…" : "",
    error: mode === "pca" && state.key === key ? state.error : undefined,
  };
}
