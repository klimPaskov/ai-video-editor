//! Checks a finished clip before it is published: the container describes
//! what was asked for, every planned frame is present, audio matches the
//! picture, and the whole file decodes without errors.

use crate::params::RenderParams;
use engine_core::process::{run_capture, run_lines, ToolSpec};
use engine_core::protocol::ErrorCode;
use engine_core::{Cancel, JobError, JobResult};
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

fn invalid(detail: impl Into<String>) -> JobError {
    JobError::new(ErrorCode::OutputInvalid, detail)
}

fn number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
}

/// Compares ffprobe's description of a file with the request.
pub fn check_description(probe: &Value, params: &RenderParams) -> JobResult<()> {
    let streams = probe["streams"].as_array().cloned().unwrap_or_default();
    let of = |kind: &str| -> Vec<&Value> {
        streams.iter().filter(|s| s["codec_type"] == kind).collect()
    };
    let (video, audio) = (of("video"), of("audio"));
    if video.len() != 1 {
        return Err(invalid("expected exactly one video stream"));
    }
    let video = video[0];
    if video["codec_name"] != "h264" || video["pix_fmt"] != "yuv420p" {
        return Err(invalid("video is not 8-bit H.264 4:2:0"));
    }
    if video["width"].as_u64() != Some(u64::from(params.width))
        || video["height"].as_u64() != Some(u64::from(params.height))
    {
        return Err(invalid("video size differs from the request"));
    }
    let packets = video["nb_read_packets"]
        .as_str()
        .and_then(|n| n.parse::<u64>().ok());
    if packets != Some(params.total_frames) {
        return Err(invalid(format!(
            "expected {} frames, found {packets:?}",
            params.total_frames
        )));
    }
    if params.source.has_audio != !audio.is_empty() || audio.len() > 1 {
        return Err(invalid("audio stream presence differs from the request"));
    }
    if let Some(audio) = audio.first() {
        let expected = params.total_samples as f64 / f64::from(params.source.sample_rate.max(1));
        let actual = number(&audio["duration"]).ok_or_else(|| invalid("audio has no duration"))?;
        // One AAC packet and one video frame of slack.
        let slack =
            1024.0 / f64::from(params.source.sample_rate.max(1)) + 1.0 / params.frame_rate() + 0.02;
        if (actual - expected).abs() > slack {
            return Err(invalid(format!(
                "audio lasts {actual:.3}s, expected {expected:.3}s"
            )));
        }
    }
    let wanted = params.duration_seconds();
    let total = number(&probe["format"]["duration"]).ok_or_else(|| invalid("no duration"))?;
    if (total - wanted).abs() > 0.25 + 2.0 / params.frame_rate() {
        return Err(invalid(format!(
            "file lasts {total:.3}s, expected {wanted:.3}s"
        )));
    }
    Ok(())
}

/// Probes and decodes `file`; any problem is an `OutputInvalid` error.
pub fn verify(file: &Path, params: &RenderParams, cancel: &Cancel) -> JobResult<()> {
    let probe_spec = ToolSpec::new(
        &params.ffprobe,
        [
            "-v",
            "error",
            "-count_packets",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            &file.to_string_lossy(),
        ]
        .iter()
        .map(ToString::to_string)
        .collect(),
        Duration::from_secs(60),
    );
    let text = run_capture(&probe_spec, cancel).map_err(|error| match error.code {
        ErrorCode::ToolFailed => invalid(error.detail),
        _ => error,
    })?;
    let probe: Value = serde_json::from_str(&text)
        .map_err(|error| invalid(format!("unreadable probe: {error}")))?;
    check_description(&probe, params)?;
    let mut errors = 0usize;
    let decode_spec = ToolSpec::new(
        &params.ffmpeg,
        [
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-i",
            &file.to_string_lossy(),
            "-f",
            "null",
            "-",
        ]
        .iter()
        .map(ToString::to_string)
        .collect(),
        Duration::from_secs(60 + (params.duration_seconds() * 3.0) as u64),
    );
    let run = run_lines(&decode_spec, cancel, |_| errors += 1);
    match run {
        Ok(output) if output.stderr_tail.trim().is_empty() && errors == 0 => Ok(()),
        Ok(output) => Err(invalid(format!(
            "decode reported: {}",
            output.stderr_tail.trim()
        ))),
        Err(error) if error.code == ErrorCode::ToolFailed => Err(invalid(error.detail)),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::params::{PlanClip, SourceFormat};
    use serde_json::json;
    use std::path::PathBuf;

    fn params() -> RenderParams {
        RenderParams {
            ffmpeg: "ffmpeg".into(),
            ffprobe: "ffprobe".into(),
            output_path: PathBuf::from("/tmp/o.mp4"),
            width: 1080,
            height: 1920,
            source: SourceFormat {
                width: 1920,
                height: 1080,
                pixel_format: "yuv420p".into(),
                frame_rate_num: 30,
                frame_rate_den: 1,
                has_audio: true,
                sample_rate: 48_000,
            },
            clips: vec![PlanClip {
                path: "a".into(),
                frame_count: 60,
                trim_start_seconds: 0.0,
                trim_end_seconds: 2.0,
                seek_seconds: 0.0,
                first_sample: 0,
                sample_count: 96_000,
                speed: 1,
                output_frames: 60,
                output_samples: 96_000,
            }],
            total_frames: 60,
            total_samples: 96_000,
            zoom_filter: None,
            graphics: vec![],
            reframe_filter: String::new(),
            fill: false,
            fill_position: 0.5,
            ass: None,
            face_model: None,
            encoder: Default::default(),
        }
    }

    fn good() -> Value {
        json!({
            "streams": [
                {"codec_type":"video","codec_name":"h264","pix_fmt":"yuv420p","width":1080,"height":1920,"nb_read_packets":"60"},
                {"codec_type":"audio","duration":"2.000000"}
            ],
            "format": {"duration": "2.000000"}
        })
    }

    #[test]
    fn a_matching_file_passes() {
        check_description(&good(), &params()).unwrap();
    }

    #[test]
    fn each_kind_of_mismatch_is_rejected() {
        let mut missing_frames = good();
        missing_frames["streams"][0]["nb_read_packets"] = json!("59");
        let mut wrong_size = good();
        wrong_size["streams"][0]["width"] = json!(1920);
        let mut short_audio = good();
        short_audio["streams"][1]["duration"] = json!("1.5");
        let mut no_audio = good();
        no_audio["streams"].as_array_mut().unwrap().pop();
        let mut wrong_codec = good();
        wrong_codec["streams"][0]["codec_name"] = json!("hevc");
        for bad in [
            missing_frames,
            wrong_size,
            short_audio,
            no_audio,
            wrong_codec,
        ] {
            let error = check_description(&bad, &params()).unwrap_err();
            assert_eq!(error.code, ErrorCode::OutputInvalid, "{bad}");
        }
    }
}
