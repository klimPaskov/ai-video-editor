//! Face detection with the YuNet network (OpenCV Zoo, MIT) run by `tract`, a
//! pure-Rust ONNX engine, so no native runtime library has to be shipped.
//!
//! The network has a fixed 640x640 input and three anchor-free heads (strides
//! 8, 16 and 32). Each head cell predicts a face-ness score, an object score
//! and a box (centre offset in cells, log-size in strides). This module
//! prepares the input, decodes those heads and removes duplicate boxes.

use crate::framing::FaceBox;
use engine_core::files::sha256_file;
use engine_core::protocol::ErrorCode;
use engine_core::{JobError, JobResult};
use std::path::Path;
use std::sync::Arc;
use tract_onnx::prelude::*;

/// Pinned model: file name, size and SHA-256. See THIRD_PARTY_NOTICES.md.
pub const MODEL_FILE: &str = "face_detection_yunet_2023mar.onnx";
pub const MODEL_BYTES: u64 = 232_589;
pub const MODEL_SHA256: &str = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4";

/// Side of the square network input.
pub const INPUT: usize = 640;
const STRIDES: [usize; 3] = [8, 16, 32];
const NMS_IOU: f32 = 0.3;
const KEEP_AT_LEAST: f32 = 0.5;
const MAX_FACES: usize = 16;

type Plan = Arc<TypedRunnableModel>;

#[derive(Clone)]
pub struct Detector {
    plan: Plan,
}

fn unavailable(detail: impl Into<String>) -> JobError {
    JobError::new(ErrorCode::ModelUnavailable, detail)
}

impl Detector {
    /// Loads the model after checking its size and hash against the pin.
    pub fn load(path: &Path) -> JobResult<Self> {
        let size = std::fs::metadata(path)
            .map_err(|error| unavailable(format!("model missing: {error}")))?
            .len();
        if size != MODEL_BYTES {
            return Err(unavailable("model size differs from the pinned file"));
        }
        let digest = sha256_file(path).map_err(|error| unavailable(error.to_string()))?;
        if digest != MODEL_SHA256 {
            return Err(unavailable("model hash differs from the pinned file"));
        }
        let size = i32::try_from(INPUT).map_err(|_| JobError::internal("size"))?;
        let plan = tract_onnx::onnx()
            .model_for_path(path)
            .and_then(|model| {
                model.with_input_fact(
                    0,
                    InferenceFact::dt_shape(f32::datum_type(), tvec!(1, 3, size, size)),
                )
            })
            .and_then(|model| model.into_optimized())
            .and_then(|model| model.into_runnable())
            .map_err(|error| unavailable(format!("model cannot be prepared: {error}")))?;
        Ok(Self { plan })
    }

    /// Detects faces in a `INPUT`x`INPUT` BGR frame (row-major, 3 bytes per
    /// pixel) whose picture fills only the top-left `valid_w`x`valid_h`
    /// corner. Boxes are returned normalised to that picture.
    pub fn detect(
        &self,
        bgr: &[u8],
        valid_w: usize,
        valid_h: usize,
        threshold: f32,
    ) -> JobResult<Vec<FaceBox>> {
        if bgr.len() != INPUT * INPUT * 3 || valid_w == 0 || valid_h == 0 {
            return Err(JobError::internal("bad frame size"));
        }
        let mut planes = vec![0f32; 3 * INPUT * INPUT];
        for (index, pixel) in bgr.chunks_exact(3).enumerate() {
            for (channel, value) in pixel.iter().enumerate() {
                planes[channel * INPUT * INPUT + index] = f32::from(*value);
            }
        }
        let input: Tensor = tract_ndarray::Array4::from_shape_vec((1, 3, INPUT, INPUT), planes)
            .map_err(|error| JobError::internal(error.to_string()))?
            .into();
        let outputs = self
            .plan
            .run(tvec!(input.into_tvalue()))
            .map_err(|error| JobError::internal(format!("inference: {error}")))?;
        let mut heads: Vec<&[f32]> = Vec::with_capacity(outputs.len());
        for output in &outputs {
            heads.push(
                output
                    .to_plain_array_view::<f32>()
                    .map_err(|error| JobError::internal(error.to_string()))?
                    .to_slice()
                    .ok_or_else(|| JobError::internal("model output is not contiguous"))?,
            );
        }
        let raw = decode(&heads, threshold)?;
        Ok(nms(raw)
            .into_iter()
            .map(|face| normalise(face, valid_w as f32, valid_h as f32))
            .collect())
    }
}

#[derive(Debug, Clone, Copy)]
struct Raw {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    score: f32,
}

/// Decodes the cls/obj/bbox heads (`heads` is in model output order: three
/// cls, three obj, three bbox, three keypoints) into boxes in input pixels.
fn decode(heads: &[&[f32]], threshold: f32) -> JobResult<Vec<Raw>> {
    if heads.len() < 9 {
        return Err(JobError::internal("unexpected model outputs"));
    }
    let mut found = Vec::new();
    for (level, stride) in STRIDES.iter().enumerate() {
        let cells = INPUT / stride;
        let (cls, obj, bbox) = (heads[level], heads[3 + level], heads[6 + level]);
        if cls.len() != cells * cells
            || obj.len() != cells * cells
            || bbox.len() != cells * cells * 4
        {
            return Err(JobError::internal("unexpected model output shape"));
        }
        let stride = *stride as f32;
        for row in 0..cells {
            for column in 0..cells {
                let cell = row * cells + column;
                let score = (cls[cell].clamp(0.0, 1.0) * obj[cell].clamp(0.0, 1.0)).sqrt();
                if score < threshold {
                    continue;
                }
                let b = &bbox[cell * 4..cell * 4 + 4];
                let centre_x = (column as f32 + b[0]) * stride;
                let centre_y = (row as f32 + b[1]) * stride;
                let (w, h) = (b[2].exp() * stride, b[3].exp() * stride);
                found.push(Raw {
                    x: centre_x - w / 2.0,
                    y: centre_y - h / 2.0,
                    w,
                    h,
                    score,
                });
            }
        }
    }
    Ok(found)
}

