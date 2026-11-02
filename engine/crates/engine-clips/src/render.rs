//! Renders one clip: optional face analysis, a single FFmpeg pass, checks,
//! and publishing. A failed attempt is retried once on a safer path
//! (software encoder, fixed crop); partial files never survive a failure.

use crate::analyse;
use crate::encoder::{self, Encoder};
use crate::framing::{self, Geometry};
use crate::graph;
use crate::params::{RenderParams, RenderReport};
use crate::verify;
use crate::yunet::Detector;
use engine_core::files::{publish, remove_quietly, staging_path, sweep_stale};
use engine_core::process::{run_lines, ToolSpec};
use engine_core::protocol::ErrorCode;
use engine_core::{Cancel, JobError, JobResult};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Share of the progress bar given to face analysis when it runs.
const ANALYSIS_SHARE: f64 = 0.12;
const VERIFY_SHARE: f64 = 0.05;

/// One way of making the clip.
#[derive(Clone, Copy)]
pub struct Attempt {
    pub encoder: Encoder,
    /// Allow the crop to follow a face.
    pub follow: bool,
}

/// Removes the staged file unless the attempt succeeded.
struct Staged {
    path: PathBuf,
    armed: bool,
}

impl Drop for Staged {
    fn drop(&mut self) {
        if self.armed {
            remove_quietly(&self.path);
        }
    }
}

struct WorkDir(PathBuf);

impl WorkDir {
    fn create() -> JobResult<Self> {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos());
        let path =
            std::env::temp_dir().join(format!("urushi-engine-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&path)?;
        Ok(Self(path))
    }
}

impl Drop for WorkDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct Framed {
    filter: String,
    followed: bool,
    coverage: f64,
    note: Option<String>,
    analyse_ms: u64,
}

fn frame_clip(
    params: &RenderParams,
    attempt: Attempt,
    cancel: &Cancel,
    progress: &dyn Fn(&str, f64),
) -> JobResult<Framed> {
    let fixed = |note: Option<&str>, coverage: f64, analyse_ms: u64| Framed {
        filter: params.reframe_filter.clone(),
        followed: false,
        coverage,
        note: note.map(str::to_string),
        analyse_ms,
    };
    let Some(model) = params
        .face_model
        .as_deref()
        .filter(|_| params.fill && attempt.follow)
    else {
        return Ok(fixed(None, 0.0, 0));
    };
    let geometry = Geometry {
        src_w: params.source.width,
        src_h: params.source.height,
        out_w: params.width,
        out_h: params.height,
    };
    let started = Instant::now();
    let outcome = Detector::load(model).and_then(|detector| {
        analyse::analyse(params, &detector, cancel, &|fraction| {
            progress("analysing", fraction * ANALYSIS_SHARE);
        })
    });
    let elapsed = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    match outcome {
        Err(error) if error.code == ErrorCode::Cancelled => Err(error),
        // The face step is an improvement, never a requirement.
        Err(error) => Ok(fixed(
            Some(&format!("faces_unavailable: {}", error.detail)),
            0.0,
            elapsed,
        )),
        Ok(samples) => {
            let plan = framing::plan_follow(
                &samples,
                params.duration_seconds(),
                geometry,
                params.fill_position,
            );
            if plan.followed {
                Ok(Framed {
                    filter: framing::crop_filter(&plan, params.width, params.height),
                    followed: true,
                    coverage: plan.coverage,
                    note: None,
                    analyse_ms: elapsed,
                })
            } else {
                Ok(fixed(Some("no_face"), plan.coverage, elapsed))
            }
        }
    }
}

fn ffmpeg_args(
    params: &RenderParams,
    built: &graph::Built,
    work: &WorkDir,
    encoder: Encoder,
    staged: &Path,
) -> JobResult<Vec<String>> {
    let mut args: Vec<String> = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-nostats",
        "-progress",
        "pipe:1",
    ]
    .iter()
    .map(ToString::to_string)
    .collect();
    args.extend(built.input_args.iter().cloned());
    // Long graphs go through a file: command lines have length limits.
    if built.filter.len() > 12_000 {
        let script = work.0.join("graph.txt");
        fs::write(&script, &built.filter)?;
        args.push("-/filter_complex".into());
        args.push(script.to_string_lossy().into_owned());
    } else {
        args.push("-filter_complex".into());
        args.push(built.filter.clone());
    }
    args.extend(["-map".into(), "[out]".into()]);
    if built.has_audio {
        let label = if params.clips.len() == 1 {
            "[a0]"
        } else {
            "[ac]"
        };
        args.extend(["-map".into(), label.into()]);
    }
    args.extend(encoder.args(params.frame_rate(), params.height));
    args.extend(
        [
            "-pix_fmt",
            "yuv420p",
            "-color_range",
            "tv",
            "-colorspace",
            "bt709",
            "-color_primaries",
            "bt709",
            "-color_trc",
            "bt709",
            "-fps_mode",
            "passthrough",
        ]
        .iter()
        .map(ToString::to_string),
    );
    if built.has_audio {
        args.extend(
            ["-c:a", "aac", "-b:a", "192k"]
                .iter()
                .map(ToString::to_string),
        );
    }
    args.extend(
        [
            "-map_metadata",
            "-1",
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
        ]
        .iter()
        .map(ToString::to_string),
    );
    args.push(staged.to_string_lossy().into_owned());
    Ok(args)
}

