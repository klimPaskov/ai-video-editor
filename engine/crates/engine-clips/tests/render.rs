//! End-to-end renders of synthetic media through the real FFmpeg. These need
//! `ffmpeg` and `ffprobe` on PATH (or FFMPEG / FFPROBE set); face-model
//! checks need URUSHI_TEST_FACE_MODEL to name the pinned YuNet file.

use engine_clips::encoder::Encoder;
use engine_clips::params::{
    EncoderPreference, GraphicsSegment, PlanClip, RenderParams, SourceFormat,
};
use engine_clips::{render, render_ladder, Attempt};
use engine_core::protocol::ErrorCode;
use engine_core::Cancel;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

const FPS: u32 = 30;

fn tool(variable: &str, default: &str) -> PathBuf {
    PathBuf::from(std::env::var(variable).unwrap_or_else(|_| default.to_string()))
}

fn scratch(name: &str) -> PathBuf {
    let directory =
        std::env::temp_dir().join(format!("engine-clips-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&directory);
    std::fs::create_dir_all(&directory).unwrap();
    directory
}

fn make_source(directory: &Path, name: &str, seconds: u32, width: u32, height: u32) -> PathBuf {
    let path = directory.join(name);
    let status = Command::new(tool("FFMPEG", "ffmpeg"))
        .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y"])
        .args(["-f", "lavfi", "-i"])
        .arg(format!(
            "testsrc2=size={width}x{height}:rate={FPS}:duration={seconds}"
        ))
        .args(["-f", "lavfi", "-i"])
        .arg(format!(
            "sine=frequency=440:sample_rate=48000:duration={seconds}"
        ))
        .args([
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-g",
            "30",
            "-pix_fmt",
            "yuv420p",
        ])
        .args(["-c:a", "aac", "-shortest"])
        .arg(&path)
        .status()
        .expect("ffmpeg must be installed to run these tests");
    assert!(status.success());
    path
}

/// A plan for source frames [first, first + count) played `speed` times faster.
fn plan_clip(path: &Path, first: u64, count: u64, speed: u32) -> PlanClip {
    let frame = 1.0 / f64::from(FPS);
    let trim_start = (first as f64 - 0.5) * frame;
    let output_frames = count.div_ceil(u64::from(speed));
    let samples = count * 48_000 / u64::from(FPS);
    PlanClip {
        path: path.to_path_buf(),
        frame_count: count,
        trim_start_seconds: trim_start.max(0.0),
        trim_end_seconds: (first + count) as f64 * frame - 0.5 * frame,
        seek_seconds: (trim_start - 2.0).max(0.0),
        first_sample: first * 48_000 / u64::from(FPS),
        sample_count: samples,
        speed,
        output_frames,
        output_samples: output_frames * 48_000 / u64::from(FPS),
    }
}

fn params(
    output: PathBuf,
    clips: Vec<PlanClip>,
    width: u32,
    height: u32,
    fill: bool,
) -> RenderParams {
    RenderParams {
        ffmpeg: tool("FFMPEG", "ffmpeg"),
        ffprobe: tool("FFPROBE", "ffprobe"),
        output_path: output,
        width,
        height,
        source: SourceFormat {
            width: 640,
            height: 360,
            pixel_format: "yuv420p".into(),
            frame_rate_num: FPS,
            frame_rate_den: 1,
            has_audio: true,
            sample_rate: 48_000,
        },
        total_frames: clips.iter().map(|c| c.output_frames).sum(),
        total_samples: clips.iter().map(|c| c.output_samples).sum(),
        clips,
        zoom_filter: None,
        graphics: vec![],
        reframe_filter: format!(
            "crop='min(iw,ih*{width}/{height})':'min(ih,iw*{height}/{width})',scale={width}:{height},setsar=1"
        ),
        fill,
        fill_position: 0.5,
        ass: Some(
            "[Script Info]\nScriptType: v4.00+\nPlayResX: 360\nPlayResY: 640\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,32,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,60,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.20,0:00:01.50,Default,,0,0,0,,Hello clip\n".into(),
        ),
        face_model: std::env::var("URUSHI_TEST_FACE_MODEL").ok().map(PathBuf::from),
        encoder: EncoderPreference::Software,
    }
}

fn stream_summary(file: &Path) -> serde_json::Value {
    let out = Command::new(tool("FFPROBE", "ffprobe"))
        .args([
            "-v",
            "error",
            "-count_packets",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
        ])
        .arg(file)
        .output()
        .unwrap();
    serde_json::from_slice(&out.stdout).unwrap()
}

fn leftovers(directory: &Path) -> Vec<String> {
    std::fs::read_dir(directory)
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains(".partial"))
        .collect()
}

fn quiet(_phase: &str, _fraction: f64) {}

#[test]
fn renders_a_vertical_clip_with_audio_and_burned_captions() {
    let directory = scratch("vertical");
    let source = make_source(&directory, "src.mp4", 8, 640, 360);
    let output = directory.join("clip.mp4");
    let request = params(
        output.clone(),
        vec![plan_clip(&source, 30, 120, 1)],
        360,
        640,
        true,
    );
    let report = render(&request, &Cancel::new(), &quiet).unwrap();
    assert_eq!(report.frames, 120);
    assert_eq!(report.framing, "fixed");
    assert_eq!(report.attempts, 1);
    let probe = stream_summary(&output);
    let video = probe["streams"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["codec_type"] == "video")
        .unwrap()
        .clone();
    assert_eq!(
        (video["width"].as_u64(), video["height"].as_u64()),
        (Some(360), Some(640))
    );
    assert_eq!(video["nb_read_packets"], "120");
    assert_eq!(video["color_space"], "bt709");
    assert!(probe["streams"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["codec_type"] == "audio"));
    assert!(leftovers(&directory).is_empty());
    let _ = std::fs::remove_dir_all(&directory);
}

#[test]
fn joins_ranges_and_speeds_one_up() {
    let directory = scratch("join");
    let source = make_source(&directory, "src.mp4", 10, 640, 360);
    let output = directory.join("joined.mp4");
    // 2 s normal + 3 s played at 3x (1 s) from elsewhere: 3 s total.
    let clips = vec![
        plan_clip(&source, 30, 60, 1),
        plan_clip(&source, 150, 90, 3),
    ];
    let request = params(output.clone(), clips, 360, 640, false);
    let report = render(&request, &Cancel::new(), &quiet).unwrap();
    assert_eq!(report.frames, 90);
    assert_eq!(
        stream_summary(&output)["streams"][0]["nb_read_packets"],
        "90"
    );
    let _ = std::fs::remove_dir_all(&directory);
}

#[test]
fn a_failing_first_attempt_is_retried_on_the_safe_path() {
    let directory = scratch("retry");
    let source = make_source(&directory, "src.mp4", 6, 640, 360);
    let output = directory.join("retry.mp4");
    let request = params(
        output.clone(),
        vec![plan_clip(&source, 30, 60, 1)],
        360,
        640,
        true,
    );
    // A hardware encoder this machine may not have (or cannot start).
    let ladder = [
        Attempt {
            encoder: Encoder::Qsv,
            follow: true,
        },
        Attempt {
            encoder: Encoder::X264,
            follow: false,
        },
    ];
    let report = render_ladder(&request, &ladder, &Cancel::new(), &quiet).unwrap();
    assert!(report.attempts == 1 || report.attempts == 2);
    if report.attempts == 2 {
        assert_eq!(report.encoder, "libx264");
        assert!(report
            .framing_note
            .as_deref()
            .unwrap()
            .starts_with("retried after"));
    }
    assert_eq!(
        stream_summary(&output)["streams"][0]["nb_read_packets"],
        "60"
    );
    assert!(leftovers(&directory).is_empty());
    let _ = std::fs::remove_dir_all(&directory);
}

#[test]
fn a_missing_source_fails_plainly_and_leaves_nothing_behind() {
    let directory = scratch("missing");
    let output = directory.join("never.mp4");
    let gone = directory.join("gone.mp4");
    let request = params(
        output.clone(),
        vec![plan_clip(&gone, 30, 60, 1)],
        360,
        640,
        false,
    );
    let error = render(&request, &Cancel::new(), &quiet).unwrap_err();
    assert_eq!(error.code, ErrorCode::ToolFailed);
    assert!(!output.exists());
    assert!(leftovers(&directory).is_empty());
    let _ = std::fs::remove_dir_all(&directory);
}

#[test]
fn invalid_requests_are_rejected_before_any_work() {
    let directory = scratch("invalid");
    let source = make_source(&directory, "src.mp4", 4, 640, 360);
    let mut request = params(
        directory.join("x.mp4"),
        vec![plan_clip(&source, 30, 30, 1)],
        361,
        640,
        false,
    );
    assert_eq!(
        render(&request, &Cancel::new(), &quiet).unwrap_err().code,
        ErrorCode::InvalidRequest
    );
    request.width = 360;
    request.total_frames += 1;
    assert_eq!(
        render(&request, &Cancel::new(), &quiet).unwrap_err().code,
        ErrorCode::InvalidRequest
    );
    let _ = std::fs::remove_dir_all(&directory);
}

#[test]
fn cancelling_stops_ffmpeg_quickly_and_removes_the_partial_file() {
    let directory = scratch("cancel");
    let source = make_source(&directory, "src.mp4", 60, 640, 360);
    let output = directory.join("slow.mp4");
    let mut request = params(
        output.clone(),
        vec![plan_clip(&source, 0, 1800, 1)],
        360,
        640,
        false,
    );
    // A deliberately heavy blur keeps the encode busy long enough to cancel.
    request.reframe_filter = "scale=1440:2560,gblur=sigma=40,scale=360:640,setsar=1".into();
    let cancel = Cancel::new();
    let stopper = cancel.clone();
    let started = Instant::now();
    let handle = thread::spawn(move || {
        thread::sleep(Duration::from_millis(1500));
        stopper.cancel();
    });
    let error = render(&request, &cancel, &quiet).unwrap_err();
    handle.join().unwrap();
    assert_eq!(error.code, ErrorCode::Cancelled);
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "{:?}",
        started.elapsed()
    );
    assert!(!output.exists());
    assert!(leftovers(&directory).is_empty());
    let _ = std::fs::remove_dir_all(&directory);
}

