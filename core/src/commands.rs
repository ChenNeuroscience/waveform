//! Edits, as commands: each makes new labels from the labels at the staged inputs' edit
//! history, changing nothing kept. The new labels and their patch are kept under the history
//! extended by the staged patch id, so JavaScript only has to store the patch and add the id
//! to its history (or, for a split preview, show that history without adding it).
//!
//! Commands answer like handlers: 0 when done (see `command_changed`, `command_patch`), what
//! is missing for JavaScript to supply (see `Missing`), or a negative error: -1 for invalid
//! input, -2 for no room for another cell.
use crate::compute::{staged_request, status, Missing, Request};
use crate::compute_handlers::{CellWaves, Counts, Gate, Labels, Patch, Pca, Population};
use crate::processing::{diff, export, split, SplitBy, CELL_WAVES_CAP};
use crate::projection::Region;
use crate::{Edit, Population as Spikes};
use std::{cell::RefCell, slice};

/// What a command needs besides the current labels.
#[derive(Clone, Copy)]
enum Needs {
    Labels,
    Features,
    Pca,
}

thread_local! {
    /// The last command's changed spike count and patch, or an export's text.
    static OUTPUT: RefCell<(usize, Vec<u8>)> = const { RefCell::new((0, vec![])) };
}

/// Runs `change` on the current labels and keeps the result under the extended history.
fn command(needs: Needs, change: impl FnOnce(&mut Edit) -> Result<(), i32>) -> i32 {
    let mut cx = staged_request();
    match edit(&mut cx, needs, change) {
        Ok(()) => 0,
        Err(Err(missing)) => status(Err(missing)) as i32,
        Err(Ok(error)) => error,
    }
}
fn edit(
    cx: &mut Request,
    needs: Needs,
    change: impl FnOnce(&mut Edit) -> Result<(), i32>,
) -> Result<(), Result<i32, Missing>> {
    let before = cx.call::<Labels>().map_err(Err)?;
    let empty = Spikes::default();
    let population = match needs {
        Needs::Labels => None,
        _ => Some(cx.call::<Population>().map_err(Err)?),
    };
    let pca = match needs {
        Needs::Pca => Some(cx.call::<Pca>().map_err(Err)?),
        _ => None,
    };
    let mut e = Edit {
        population: population.as_deref().unwrap_or(&empty),
        pca: pca.as_deref().map(|v| &v.0[..]),
        labels: (*before).clone(),
    };
    change(&mut e).map_err(Ok)?;
    keep(cx, &before, e.labels).map_err(Err)
}
/// Keeps `after` and its patch from `before` under the history extended by the staged
/// patch id, and outputs them.
fn keep(cx: &mut Request, before: &[u16], after: Vec<u16>) -> Result<(), Missing> {
    let (changed, patch) = diff(before, &after);
    if changed > 0 {
        let id = cx.inputs().patch.clone();
        let history = match &*cx.inputs().history {
            "" => id.to_string(),
            h => format!("{h},{id}"),
        };
        cx.keep_with::<Labels>(after, |i| i.history = history.into())?;
        cx.keep_with::<Patch>(patch.clone(), |i| i.patch = id)?;
    }
    OUTPUT.with(|o| *o.borrow_mut() = (changed, patch));
    Ok(())
}