fn run_attempt(
    params: &RenderParams,
    attempt: Attempt,
    cancel: &Cancel,
    progress: &dyn Fn(&str, f64),
) -> JobResult<RenderReport> {
    let output = &params.output_path;
    let staged = Staged {
        path: staging_path(output),
        armed: true,
    };
    let mut staged = staged;
    let framed = frame_clip(params, attempt, cancel, progress)?;
    let work = WorkDir::create()?;
    let ass_name = match params.ass.as_deref().filter(|script| !script.is_empty()) {
        Some(script) => {
            fs::write(work.0.join("overlay.ass"), script)?;
            Some("overlay.ass")
        }
        None => None,
    };
    let built = graph::build(params, &framed.filter, ass_name);
    let args = ffmpeg_args(params, &built, &work, attempt.encoder, &staged.path)?;
    let base =
        if framed.analyse_ms > 0 || params.face_model.is_some() && params.fill && attempt.follow {
            ANALYSIS_SHARE
        } else {
            0.0
        };
    let render_started = Instant::now();
    let duration = params.duration_seconds();
    let spec = ToolSpec::new(
        &params.ffmpeg,
        args,
        Duration::from_secs_f64(120.0 + duration * 12.0),
    )
    .with_stall(Duration::from_secs(90))
    .with_cwd(&work.0);
    let total = params.total_frames as f64;
    run_lines(&spec, cancel, |line| {
        if let Some(frames) = line
            .strip_prefix("frame=")
            .and_then(|n| n.trim().parse::<f64>().ok())
        {
            let done = (frames / total).min(1.0);
            progress("rendering", base + done * (1.0 - base - VERIFY_SHARE));
        }
    })?;
    let render_ms = u64::try_from(render_started.elapsed().as_millis()).unwrap_or(u64::MAX);

    progress("checking", 1.0 - VERIFY_SHARE);
    let verify_started = Instant::now();
    verify::verify(&staged.path, params, cancel)?;
    let verify_ms = u64::try_from(verify_started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let bytes = fs::metadata(&staged.path)?.len();
    cancel.check()?;
    publish(&staged.path, output)?;
    staged.armed = false;
    progress("done", 1.0);
    Ok(RenderReport {
        output_path: output.clone(),
        bytes,
        frames: params.total_frames,
        duration_us: (duration * 1_000_000.0).round() as u64,
        encoder: attempt.encoder.name().to_string(),
        framing: if framed.followed { "follow" } else { "fixed" }.to_string(),
        face_coverage: framed.coverage,
        framing_note: framed.note,
        attempts: 1,
        analyse_ms: framed.analyse_ms,
        render_ms,
        verify_ms,
    })
}

/// Plans the framing only (no encoding): which crop the render would use.
pub fn plan_framing(
    params: &RenderParams,
    cancel: &Cancel,
    progress: &dyn Fn(&str, f64),
) -> JobResult<serde_json::Value> {
    params
        .validate()
        .map_err(|detail| JobError::new(ErrorCode::InvalidRequest, detail))?;
    let framed = frame_clip(
        params,
        Attempt {
            encoder: Encoder::X264,
            follow: true,
        },
        cancel,
        progress,
    )?;
    Ok(serde_json::json!({
        "framing": if framed.followed { "follow" } else { "fixed" },
        "filter": framed.filter,
        "face_coverage": framed.coverage,
        "framing_note": framed.note,
        "analyse_ms": framed.analyse_ms,
    }))
}

/// Renders the clip described by `params`: the preferred path first, then
/// one retry on the safest path.
pub fn render(
    params: &RenderParams,
    cancel: &Cancel,
    progress: &dyn Fn(&str, f64),
) -> JobResult<RenderReport> {
    params
        .validate()
        .map_err(|detail| JobError::new(ErrorCode::InvalidRequest, detail))?;
    let encoders = encoder::candidates(
        &params.ffmpeg,
        params.encoder,
        params.width,
        params.height,
        cancel,
    )?;
    let Some(&preferred) = encoders.first() else {
        return Err(JobError::new(
            ErrorCode::Unsupported,
            "this FFmpeg has no H.264 encoder",
        ));
    };
    let software = encoders
        .iter()
        .copied()
        .find(|e| !e.is_hardware())
        .unwrap_or(preferred);
    render_ladder(
        params,
        &[
            Attempt {
                encoder: preferred,
                follow: true,
            },
            Attempt {
                encoder: software,
                follow: false,
            },
        ],
        cancel,
        progress,
    )
}

/// Runs the attempts in order until one succeeds. A failure that another
/// path could fix moves to the next attempt; cancellation, a full disk or a
/// bad request stop at once.
pub fn render_ladder(
    params: &RenderParams,
    ladder: &[Attempt],
    cancel: &Cancel,
    progress: &dyn Fn(&str, f64),
) -> JobResult<RenderReport> {
    if let Some(parent) = params.output_path.parent() {
        if !parent.is_dir() {
            return Err(JobError::new(
                ErrorCode::InvalidRequest,
                "output folder is missing",
            ));
        }
    }
    sweep_stale(&params.output_path, Duration::from_secs(24 * 3600));
    let mut earlier: Option<JobError> = None;
    for (index, attempt) in ladder.iter().enumerate() {
        if index > 0 {
            progress("retrying", 0.0);
        }
        match run_attempt(params, *attempt, cancel, progress) {
            Ok(mut report) => {
                report.attempts = u32::try_from(index + 1).unwrap_or(u32::MAX);
                if let Some(error) = earlier {
                    report.framing_note = Some(format!(
                        "retried after: {}",
                        error.detail.chars().take(160).collect::<String>()
                    ));
                }
                return Ok(report);
            }
            Err(error)
                if error.is_retryable() && !cancel.is_cancelled() && index + 1 < ladder.len() =>
            {
                earlier = Some(error);
            }
            Err(error) => return Err(error),
        }
    }
    Err(earlier.unwrap_or_else(|| JobError::internal("no attempts")))
}
