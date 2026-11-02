//! Staging, publishing and cleanup of output files, plus content hashing.

use crate::job::JobResult;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// A hidden sibling of `output` that holds the file while it is being made,
/// so a half-written clip never has the final name.
pub fn staging_path(output: &Path) -> PathBuf {
    let name = output
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "clip.mp4".to_string());
    let extension = output
        .extension()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "mp4".to_string());
    output.with_file_name(format!(
        ".{name}.{}.partial.{extension}",
        std::process::id()
    ))
}

pub fn remove_quietly(path: &Path) {
    let _ = fs::remove_file(path);
}

/// Moves the finished file to its final name, replacing an existing file the
/// user already agreed to replace.
pub fn publish(staged: &Path, output: &Path) -> JobResult<()> {
    if output.exists() {
        fs::remove_file(output)?;
    }
    fs::rename(staged, output)?;
    Ok(())
}

/// Removes partial files left beside `output` by an earlier crashed run.
pub fn sweep_stale(output: &Path, older_than: Duration) {
    let (Some(directory), Some(name)) = (output.parent(), output.file_name()) else {
        return;
    };
    let prefix = format!(".{}.", name.to_string_lossy());
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let file = entry.file_name().to_string_lossy().into_owned();
        if !(file.starts_with(&prefix) && file.contains(".partial.")) {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .is_some_and(|age| age >= older_than);
        if old {
            let _ = fs::remove_file(entry.path());
        }
    }
}

pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("engine-core-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn staging_is_hidden_and_beside_the_output() {
        let staged = staging_path(Path::new("C:/clips/Hello.mp4"));
        let name = staged.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with(".Hello.mp4."));
        assert!(name.ends_with(".partial.mp4"));
        assert_eq!(staged.parent().unwrap(), Path::new("C:/clips"));
    }

    #[test]
    fn publish_replaces_and_sweep_removes_old_partials() {
        let directory = scratch("publish");
        let output = directory.join("clip.mp4");
        fs::write(&output, b"old").unwrap();
        let staged = staging_path(&output);
        fs::write(&staged, b"new").unwrap();
        publish(&staged, &output).unwrap();
        assert_eq!(fs::read(&output).unwrap(), b"new");
        assert!(!staged.exists());
        let stale = directory.join(".clip.mp4.1.partial.mp4");
        fs::write(&stale, b"x").unwrap();
        sweep_stale(&output, Duration::from_secs(3600));
        assert!(stale.exists(), "recent partials are kept");
        sweep_stale(&output, Duration::ZERO);
        assert!(!stale.exists());
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn sha256_matches_a_known_value() {
        let directory = scratch("hash");
        let file = directory.join("a.txt");
        fs::write(&file, b"abc").unwrap();
        assert_eq!(
            sha256_file(&file).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let _ = fs::remove_dir_all(&directory);
    }
}
