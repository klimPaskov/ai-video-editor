//! H.264 encoder choice for share clips. Clips are a compressed share
//! format (docs/44): masters stay lossless and never come through here.
//! The pinned FFmpeg may carry x264, OpenH264 and/or hardware encoders, so
//! the choice is made from what it reports and, for hardware, from a tiny
//! trial encode, because a listed hardware encoder can still fail to start.

use crate::params::EncoderPreference;
use engine_core::process::{run_capture, run_lines, ToolSpec};
use engine_core::{Cancel, JobResult};
use std::path::Path;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoder {
    X264,
    OpenH264,
    Nvenc,
    Qsv,
    Amf,
}

impl Encoder {
    pub fn name(self) -> &'static str {
        match self {
            Self::X264 => "libx264",
            Self::OpenH264 => "libopenh264",
            Self::Nvenc => "h264_nvenc",
            Self::Qsv => "h264_qsv",
            Self::Amf => "h264_amf",
        }
    }

    pub fn is_hardware(self) -> bool {
        matches!(self, Self::Nvenc | Self::Qsv | Self::Amf)
    }

    /// Output arguments for this encoder at `fps` frames per second.
    pub fn args(self, fps: f64, height: u32) -> Vec<String> {
        let gop = ((fps * 2.0).round() as u32).max(1).to_string();
        let strings = |items: &[&str]| items.iter().map(ToString::to_string).collect::<Vec<_>>();
        let mut args = match self {
            Self::X264 => strings(&["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]),
            // OpenH264 is bitrate driven: scale with the picture height.
            Self::OpenH264 => vec![
                "-c:v".to_string(),
                "libopenh264".to_string(),
                "-b:v".to_string(),
                format!("{}k", (u64::from(height) * 4).clamp(2_000, 12_000)),
            ],
            Self::Nvenc => strings(&[
                "-c:v",
                "h264_nvenc",
                "-preset",
                "p4",
                "-rc",
                "vbr",
                "-cq",
                "23",
                "-b:v",
                "0",
            ]),
            Self::Qsv => strings(&[
                "-c:v",
                "h264_qsv",
                "-preset",
                "veryfast",
                "-global_quality",
                "23",
            ]),
            Self::Amf => strings(&[
                "-c:v", "h264_amf", "-quality", "speed", "-rc", "cqp", "-qp_i", "21", "-qp_p", "23",
            ]),
        };
        args.extend(strings(&["-g", &gop]));
        args
    }
}

/// Encoders the FFmpeg build reports, in the order we would prefer them.
pub fn parse_encoders(report: &str) -> Vec<Encoder> {
    let listed = |name: &str| {
        report
            .lines()
            .any(|line| line.split_whitespace().nth(1) == Some(name))
    };
    [
        Encoder::X264,
        Encoder::OpenH264,
        Encoder::Nvenc,
        Encoder::Qsv,
        Encoder::Amf,
    ]
    .into_iter()
    .filter(|encoder| listed(encoder.name()))
    .collect()
}

pub fn available(ffmpeg: &Path, cancel: &Cancel) -> JobResult<Vec<Encoder>> {
    let spec = ToolSpec::new(
        ffmpeg,
        vec!["-hide_banner".into(), "-encoders".into()],
        Duration::from_secs(20),
    );
    Ok(parse_encoders(&run_capture(&spec, cancel)?))
}

/// Encodes a few frames at the real output size to prove the encoder starts.
pub fn works(ffmpeg: &Path, encoder: Encoder, width: u32, height: u32, cancel: &Cancel) -> bool {
    let mut args: Vec<String> = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
    ]
    .iter()
    .map(ToString::to_string)
    .collect();
    args.push(format!("color=c=gray:s={width}x{height}:r=30:d=0.2"));
    args.extend(["-pix_fmt", "yuv420p"].iter().map(ToString::to_string));
    args.extend(encoder.args(30.0, height));
    args.extend(["-f", "null", "-"].iter().map(ToString::to_string));
    let spec = ToolSpec::new(ffmpeg, args, Duration::from_secs(12));
    run_lines(&spec, cancel, |_| {}).is_ok()
}

/// Encoders to try, best first. The last entry is always a software encoder
/// when the build has one, so a retry can drop to it.
pub fn candidates(
    ffmpeg: &Path,
    preference: EncoderPreference,
    width: u32,
    height: u32,
    cancel: &Cancel,
) -> JobResult<Vec<Encoder>> {
    let all = available(ffmpeg, cancel)?;
    let software: Vec<Encoder> = all.iter().copied().filter(|e| !e.is_hardware()).collect();
    let mut order = Vec::new();
    if preference == EncoderPreference::Hardware {
        for encoder in all.iter().copied().filter(|e| e.is_hardware()) {
            if works(ffmpeg, encoder, width, height, cancel) {
                order.push(encoder);
                break;
            }
        }
    }
    order.extend(software);
    Ok(order)
}

#[cfg(test)]
mod tests {
    use super::*;

    const REPORT: &str = " V....D libx264              libx264 H.264 / AVC\n V....D libx264rgb           libx264 H.264 RGB\n V....D h264_amf             AMD AMF H.264 Encoder\n V....D libopenh264          OpenH264\n V....D hevc_nvenc           NVIDIA NVENC hevc\n";

    #[test]
    fn only_exact_names_are_matched() {
        let found = parse_encoders(REPORT);
        assert_eq!(found, [Encoder::X264, Encoder::OpenH264, Encoder::Amf]);
    }

    #[test]
    fn every_encoder_sets_a_two_second_key_frame_interval() {
        for encoder in [
            Encoder::X264,
            Encoder::OpenH264,
            Encoder::Nvenc,
            Encoder::Qsv,
            Encoder::Amf,
        ] {
            let args = encoder.args(29.97, 1920);
            let at = args.iter().position(|a| a == "-g").unwrap();
            assert_eq!(args[at + 1], "60", "{}", encoder.name());
            assert_eq!(args[1], encoder.name());
        }
    }

    #[test]
    fn openh264_bitrate_follows_the_picture_height() {
        assert!(Encoder::OpenH264
            .args(30.0, 1920)
            .contains(&"7680k".to_string()));
        assert!(Encoder::OpenH264
            .args(30.0, 360)
            .contains(&"2000k".to_string()));
    }
}
