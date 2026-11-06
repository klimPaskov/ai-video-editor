//! `urushi-engine loopback`: records what the computer plays (WASAPI loopback
//! of the default output device, as OBS does) and streams it as raw 32-bit
//! float stereo at 48 kHz over a local TCP port that FFmpeg reads.
//!
//! The recorder starts this process first and reads one line from standard
//! output, `PORT <n>`, then points FFmpeg at `tcp://127.0.0.1:<n>`. The
//! process ends when that connection closes, so a stopped or crashed capture
//! never leaves it running. Only Windows has a loopback; elsewhere it exits
//! with an error and the recorder offers no computer sound.

use std::io::Write;
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};
use std::process::ExitCode;
use std::time::{Duration, Instant};

pub const SAMPLE_RATE: u32 = 48_000;
/// Two channels of 32-bit float.
pub const FRAME_BYTES: usize = 8;

/// A gap shorter than this is jitter, not silence worth filling.
const GAP_FRAMES: u64 = (SAMPLE_RATE as u64) / 50;

/// Keeps the stream continuous on the wall clock. WASAPI loopback delivers
/// nothing while nothing plays, and FFmpeg would then see a shorter audio
/// track than the video; the pacer says how many frames of silence to add.
#[derive(Debug, Default)]
pub struct Pacer {
    written: u64,
}

impl Pacer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Records frames that were sent.
    pub fn record(&mut self, frames: u64) {
        self.written += frames;
    }

    /// Frames of silence to send now so the stream covers `elapsed`.
    pub fn silence_due(&self, elapsed: Duration) -> u64 {
        // Truncation is intended: whole frames only.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let target = (elapsed.as_secs_f64() * f64::from(SAMPLE_RATE)) as u64;
        let behind = target.saturating_sub(self.written);
        if behind > GAP_FRAMES {
            behind
        } else {
            0
        }
    }
}

fn silence(frames: u64) -> Vec<u8> {
    let bytes = usize::try_from(frames).unwrap_or(0).saturating_mul(FRAME_BYTES);
    vec![0_u8; bytes]
}

/// Entry point for `urushi-engine loopback`.
pub fn run() -> ExitCode {
    let listener = match TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("loopback: cannot listen: {error}");
            return ExitCode::from(2);
        }
    };
    let port = match listener.local_addr() {
        Ok(address) => address.port(),
        Err(error) => {
            eprintln!("loopback: no port: {error}");
            return ExitCode::from(2);
        }
    };
    println!("PORT {port}");
    if std::io::stdout().flush().is_err() {
        return ExitCode::from(2);
    }
    // FFmpeg connects within moments of the line above; give up if it never does.
    if listener.set_nonblocking(true).is_err() {
        return ExitCode::from(2);
    }
    let deadline = Instant::now() + Duration::from_secs(20);
    let stream = loop {
        match listener.accept() {
            Ok((stream, _)) => break stream,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() > deadline {
                    eprintln!("loopback: nothing connected");
                    return ExitCode::from(3);
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => {
                eprintln!("loopback: accept failed: {error}");
                return ExitCode::from(2);
            }
        }
    };
    if stream.set_nonblocking(false).is_err() || stream.set_nodelay(true).is_err() {
        return ExitCode::from(2);
    }
    match capture(stream) {
        // A closed connection is the normal end of a capture.
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("loopback: {message}");
            ExitCode::from(4)
        }
    }
}

#[cfg(windows)]
fn capture(mut out: std::net::TcpStream) -> Result<(), String> {
    use std::collections::VecDeque;
    use wasapi::{
        initialize_mta, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat,
    };

    let describe = |error: &dyn std::fmt::Display| error.to_string();
    initialize_mta()
        .ok()
        .map_err(|error| describe(&error))?;
    let enumerator = DeviceEnumerator::new().map_err(|error| describe(&error))?;
    // Capturing from the default *output* device is the loopback.
    let device = enumerator
        .get_default_device(&Direction::Render)
        .map_err(|error| describe(&error))?;
    let mut client = device.get_iaudioclient().map_err(|error| describe(&error))?;
    let format = WaveFormat::new(32, 32, &SampleType::Float, SAMPLE_RATE as usize, 2, None);
    let (_default_period, minimum_period) = client
        .get_device_period()
        .map_err(|error| describe(&error))?;
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: minimum_period,
    };
    client
        .initialize_client(&format, &Direction::Capture, &mode)
        .map_err(|error| describe(&error))?;
    let event = client
        .set_get_eventhandle()
        .map_err(|error| describe(&error))?;
    let reader = client
        .get_audiocaptureclient()
        .map_err(|error| describe(&error))?;
    client.start_stream().map_err(|error| describe(&error))?;

    let started = Instant::now();
    let mut pacer = Pacer::new();
    let mut queue: VecDeque<u8> = VecDeque::new();
    loop {
        // No event while nothing plays; the timeout only wakes the pacer.
        let _ = event.wait_for_event(20);
        while let Some(frames) = reader
            .get_next_packet_size()
            .map_err(|error| describe(&error))?
        {
            if frames == 0 {
                break;
            }
            reader
                .read_from_device_to_deque(&mut queue)
                .map_err(|error| describe(&error))?;
        }
        let sent = queue.len() / FRAME_BYTES;
        if sent > 0 {
            let bytes: Vec<u8> = queue.drain(..sent * FRAME_BYTES).collect();
            if out.write_all(&bytes).is_err() {
                return Ok(());
            }
            pacer.record(sent as u64);
        }
        let gap = pacer.silence_due(started.elapsed());
        if gap > 0 {
            if out.write_all(&silence(gap)).is_err() {
                return Ok(());
            }
            pacer.record(gap);
        }
    }
}

#[cfg(not(windows))]
fn capture(_out: std::net::TcpStream) -> Result<(), String> {
    Err("computer sound can only be recorded on Windows".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_short_gap_is_jitter_and_a_long_one_is_filled() {
        let mut pacer = Pacer::new();
        pacer.record(48_000);
        // Ahead of the clock: nothing to add.
        assert_eq!(pacer.silence_due(Duration::from_millis(900)), 0);
        // 10 ms behind: below the 20 ms threshold.
        assert_eq!(pacer.silence_due(Duration::from_millis(1010)), 0);
        // Half a second behind: fill exactly the missing frames.
        assert_eq!(pacer.silence_due(Duration::from_millis(1500)), 24_000);
    }

    #[test]
    fn filling_the_gap_closes_it() {
        let mut pacer = Pacer::new();
        let gap = pacer.silence_due(Duration::from_secs(2));
        assert_eq!(gap, 96_000);
        pacer.record(gap);
        assert_eq!(pacer.silence_due(Duration::from_secs(2)), 0);
    }

    #[test]
    fn silence_is_zero_bytes_of_whole_frames() {
        let bytes = silence(3);
        assert_eq!(bytes.len(), 3 * FRAME_BYTES);
        assert!(bytes.iter().all(|byte| *byte == 0));
    }
}