fn iou(a: &Raw, b: &Raw) -> f32 {
    let width = ((a.x + a.w).min(b.x + b.w) - a.x.max(b.x)).max(0.0);
    let height = ((a.y + a.h).min(b.y + b.h) - a.y.max(b.y)).max(0.0);
    let inter = width * height;
    let union = a.w * a.h + b.w * b.h - inter;
    if union <= 0.0 {
        0.0
    } else {
        inter / union
    }
}

fn nms(mut boxes: Vec<Raw>) -> Vec<Raw> {
    boxes.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut kept: Vec<Raw> = Vec::new();
    for candidate in boxes {
        if candidate.score >= KEEP_AT_LEAST && kept.iter().all(|k| iou(k, &candidate) < NMS_IOU) {
            kept.push(candidate);
            if kept.len() == MAX_FACES {
                break;
            }
        }
    }
    kept
}

fn normalise(face: Raw, valid_w: f32, valid_h: f32) -> FaceBox {
    let x0 = (face.x / valid_w).clamp(0.0, 1.0);
    let y0 = (face.y / valid_h).clamp(0.0, 1.0);
    let x1 = ((face.x + face.w) / valid_w).clamp(0.0, 1.0);
    let y1 = ((face.y + face.h) / valid_h).clamp(0.0, 1.0);
    FaceBox {
        x: x0,
        y: y0,
        w: x1 - x0,
        h: y1 - y0,
        score: face.score,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_heads() -> Vec<Vec<f32>> {
        let mut heads = Vec::new();
        for _ in 0..2 {
            for stride in STRIDES {
                heads.push(vec![0.0; (INPUT / stride).pow(2)]);
            }
        }
        for stride in STRIDES {
            heads.push(vec![0.0; (INPUT / stride).pow(2) * 4]);
        }
        for stride in STRIDES {
            heads.push(vec![0.0; (INPUT / stride).pow(2) * 10]);
        }
        heads
    }

    #[test]
    fn a_confident_cell_decodes_to_a_box_around_its_centre() {
        let mut heads = empty_heads();
        // Stride 16, cell (row 10, column 20): centre offset (0.5, 0.25) cells,
        // size 4 strides wide and 5 strides tall.
        let cell = 10 * 40 + 20;
        heads[1][cell] = 0.9;
        heads[4][cell] = 0.9;
        heads[7][cell * 4..cell * 4 + 4].copy_from_slice(&[0.5, 0.25, 4f32.ln(), 5f32.ln()]);
        let views: Vec<&[f32]> = heads.iter().map(Vec::as_slice).collect();
        let faces = decode(&views, 0.5).unwrap();
        assert_eq!(faces.len(), 1);
        let face = faces[0];
        assert!((face.x + face.w / 2.0 - 20.5 * 16.0).abs() < 0.01);
        assert!((face.y + face.h / 2.0 - 10.25 * 16.0).abs() < 0.01);
        assert!((face.w - 64.0).abs() < 0.01 && (face.h - 80.0).abs() < 0.01);
        assert!((face.score - 0.9).abs() < 1e-6);
    }

    #[test]
    fn overlapping_boxes_collapse_to_the_strongest() {
        let strong = Raw {
            x: 100.0,
            y: 100.0,
            w: 80.0,
            h: 100.0,
            score: 0.95,
        };
        let weak = Raw {
            x: 104.0,
            y: 104.0,
            w: 80.0,
            h: 100.0,
            score: 0.7,
        };
        let apart = Raw {
            x: 400.0,
            y: 100.0,
            w: 80.0,
            h: 100.0,
            score: 0.8,
        };
        let kept = nms(vec![weak, apart, strong]);
        assert_eq!(kept.len(), 2);
        assert!((kept[0].score - 0.95).abs() < 1e-6);
    }

    #[test]
    fn boxes_are_normalised_to_the_picture_not_the_padding() {
        let face = Raw {
            x: 160.0,
            y: 90.0,
            w: 160.0,
            h: 90.0,
            score: 0.9,
        };
        let box_ = normalise(face, 640.0, 360.0);
        assert!((box_.x - 0.25).abs() < 1e-6 && (box_.w - 0.25).abs() < 1e-6);
        assert!((box_.y - 0.25).abs() < 1e-6 && (box_.h - 0.25).abs() < 1e-6);
    }

    #[test]
    fn a_wrong_model_file_is_refused_before_it_is_parsed() {
        let path = std::env::temp_dir().join(format!("yunet-bad-{}.onnx", std::process::id()));
        std::fs::write(&path, b"not a model").unwrap();
        let error = Detector::load(&path).err().unwrap();
        assert_eq!(error.code, ErrorCode::ModelUnavailable);
        let _ = std::fs::remove_file(&path);
        let missing = Detector::load(Path::new("Z:/does/not/exist.onnx"))
            .err()
            .unwrap();
        assert_eq!(missing.code, ErrorCode::ModelUnavailable);
    }
}
