//! The single FFmpeg filter graph that renders a whole clip in one pass:
//! trim and join the planned source ranges, convert once to 8-bit 4:2:0,
//! apply zooms and motion graphics, frame the picture, burn captions and
//! mux with the audio. One decode, one encode, no intermediate files.

use crate::params::RenderParams;

pub struct Built {
    /// Per-source `-ss/-t/-i` arguments, clips first and then graphics.
    pub input_args: Vec<String>,
    pub filter: String,
    pub has_audio: bool,
}

fn seconds(value: f64) -> String {
    format!("{value:.6}")
}

/// Chained `atempo` filters (each limited to 2x) for a whole-number speed-up.
pub fn atempo_chain(speed: u32) -> String {
    let mut remaining = f64::from(speed);
    let mut parts = Vec::new();
    while remaining > 2.0 {
        parts.push("atempo=2".to_string());
        remaining /= 2.0;
    }
    parts.push(format!("atempo={remaining}"));
    parts.join(",")
}

struct Stage {
    parts: Vec<String>,
    label: String,
}

impl Stage {
    fn step(&mut self, filters: &str, name: &str) {
        self.parts
            .push(format!("[{}]{filters}[{name}]", self.label));
        self.label = name.to_string();
    }
}

/// `framing` is the filter that turns the full frame into the output frame
/// (the app's fixed framing, or the face-following crop).
pub fn build(params: &RenderParams, framing: &str, ass_file: Option<&str>) -> Built {
    let (num, den) = (
        params.source.frame_rate_num,
        params.source.frame_rate_den.max(1),
    );
    let restamp = format!("setpts=N*{den}/({num}*TB)");
    let audio = params.source.has_audio;
    let rate = f64::from(params.source.sample_rate.max(1));
    let mut input_args = Vec::new();
    let mut chains: Vec<String> = Vec::new();
    for (index, clip) in params.clips.iter().enumerate() {
        // Reading stops shortly after the last wanted frame instead of
        // decoding the rest of the file.
        input_args.extend([
            "-copyts".to_string(),
            "-ss".to_string(),
            seconds(clip.seek_seconds),
            "-t".to_string(),
            seconds(clip.trim_end_seconds - clip.seek_seconds + 0.25),
            "-i".to_string(),
            clip.path.to_string_lossy().into_owned(),
        ]);
        let mut video = format!(
            "[{index}:v]trim=start={}:end={},setpts=PTS-STARTPTS,trim=end_frame={}",
            seconds(clip.trim_start_seconds),
            seconds(clip.trim_end_seconds),
            clip.frame_count
        );
        if clip.speed > 1 {
            video.push_str(&format!(",select='not(mod(n,{}))'", clip.speed));
        }
        video.push_str(&format!(",{restamp}[v{index}]"));
        chains.push(video);
        if audio {
            let start = clip.first_sample as f64 / rate;
            let end = (clip.first_sample + clip.sample_count) as f64 / rate;
            let mut chain = format!(
                "[{index}:a]atrim=start={}:end={},asetpts=PTS-STARTPTS",
                seconds(start),
                seconds(end)
            );
            if clip.speed > 1 {
                chain.push(',');
                chain.push_str(&atempo_chain(clip.speed));
            }
            // Exactly the planned number of samples, padded with silence if
            // the source audio ends early.
            chain.push_str(&format!(
                ",apad,atrim=end_sample={},asetpts=PTS-STARTPTS[a{index}]",
                clip.output_samples
            ));
            chains.push(chain);
        }
    }
    let count = params.clips.len();
    let label = if count == 1 {
        "v0".to_string()
    } else {
        let joined: String = (0..count)
            .map(|i| {
                if audio {
                    format!("[v{i}][a{i}]")
                } else {
                    format!("[v{i}]")
                }
            })
            .collect();
        chains.push(format!(
            "{joined}concat=n={count}:v=1:a={}[vc]{}",
            u8::from(audio),
            if audio { "[ac]" } else { "" }
        ));
        "vc".to_string()
    };
    let mut stage = Stage {
        parts: chains,
        label,
    };
    // Every later stage works on 8-bit BT.709 limited-range 4:2:0, converted
    // once, early, where the picture is cheapest to move.
    let mut head = restamp;
    if params.source.pixel_format != "yuv420p" {
        head.push_str(
            ",scale=in_range=auto:out_color_matrix=bt709:out_range=tv:flags=bicubic,format=yuv420p",
        );
    }
    stage.step(&head, "base");
    if let Some(zoom) = params
        .zoom_filter
        .as_deref()
        .filter(|zoom| !zoom.is_empty())
    {
        stage.step(zoom, "zoomed");
    }
    let mut graphics_inputs = Vec::new();
    for (offset, segment) in params.graphics.iter().enumerate() {
        let input = count + offset;
        graphics_inputs.push(segment.path.to_string_lossy().into_owned());
        stage.parts.push(format!(
            "[{input}:v]setpts='(N+{})*{den}/({num}*TB)'[gfx{offset}]",
            segment.start_frame
        ));
        stage.parts.push(format!(
            "[{}][gfx{offset}]overlay=0:0:format=yuv420:alpha=straight:repeatlast=0:eof_action=pass[drawn{offset}]",
            stage.label
        ));
        stage.label = format!("drawn{offset}");
    }
    for path in graphics_inputs {
        input_args.extend(["-i".to_string(), path]);
    }
    stage.step(framing, "framed");
    let mut finish = String::new();
    if let Some(file) = ass_file {
        finish.push_str(&format!("ass={file},"));
    }
    finish.push_str("format=yuv420p");
    stage.step(&finish, "out");
    Built {
        input_args,
        filter: stage.parts.join(";"),
        has_audio: audio,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::params::{GraphicsSegment, PlanClip, SourceFormat};
    use std::path::PathBuf;

    fn clip(path: &str, speed: u32) -> PlanClip {
        PlanClip {
            path: PathBuf::from(path),
            frame_count: 60,
            trim_start_seconds: 1.983333,
            trim_end_seconds: 3.983333,
            seek_seconds: 0.0,
            first_sample: 96_000,
            sample_count: 96_000,
            speed,
            output_frames: 60 / u64::from(speed),
            output_samples: 96_000 / u64::from(speed),
        }
    }

    fn params(clips: Vec<PlanClip>, pixel_format: &str, audio: bool) -> RenderParams {
        let total = clips.iter().map(|c| c.output_frames).sum();
        RenderParams {
            ffmpeg: "ffmpeg".into(),
            ffprobe: "ffprobe".into(),
            output_path: PathBuf::from("/tmp/out.mp4"),
            width: 1080,
            height: 1920,
            source: SourceFormat {
                width: 1920,
                height: 1080,
                pixel_format: pixel_format.into(),
                frame_rate_num: 30,
                frame_rate_den: 1,
                has_audio: audio,
                sample_rate: 48_000,
            },
            clips,
            total_frames: total,
            total_samples: 0,
            zoom_filter: None,
            graphics: vec![],
            reframe_filter: "scale=1080:1920".into(),
            fill: true,
            fill_position: 0.5,
            ass: None,
            face_model: None,
            encoder: Default::default(),
        }
    }

    #[test]
    fn one_clip_needs_no_concat_and_cuts_exact_ranges() {
        let built = build(
            &params(vec![clip("a.mp4", 1)], "yuv420p", true),
            "crop=1:1",
            None,
        );
        assert!(!built.filter.contains("concat"));
        assert!(built.filter.contains("[0:v]trim=start=1.983333:end=3.983333,setpts=PTS-STARTPTS,trim=end_frame=60,setpts=N*1/(30*TB)[v0]"));
        assert!(built.filter.contains("[0:a]atrim=start=2.000000:end=4.000000,asetpts=PTS-STARTPTS,apad,atrim=end_sample=96000,asetpts=PTS-STARTPTS[a0]"));
        assert!(
            built.filter.ends_with("[framed]format=yuv420p[out]")
                || built.filter.contains("[framed]format=yuv420p[out]")
        );
        // Already 4:2:0: no extra colour conversion stage.
        assert!(!built.filter.contains("out_color_matrix"));
        assert_eq!(built.input_args[0], "-copyts");
        assert!(built.input_args.contains(&"a.mp4".to_string()));
    }

    #[test]
    fn several_clips_are_joined_with_audio_in_step() {
        let built = build(
            &params(vec![clip("a.mp4", 1), clip("b.mp4", 1)], "yuv420p", true),
            "null",
            None,
        );
        assert!(built
            .filter
            .contains("[v0][a0][v1][a1]concat=n=2:v=1:a=1[vc][ac]"));
        let silent = build(
            &params(vec![clip("a.mp4", 1), clip("b.mp4", 1)], "yuv420p", false),
            "null",
            None,
        );
        assert!(silent.filter.contains("[v0][v1]concat=n=2:v=1:a=0[vc]"));
        assert!(!silent.filter.contains(":a]"));
    }

    #[test]
    fn rgb_sources_are_converted_once_to_limited_range_bt709() {
        let built = build(&params(vec![clip("a.mkv", 1)], "bgr0", false), "null", None);
        assert_eq!(
            built
                .filter
                .matches("out_color_matrix=bt709:out_range=tv")
                .count(),
            1
        );
    }

    #[test]
    fn speed_keeps_every_nth_frame_and_stretches_the_audio_without_changing_pitch() {
        let built = build(
            &params(vec![clip("a.mp4", 3)], "yuv420p", true),
            "null",
            None,
        );
        assert!(built.filter.contains("select='not(mod(n,3))'"));
        assert!(built.filter.contains("atempo=2,atempo=1.5"));
        assert!(built.filter.contains("atrim=end_sample=32000"));
        assert_eq!(atempo_chain(2), "atempo=2");
        assert_eq!(atempo_chain(8), "atempo=2,atempo=2,atempo=2");
    }

    #[test]
    fn zoom_graphics_captions_and_framing_apply_in_that_order() {
        let mut request = params(vec![clip("a.mp4", 1)], "yuv420p", false);
        request.zoom_filter = Some("scale=w='1':h='1'".into());
        request.graphics = vec![GraphicsSegment {
            path: PathBuf::from("g.mkv"),
            start_frame: 12,
        }];
        let built = build(&request, "crop=1:1", Some("overlay.ass"));
        let at = |needle: &str| {
            built
                .filter
                .find(needle)
                .unwrap_or_else(|| panic!("{needle}"))
        };
        assert!(at("[base]scale=w=") < at("overlay=0:0:format=yuv420"));
        assert!(at("overlay=0:0:format=yuv420") < at("[drawn0]crop=1:1"));
        assert!(at("[drawn0]crop=1:1") < at("ass=overlay.ass,format=yuv420p[out]"));
        assert!(built
            .filter
            .contains("[1:v]setpts='(N+12)*1/(30*TB)'[gfx0]"));
        assert_eq!(built.input_args.last().unwrap(), "g.mkv");
    }
}
