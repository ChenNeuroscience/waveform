//! Write a simulated dataset to a directory.
//!
//!   cargo run --release --manifest-path core/Cargo.toml --features cli --bin synthetic -- OUT_DIR [options]
use clap::{CommandFactory, Parser};
use std::{fs::File, io::Write, path::PathBuf};
use waveform_core::synthetic::{Dataset, Params};

/// Write a simulated dataset (.set, .pos, tetrode and .cut files) to a directory.
#[derive(Parser)]
#[command(name = "synthetic")]
struct Args {
    /// Output directory, created if missing.
    out: PathBuf,
    /// Random seed [default: random].
    #[arg(long)]
    seed: Option<u32>,
    /// File name prefix.
    #[arg(long, default_value = "synthetic")]
    name: String,
    /// Trials, named NAME-a, NAME-b, ...
    #[arg(long, default_value_t = 5)]
    trials: usize,
    /// Tetrodes per trial; the last is uncut and the one before partly cut.
    #[arg(long, default_value_t = 8)]
    tetrodes: usize,
    /// Seconds per trial.
    #[arg(long, default_value_t = 1200)]
    duration: usize,
    /// Cells per tetrode, cycled over tetrodes.
    #[arg(long, value_delimiter = ',', default_value = "24,36,48")]
    cells: Vec<usize>,
    /// Requested spikes per recording, trial-major and cycled (one value for all,
    /// one per tetrode, or one per recording).
    #[arg(long, value_delimiter = ',', default_value = "50000")]
    spikes: Vec<usize>,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    let params = Params {
        seed: args.seed.unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .subsec_nanos()
        }),
        name: args.name,
        trials: args.trials,
        tetrodes: args.tetrodes,
        duration: args.duration,
        cells: args.cells,
        spikes: args.spikes,
    };
    let dataset = Dataset::new(&params).unwrap_or_else(|e| {
        Args::command()
            .error(clap::error::ErrorKind::ValueValidation, e)
            .exit()
    });
    std::fs::create_dir_all(&args.out)?;
    eprintln!("seed {} -> {}", params.seed, args.out.display());
    let mut buf = vec![0; 216 << 15];
    for f in &dataset.files {
        let mut w = File::create(args.out.join(&f.name))?;
        for offset in (0..f.size()).step_by(buf.len()) {
            let part = &mut buf[..(f.size() - offset).min(216 << 15)];
            f.read(offset, part);
            w.write_all(part)?;
        }
    }
    eprintln!("wrote {} files", dataset.files.len());
    Ok(())
}
