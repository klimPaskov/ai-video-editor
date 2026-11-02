//! The `clips.render` request. The app has already planned which source
//! frames and samples make up the clip; the engine only executes the plan.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Deserialize)]
pub struct SourceFormat {
    pub width: u32,
    pub height: u32,
    pub pixel_format: String,
    pub frame_rate_num: u32,
    pub frame_rate_den: u32,
    pub has_audio: bool,
    #[serde(default)]
    pub sample_rate: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PlanClip {
    pub path: PathBuf,
    pub frame_count: u64,
    pub trim_start_seconds: f64,
    pub trim_end_seconds: f64,
    pub seek_seconds: f64,
    pub first_sample: u64,
    pub sample_count: u64,
    pub speed: u32,
    pub output_frames: u64,
    pub output_samples: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GraphicsSegment {
    pub path: PathBuf,
    pub start_frame: u64,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EncoderPreference {
    /// Software first: predictable everywhere.
    #[default]
    Software,
    /// Try a working hardware encoder first, software if it fails.
    Hardware,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RenderParams {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    pub output_path: PathBuf,
    pub width: u32,
    pub height: u32,
    pub source: SourceFormat,
    pub clips: Vec<PlanClip>,
    pub total_frames: u64,
    pub total_samples: u64,
    /// Zoom filter built by the app, applied to full frames in clip time.
    #[serde(default)]
    pub zoom_filter: Option<String>,
    #[serde(default)]
    pub graphics: Vec<GraphicsSegment>,
    /// The app's fixed framing (fit with blurred fill, or a fill crop).
    pub reframe_filter: String,
    /// True when framing is "fill": the crop may follow a face.
    #[serde(default)]
    pub fill: bool,
    #[serde(default = "half")]
    pub fill_position: f64,
    /// Burned-in captions as an ASS script.
    #[serde(default)]
    pub ass: Option<String>,
    /// Pinned face model file; absent means no face following.
    #[serde(default)]
    pub face_model: Option<PathBuf>,
    #[serde(default)]
    pub encoder: EncoderPreference,
}

fn half() -> f64 {
    0.5
}

impl RenderParams {
    pub fn frame_rate(&self) -> f64 {
        f64::from(self.source.frame_rate_num) / f64::from(self.source.frame_rate_den.max(1))
    }

    /// Length of the finished clip in seconds.
    pub fn duration_seconds(&self) -> f64 {
        self.total_frames as f64 / self.frame_rate().max(1.0)
    }

    /// Rejects requests that cannot be rendered, with a detail for the log.
    pub fn validate(&self) -> Result<(), String> {
        if self.width == 0
            || self.height == 0
            || !self.width.is_multiple_of(2)
            || !self.height.is_multiple_of(2)
        {
            return Err("output size must be even and non-zero".into());
        }
        let source = &self.source;
        if source.width == 0 || source.height == 0 || source.frame_rate_num == 0 {
            return Err("source format is incomplete".into());
        }
        if self.clips.is_empty() || self.clips.len() > 512 || self.total_frames == 0 {
            return Err("no frames to render".into());
        }
        if self
            .clips
            .iter()
            .map(|clip| clip.output_frames)
            .sum::<u64>()
            != self.total_frames
        {
            return Err("frame totals disagree".into());
        }
        for clip in &self.clips {
            if clip.speed == 0
                || clip.speed > 16
                || clip.frame_count == 0
                || clip.trim_end_seconds <= clip.trim_start_seconds
                || clip.seek_seconds < 0.0
                || clip.seek_seconds > clip.trim_start_seconds
            {
                return Err("a clip range is invalid".into());
            }
        }
        if source.has_audio && source.sample_rate == 0 {
            return Err("audio rate missing".into());
        }
        if !self.output_path.is_absolute() || self.ffmpeg.as_os_str().is_empty() {
            return Err("output path must be absolute and FFmpeg must be named".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RenderReport {
    pub output_path: PathBuf,
    pub bytes: u64,
    pub frames: u64,
    pub duration_us: u64,
    pub encoder: String,
    /// "follow" when the crop tracked a face, otherwise "fixed".
    pub framing: String,
    /// Share of sampled frames with a usable face (0 when not analysed).
    pub face_coverage: f64,
    /// Why a face was not followed, when "fill" was requested.
    pub framing_note: Option<String>,
    pub attempts: u32,
    pub analyse_ms: u64,
    pub render_ms: u64,
    pub verify_ms: u64,
}