#[test]
fn with_the_pinned_model_a_faceless_clip_falls_back_to_a_fixed_crop() {
    let Ok(model) = std::env::var("URUSHI_TEST_FACE_MODEL") else {
        eprintln!("skipped: URUSHI_TEST_FACE_MODEL is not set");
        return;
    };
    let directory = scratch("faceless");
    let source = make_source(&directory, "src.mp4", 6, 640, 360);
    let output = directory.join("faceless.mp4");
    let mut request = params(
        output.clone(),
        vec![plan_clip(&source, 30, 90, 1)],
        360,
        640,
        true,
    );
    request.face_model = Some(PathBuf::from(model));
    let report = render(&request, &Cancel::new(), &quiet).unwrap();
    assert_eq!(report.framing, "fixed");
    assert_eq!(report.framing_note.as_deref(), Some("no_face"));
    assert!(report.analyse_ms > 0);
    let _ = std::fs::remove_dir_all(&directory);
}

#[test]
fn zoom_graphics_and_a_very_long_graph_render_in_the_same_pass() {
    let directory = scratch("layers");
    let source = make_source(&directory, "src.mp4", 6, 640, 360);
    // A half-transparent red overlay track (lossless, straight alpha).
    let overlay = directory.join("overlay.mkv");
    let status = Command::new(tool("FFMPEG", "ffmpeg"))
        .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y"])
        .args(["-f", "lavfi", "-i"])
        .arg("color=c=red@0.6:s=640x360:r=30:d=2,format=bgra")
        .args(["-c:v", "ffv1"])
        .arg(&overlay)
        .status()
        .unwrap();
    assert!(status.success());
    let clip = plan_clip(&source, 30, 90, 1);

    let plain = directory.join("plain.mp4");
    let simple = params(plain.clone(), vec![clip.clone()], 360, 640, false);
    render(&simple, &Cancel::new(), &quiet).unwrap();

    let layered = directory.join("layered.mp4");
    let mut request = params(layered.clone(), vec![clip], 360, 640, false);
    // The app's zoom filter shape: magnification as an expression of time.
    let zoom = "scale=w='max(iw,trunc(iw*(1+0.5*between(t,1,2))/2)*2)':h='max(ih,trunc(ih*(1+0.5*between(t,1,2))/2)*2)':eval=frame:flags=lanczos,crop=640:360:x='max(0,min(iw-640,iw*0.5-320))':y='max(0,min(ih-360,ih*0.5-180))'";
    // Padding with no-op filters pushes the graph past the command-line
    // threshold, so it must travel through a script file.
    request.zoom_filter = Some(format!("{}{zoom}", "null,".repeat(3_500)));
    request.graphics = vec![GraphicsSegment {
        path: overlay,
        start_frame: 15,
    }];
    let report = render(&request, &Cancel::new(), &quiet).unwrap();
    assert_eq!(report.frames, 90);
    assert_eq!(report.attempts, 1);
    assert_eq!(
        stream_summary(&layered)["streams"][0]["nb_read_packets"],
        "90"
    );
    // Same length, visibly different pictures.
    assert_ne!(
        std::fs::read(&plain).unwrap(),
        std::fs::read(&layered).unwrap()
    );
    assert!(leftovers(&directory).is_empty());
    let _ = std::fs::remove_dir_all(&directory);
}
