//! Samples a few frames per second of the clip, letterboxed into the face
//! network's square input, and detects faces on several threads while FFmpeg
//! keeps decoding the next frames.

use crate::framing::{FaceBox, Sample};
use crate::params::RenderParams;
use crate::yunet::{Detector, INPUT};
use engine_core::process::{spawn, ToolHandle, ToolSpec};
use engine_core::{Cancel, JobError, JobResult};
use std::io::Read;
use std::process::ChildStdout;
use std::sync::mpsc::sync_channel;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

/// Frames per second examined. Faces move slowly compared with frames; the
/// camera path is smoothed over these samples.
pub const SAMPLE_FPS: u32 = 2;
const THRESHOLD: f32 = 0.6;

/// Size the picture takes inside the square input (longest side = input).
pub fn letterbox(width: u32, height: u32) -> (usize, usize) {
    let longest = f64::from(width.max(height));
    let scale = INPUT as f64 / longest;
    let fit = |side: u32| ((f64::from(side) * scale).round() as usize).clamp(2, INPUT);
    (fit(width), fit(height))
}

fn threads() -> usize {
    thread::available_parallelism()
        .map(|n| n.get().saturating_sub(1).clamp(1, 6))
        .unwrap_or(2)
}

/// Reads frames from FFmpeg and detects faces on a pool of threads while
/// FFmpeg keeps decoding; results come back in frame order.
fn detect_stream(
    detector: &Detector,
    stdout: &mut ChildStdout,
    handle: &ToolHandle,
    valid: (usize, usize),
    workers: usize,
    cancel: &Cancel,
    progress: &dyn Fn(usize),
) -> JobResult<Vec<Vec<FaceBox>>> {
    let frame_bytes = INPUT * INPUT * 3;
    let results: Mutex<Vec<(usize, JobResult<Vec<FaceBox>>)>> = Mutex::new(Vec::new());
    let (sender, receiver) = sync_channel::<(usize, Vec<u8>)>(workers * 2);
    let receiver = Mutex::new(receiver);
    let (queue, found_so_far) = (&receiver, &results);
    // The closure owns `sender`, so leaving it early (cancellation, a read
    // error) closes the queue and lets every worker finish.
    thread::scope(move |scope| -> JobResult<()> {
        for _ in 0..workers {
            scope.spawn(move || loop {
                let next = queue.lock().map(|waiting| waiting.recv());
                let Ok(Ok((index, frame))) = next else { break };
                let found = detector.detect(&frame, valid.0, valid.1, THRESHOLD);
                if let Ok(mut all) = found_so_far.lock() {
                    all.push((index, found));
                }
            });
        }
        let mut index = 0usize;
        loop {
            cancel.check()?;
            let mut frame = vec![0u8; frame_bytes];
            if stdout.read_exact(&mut frame).is_err() {
                break;
            }
            handle.touch();
            if sender.send((index, frame)).is_err() {
                break;
            }
            index += 1;
            progress(index);
        }
        Ok(())
    })?;
    let mut all = results
        .into_inner()
        .map_err(|_| JobError::internal("detector results poisoned"))?;
    all.sort_by_key(|(index, _)| *index);
    all.into_iter().map(|(_, found)| found).collect()
}

/// Detects faces across the planned clip. Times are in the finished clip's
/// own timeline (after cuts and speed-ups).
pub fn analyse(
    params: &RenderParams,
    detector: &Detector,
    cancel: &Cancel,
    progress: &dyn Fn(f64),
) -> JobResult<Vec<Sample>> {
    let fps = params.frame_rate();
    let valid = letterbox(params.source.width, params.source.height);
    let duration = params.duration_seconds();
    let workers = threads();
    let mut samples: Vec<Sample> = Vec::new();
    let mut output_frames_before = 0u64;
    for clip in &params.clips {
        cancel.check()?;
        let offset = output_frames_before as f64 / fps;
        output_frames_before += clip.output_frames;
        let mut filter = format!(
            "trim=start={:.6}:end={:.6},setpts=(PTS-STARTPTS)/{}+{offset:.6}/TB,fps={SAMPLE_FPS}:start_time={offset:.6}",
            clip.trim_start_seconds, clip.trim_end_seconds, clip.speed
        );
        if let Some(zoom) = params
            .zoom_filter
            .as_deref()
            .filter(|zoom| !zoom.is_empty())
        {
            filter.push(',');
            filter.push_str(zoom);
        }
        filter.push_str(&format!(
            ",scale={}:{}:flags=bilinear,pad={INPUT}:{INPUT}:0:0:black,format=bgr24",
            valid.0, valid.1
        ));
        let args: Vec<String> = [
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-copyts",
            "-ss",
            &format!("{:.6}", clip.seek_seconds),
            "-t",
            &format!("{:.6}", clip.trim_end_seconds - clip.seek_seconds + 0.25),
            "-i",
            &clip.path.to_string_lossy(),
            "-map",
            "0:v:0",
            "-an",
            "-sn",
            "-vf",
            &filter,
            "-f",
            "rawvideo",
            "pipe:1",
        ]
        .iter()
        .map(ToString::to_string)
        .collect();
        let spec = ToolSpec::new(
            &params.ffmpeg,
            args,
            Duration::from_secs_f64(40.0 + duration * 4.0),
        )
        .with_stall(Duration::from_secs(40));
        let (mut stdout, handle) = spawn(&spec, cancel)?;
        let expected = ((clip.trim_end_seconds - clip.trim_start_seconds) / f64::from(clip.speed)
            * f64::from(SAMPLE_FPS))
        .ceil()
        .max(1.0);
        let outcome = detect_stream(
            detector,
            &mut stdout,
            &handle,
            valid,
            workers,
            cancel,
            &|done| {
                progress(
                    ((offset + done as f64 / expected * (clip.output_frames as f64 / fps))
                        / duration.max(0.1))
                    .min(1.0),
                )
            },
        );
        match outcome {
            Ok(found) => {
                handle.finish()?;
                for (position, faces) in found.into_iter().enumerate() {
                    samples.push(Sample {
                        t: offset + position as f64 / f64::from(SAMPLE_FPS),
                        faces,
                    });
                }
            }
            Err(error) => {
                handle.abort();
                return Err(error);
            }
        }
    }
    if samples.is_empty() {
        return Err(JobError::internal("no frames sampled"));
    }
    Ok(samples)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_picture_is_scaled_to_fit_the_square_input() {
        assert_eq!(letterbox(1920, 1080), (640, 360));
        assert_eq!(letterbox(1080, 1920), (360, 640));
        assert_eq!(letterbox(2560, 1440), (640, 360));
        assert_eq!(letterbox(640, 640), (640, 640));
    }
}