/// Moves cell `source` into `dest`, or swaps them.
#[no_mangle]
pub extern "C" fn command_relabel(source: u16, dest: u16, swap: u32) -> i32 {
    command(Needs::Labels, |e| {
        e.relabel(source, dest, swap != 0);
        Ok(())
    })
}
/// Moves spikes of `sources` inside a polygon of two feature axes into `dest`.
#[no_mangle]
pub unsafe extern "C" fn command_polygon(
    sources: *const u16,
    ns: usize,
    dest: u16,
    ax: usize,
    ay: usize,
    polygon: *const f32,
    n: usize,
) -> i32 {
    let (sources, polygon) = (
        slice::from_raw_parts(sources, ns),
        slice::from_raw_parts(polygon, n),
    );
    command(needs(ax.max(ay)), |e| {
        e.polygon(sources, dest, ax, ay, polygon);
        Ok(())
    })
}
/// Moves spikes of `sources` under a brush stroke of two feature axes into `dest`.
#[no_mangle]
pub unsafe extern "C" fn command_brush(
    sources: *const u16,
    ns: usize,
    dest: u16,
    ax: usize,
    ay: usize,
    points: *const f32,
    n: usize,
) -> i32 {
    let (sources, points) = (
        slice::from_raw_parts(sources, ns),
        slice::from_raw_parts(points, n),
    );
    let mut mask = vec![0u8; 65536];
    for xy in points.chunks_exact(2) {
        let x = (xy[0] * 255.).round() as i32;
        let y = (xy[1] * 255.).round() as i32;
        for dy in -10..=10 {
            for dx in -10..=10 {
                if dx * dx + dy * dy <= 100
                    && (0..256).contains(&(x + dx))
                    && (0..256).contains(&(y + dy))
                {
                    mask[((y + dy) * 256 + x + dx) as usize] = 1;
                }
            }
        }
    }
    command(needs(ax.max(ay)), |e| {
        e.mask(sources, dest, ax, ay, &mask);
        Ok(())
    })
}
/// Moves spikes of `sources` inside a lasso or brush region of the 3D view into `dest`.
#[no_mangle]
pub unsafe extern "C" fn command_region(
    sources: *const u16,
    ns: usize,
    dest: u16,
    offset: usize,
    axes: *const u16,
    matrix: *const f32,
    points: *const f32,
    n: usize,
    radius: f32,
    width: usize,
    height: usize,
) -> i32 {
    let region = Region {
        sources: slice::from_raw_parts(sources, ns),
        dest,
        offset,
        axes: slice::from_raw_parts(axes, 3),
        matrix: slice::from_raw_parts(matrix, 8),
        points: slice::from_raw_parts(points, n),
        radius,
        width,
        height,
    };
    command(needs(offset), |e| {
        e.projected_region(region);
        Ok(())
    })
}
/// The features an edit through axis (or offset) `axis` needs: principal components from 5.
fn needs(axis: usize) -> Needs {
    if axis >= 5 {
        Needs::Pca
    } else {
        Needs::Features
    }
}
/// Splits cell `source` at a channel's sample: spikes above `threshold` become a new cell
/// numbered just after it, and higher cells move up. Reads the source's waveforms (or, for a
/// very large cell, the sample column) from the file once; later thresholds and samples of
/// the same cell reuse them.
#[no_mangle]
pub extern "C" fn command_split(source: u16, channel: usize, sample: usize, threshold: i32) -> i32 {
    if channel > 3 || sample > 49 || source as usize >= crate::MAX_CELLS {
        return -1;
    }
    let mut cx = staged_request();
    let result = (|| -> Result<Result<(), i32>, Missing> {
        let before = cx.call::<Labels>()?;
        let count = cx.call::<Counts>()?[source as usize] as usize;
        let labels = if count <= CELL_WAVES_CAP {
            let waves = cx.call_with::<CellWaves>(|i| (i.cell, i.cell_id) = (source, None))?;
            split(
                &before,
                source,
                channel,
                sample,
                threshold,
                SplitBy::Waves(&waves),
            )
        } else {
            let gate = [channel as f64, sample as f64];
            let column = cx.call_with::<Gate>(|i| i.gate = gate)?;
            split(
                &before,
                source,
                channel,
                sample,
                threshold,
                SplitBy::Column(&column),
            )
        };
        let Some(labels) = labels else {
            return Ok(Err(-2));
        };
        keep(&mut cx, &before, labels)?;
        Ok(Ok(()))
    })();
    match result {
        Ok(Ok(())) => 0,
        Ok(Err(error)) => error,
        Err(missing) => status(Err(missing)) as i32,
    }
}
/// The labels `first..first + count` at the staged history as cut-file (or .clu) text.
#[no_mangle]
pub extern "C" fn command_export(first: usize, count: usize, clu: u32) -> i32 {
    let mut cx = staged_request();
    match cx.call::<Labels>() {
        Ok(labels) => {
            let text = export(&labels, first, count, clu != 0);
            OUTPUT.with(|o| *o.borrow_mut() = (0, text));
            0
        }
        Err(missing) => status(Err(missing)) as i32,
    }
}
/// How many spikes the last command changed.
#[no_mangle]
pub extern "C" fn command_changed() -> usize {
    OUTPUT.with(|o| o.borrow().0)
}
/// The last command's patch, or an export's text.
#[no_mangle]
pub extern "C" fn command_output() -> *const u8 {
    OUTPUT.with(|o| o.borrow().1.as_ptr())
}
#[no_mangle]
pub extern "C" fn command_output_len() -> usize {
    OUTPUT.with(|o| o.borrow().1.len())
}
