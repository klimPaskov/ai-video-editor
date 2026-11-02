//! Turns sparse face detections into a calm virtual-camera path for a
//! narrower output frame (for example a 9:16 clip cut from 16:9 footage),
//! and describes that path as an FFmpeg `crop` filter. Pure computation.

/// A detected face, normalised to the source frame (0..1).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FaceBox {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub score: f32,
}

impl FaceBox {
    fn centre(&self) -> (f64, f64) {
        (
            f64::from(self.x + self.w / 2.0),
            f64::from(self.y + self.h / 2.0),
        )
    }
}

/// The faces seen at one instant of the clip's own (output) timeline.
#[derive(Debug, Clone)]
pub struct Sample {
    pub t: f64,
    pub faces: Vec<FaceBox>,
}

#[derive(Debug, Clone, Copy)]
pub struct Geometry {
    pub src_w: u32,
    pub src_h: u32,
    pub out_w: u32,
    pub out_h: u32,
}

/// Top-left corner of the crop at a moment of the timeline, in source pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Key {
    pub t: f64,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone)]
pub struct CropPlan {
    pub crop_w: u32,
    pub crop_h: u32,
    pub keys: Vec<Key>,
    /// True when the path follows a face; false for a fixed crop.
    pub followed: bool,
    /// Share of samples that had a usable face.
    pub coverage: f64,
}

/// Faces smaller than this share of the frame height are ignored (crowds,
/// posters, thumbnails).
const MIN_FACE_HEIGHT: f32 = 0.04;
/// A face this small sitting in a corner is a webcam bubble, not the subject
/// of a screen recording.
const BUBBLE_MAX_HEIGHT: f32 = 0.2;
const MIN_SCORE: f32 = 0.6;
/// Follow only when the subject is visible in at least this share of samples.
const MIN_COVERAGE: f64 = 0.3;
/// After this long without a face the camera eases back to the fixed crop.
const LOST_SECONDS: f64 = 4.0;
/// The camera ignores subject movement inside this share of the crop size.
const DEAD_ZONE: f64 = 0.10;
/// Fastest camera movement, in crop widths per second.
const MAX_SPEED: f64 = 0.6;
/// Camera simulation step.
const STEP: f64 = 1.0 / 12.0;
const MAX_KEYS: usize = 40;

/// The largest even-sized rectangle with the output's aspect ratio that fits
/// inside the source.
pub fn crop_size(geo: Geometry) -> (u32, u32) {
    let target = f64::from(geo.out_w) / f64::from(geo.out_h);
    let source = f64::from(geo.src_w) / f64::from(geo.src_h);
    let even = |value: f64| ((value.floor() as u32) / 2 * 2).max(2);
    if source > target {
        (
            even(f64::from(geo.src_h) * target),
            even(f64::from(geo.src_h)),
        )
    } else {
        (
            even(f64::from(geo.src_w)),
            even(f64::from(geo.src_w) / target),
        )
    }
}

fn usable(face: &FaceBox) -> bool {
    if face.score < MIN_SCORE || face.h < MIN_FACE_HEIGHT {
        return false;
    }
    let (cx, cy) = face.centre();
    let in_corner_x = !(0.25..=0.75).contains(&cx);
    let in_corner_y = !(0.3..=0.7).contains(&cy);
    !(face.h < BUBBLE_MAX_HEIGHT && in_corner_x && in_corner_y)
}

/// Picks one subject per sample. Prefers big, confident faces, and sticks
/// with whoever was followed before unless another face is clearly bigger.
fn pick_subjects(samples: &[Sample]) -> Vec<Option<(f64, f64)>> {
    let mut previous: Option<(f64, f64)> = None;
    samples
        .iter()
        .map(|sample| {
            let best = sample
                .faces
                .iter()
                .filter(|face| usable(face))
                .map(|face| {
                    let (cx, cy) = face.centre();
                    let size = f64::from(face.h) * f64::from(face.score);
                    let near = previous.map_or(1.0, |(px, _)| 1.0 / (1.0 + 5.0 * (cx - px).abs()));
                    (size * near, cx, cy)
                })
                .max_by(|a, b| a.0.total_cmp(&b.0));
            if let Some((_, cx, cy)) = best {
                previous = Some((cx, cy));
                Some((cx, cy))
            } else {
                None
            }
        })
        .collect()
}

fn median3(values: &[f64]) -> Vec<f64> {
    (0..values.len())
        .map(|index| {
            let mut window = [
                values[index.saturating_sub(1)],
                values[index],
                values[(index + 1).min(values.len() - 1)],
            ];
            window.sort_by(f64::total_cmp);
            window[1]
        })
        .collect()
}

fn lerp_at(points: &[(f64, f64)], t: f64) -> f64 {
    match points {
        [] => 0.0,
        [only] => only.1,
        _ if t <= points[0].0 => points[0].1,
        _ => {
            for pair in points.windows(2) {
                if t < pair[1].0 {
                    let span = (pair[1].0 - pair[0].0).max(1e-9);
                    return pair[0].1 + (pair[1].1 - pair[0].1) * (t - pair[0].0) / span;
                }
            }
            points[points.len() - 1].1
        }
    }
}

/// Keeps the points that matter: repeatedly adds the point farthest from the
/// straight line through its neighbours until the error is within `tolerance`
/// or the budget is spent.
fn simplify(points: &[Key], tolerance: f64, budget: usize) -> Vec<Key> {
    if points.len() <= 2 {
        return points.to_vec();
    }
    let mut keep = vec![0, points.len() - 1];
    while keep.len() < budget {
        let mut worst = (tolerance, None);
        for pair in keep.windows(2) {
            let (a, b) = (points[pair[0]], points[pair[1]]);
            for (index, p) in points
                .iter()
                .enumerate()
                .take(pair[1])
                .skip(pair[0] + 1)
                .map(|(index, p)| (index, *p))
            {
                let fraction = (p.t - a.t) / (b.t - a.t).max(1e-9);
                let error = (p.x - (a.x + (b.x - a.x) * fraction))
                    .abs()
                    .max((p.y - (a.y + (b.y - a.y) * fraction)).abs());
                if error > worst.0 {
                    worst = (error, Some(index));
                }
            }
        }
        let Some(index) = worst.1 else { break };
        keep.push(index);
        keep.sort_unstable();
    }
    keep.into_iter().map(|index| points[index]).collect()
}

/// A crop that never moves, placed by `position` (0 left/top, 1 right/bottom).
pub fn fixed_plan(geo: Geometry, duration: f64, position: f64, coverage: f64) -> CropPlan {
    let (crop_w, crop_h) = crop_size(geo);
    let at = position.clamp(0.0, 1.0);
    let x = f64::from(geo.src_w - crop_w) * at;
    let y = f64::from(geo.src_h - crop_h) * at;
    CropPlan {
        crop_w,
        crop_h,
        keys: vec![
            Key { t: 0.0, x, y },
            Key {
                t: duration.max(0.1),
                x,
                y,
            },
        ],
        followed: false,
        coverage,
    }
}

/// Plans the crop for a clip of `duration` seconds. Falls back to a fixed
/// crop at `position` when too few samples contain a usable face, so the
/// result is always defined and deterministic.
pub fn plan_follow(samples: &[Sample], duration: f64, geo: Geometry, position: f64) -> CropPlan {
    let subjects = pick_subjects(samples);
    let seen = subjects.iter().filter(|subject| subject.is_some()).count();
    let coverage = if samples.is_empty() {
        0.0
    } else {
        seen as f64 / samples.len() as f64
    };
    if samples.len() < 3 || coverage < MIN_COVERAGE {
        return fixed_plan(geo, duration, position, coverage);
    }
    let (crop_w, crop_h) = crop_size(geo);
    let (sw, sh) = (f64::from(geo.src_w), f64::from(geo.src_h));
    let slack_x = sw - f64::from(crop_w);
    let slack_y = sh - f64::from(crop_h);
    if slack_x < 2.0 && slack_y < 2.0 {
        return fixed_plan(geo, duration, position, coverage);
    }
    let rest_x = slack_x * position.clamp(0.0, 1.0) + f64::from(crop_w) / 2.0;
    let rest_y = slack_y * position.clamp(0.0, 1.0) + f64::from(crop_h) / 2.0;

    // Target centre per sample: the subject, held through short gaps and
    // released back to the resting position after a long absence.
    let first = subjects
        .iter()
        .flatten()
        .next()
        .copied()
        .unwrap_or((0.5, 0.5));
    let mut held = first;
    let mut last_seen = f64::NEG_INFINITY;
    let (mut tx, mut ty) = (Vec::new(), Vec::new());
    for (sample, subject) in samples.iter().zip(&subjects) {
        let (cx, cy) = match subject {
            Some(found) => {
                held = *found;
                last_seen = sample.t;
                *found
            }
            None if sample.t - last_seen > LOST_SECONDS && last_seen.is_finite() => {
                (rest_x / sw, rest_y / sh)
            }
            None => held,
        };
        tx.push(cx * sw);
        // Eyes sit a little above the face centre: aim the face at 40% down.
        ty.push(cy * sh - f64::from(crop_h) * 0.1);
    }
    let (tx, ty) = (median3(&tx), median3(&ty));
    let px: Vec<(f64, f64)> = samples
        .iter()
        .map(|s| s.t)
        .zip(tx.iter().copied())
        .collect();
    let py: Vec<(f64, f64)> = samples
        .iter()
        .map(|s| s.t)
        .zip(ty.iter().copied())
        .collect();

    // Simulate the camera: still inside a dead zone, otherwise it drifts
    // toward the subject at a limited speed.
    let steps = (duration / STEP).ceil().max(1.0) as usize;
    let mut cam = (lerp_at(&px, 0.0), lerp_at(&py, 0.0));
    let (zone_x, zone_y) = (DEAD_ZONE * f64::from(crop_w), DEAD_ZONE * f64::from(crop_h));
    let (speed_x, speed_y) = (
        MAX_SPEED * f64::from(crop_w) * STEP,
        MAX_SPEED * f64::from(crop_h) * STEP,
    );
    let chase = |camera: f64, target: f64, zone: f64, speed: f64| {
        let gap = target - camera;
        if gap.abs() <= zone {
            camera
        } else {
            camera + ((gap - zone.copysign(gap)) * 0.2).clamp(-speed, speed)
        }
    };
    let mut path = Vec::with_capacity(steps + 1);
    for step in 0..=steps {
        let t = (step as f64 * STEP).min(duration);
        if step > 0 {
            cam = (
                chase(cam.0, lerp_at(&px, t), zone_x, speed_x),
                chase(cam.1, lerp_at(&py, t), zone_y, speed_y),
            );
        }
        path.push(Key {
            t,
            // Centre -> top-left, kept inside the source.
            x: (cam.0 - f64::from(crop_w) / 2.0).clamp(0.0, slack_x.max(0.0)),
            y: if slack_y < 2.0 {
                0.0
            } else {
                cam.1.clamp(0.0, slack_y)
            },
        });
    }
    if slack_x < 2.0 {
        path.iter_mut().for_each(|key| key.x = 0.0);
    }
    let mut tolerance = 0.002 * f64::from(crop_w);
    let mut keys = simplify(&path, tolerance, MAX_KEYS);
    while keys.len() > MAX_KEYS {
        tolerance *= 1.5;
        keys = simplify(&path, tolerance, MAX_KEYS);
    }
    CropPlan {
        crop_w,
        crop_h,
        keys,
        followed: true,
        coverage,
    }
}

fn piecewise(points: &[(f64, f64)]) -> String {
    let (first, last) = (points[0], points[points.len() - 1]);
    if points.iter().all(|point| (point.1 - first.1).abs() < 0.5) {
        return format!("{:.0}", first.1.round());
    }
    let mut expression = format!("{:.1}", last.1);
    for pair in points.windows(2).rev() {
        let (a, b) = (pair[0], pair[1]);
        let span = (b.0 - a.0).max(1e-3);
        expression = format!(
            "if(lt(t,{:.3}),{:.1}+({:.1})*(t-{:.3})/{:.3},{expression})",
            b.0,
            a.1,
            b.1 - a.1,
            a.0,
            span
        );
    }
    expression
}

/// The FFmpeg filter chain that cuts the planned window out of each frame and
/// scales it to the output size. Frame timestamps must be clip time.
pub fn crop_filter(plan: &CropPlan, out_w: u32, out_h: u32) -> String {
    let x: Vec<(f64, f64)> = plan.keys.iter().map(|key| (key.t, key.x)).collect();
    let y: Vec<(f64, f64)> = plan.keys.iter().map(|key| (key.t, key.y)).collect();
    format!(
        "crop=w={}:h={}:x='{}':y='{}',scale={out_w}:{out_h}:flags=bicubic,setsar=1",
        plan.crop_w,
        plan.crop_h,
        piecewise(&x),
        piecewise(&y)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const GEO: Geometry = Geometry {
        src_w: 1920,
        src_h: 1080,
        out_w: 1080,
        out_h: 1920,
    };

    fn face(cx: f32, cy: f32, h: f32) -> FaceBox {
        FaceBox {
            x: cx - h * 0.3,
            y: cy - h / 2.0,
            w: h * 0.6,
            h,
            score: 0.9,
        }
    }

    fn samples(count: usize, mut at: impl FnMut(f64) -> Option<FaceBox>) -> Vec<Sample> {
        (0..count)
            .map(|index| {
                let t = index as f64 / 3.0;
                Sample {
                    t,
                    faces: at(t).into_iter().collect(),
                }
            })
            .collect()
    }

    #[test]
    fn crop_size_is_even_and_matches_the_aspect() {
        assert_eq!(crop_size(GEO), (607 / 2 * 2, 1080));
        let square = Geometry {
            out_w: 1080,
            out_h: 1080,
            ..GEO
        };
        assert_eq!(crop_size(square), (1080, 1080));
        let portrait = Geometry {
            src_w: 1080,
            src_h: 1920,
            out_w: 1920,
            out_h: 1080,
        };
        assert_eq!(crop_size(portrait), (1080, 606));
    }

    #[test]
    fn without_faces_the_crop_is_fixed_and_deterministic() {
        let plan = plan_follow(&samples(60, |_| None), 20.0, GEO, 0.5);
        assert!(!plan.followed);
        assert_eq!(plan.keys.len(), 2);
        assert_eq!(plan.keys[0].x, f64::from(1920 - plan.crop_w) * 0.5);
        let again = plan_follow(&samples(60, |_| None), 20.0, GEO, 0.5);
        assert_eq!(plan.keys, again.keys);
    }

    #[test]
    fn a_steady_face_gives_a_steady_crop_centred_on_it() {
        let plan = plan_follow(&samples(90, |_| Some(face(0.3, 0.45, 0.3))), 30.0, GEO, 0.5);
        assert!(plan.followed);
        let expected = 0.3 * 1920.0 - f64::from(plan.crop_w) / 2.0;
        for key in &plan.keys {
            assert!((key.x - expected).abs() < 2.0, "{key:?} vs {expected}");
        }
        assert!(plan.keys.len() <= 3);
    }

    #[test]
    fn small_wobble_is_ignored_and_large_moves_are_followed_at_a_limited_speed() {
        // Wobble of 2% of the width: inside the dead zone, camera stays put.
        let wobble = samples(90, |t| {
            Some(face(0.5 + 0.02 * (t * 7.0).sin() as f32, 0.45, 0.3))
        });
        let calm = plan_follow(&wobble, 30.0, GEO, 0.5);
        let range = calm
            .keys
            .iter()
            .map(|k| k.x)
            .fold((f64::MAX, f64::MIN), |a, x| (a.0.min(x), a.1.max(x)));
        assert!(range.1 - range.0 < 8.0, "{range:?}");
        // The subject walks from the left third to the right third.
        let walk = samples(90, |t| Some(face(0.3 + 0.4 * (t / 30.0) as f32, 0.45, 0.3)));
        let plan = plan_follow(&walk, 30.0, GEO, 0.5);
        assert!(plan.keys.last().unwrap().x - plan.keys[0].x > 400.0);
        let fastest = plan
            .keys
            .windows(2)
            .map(|p| (p[1].x - p[0].x).abs() / (p[1].t - p[0].t))
            .fold(0.0, f64::max);
        assert!(
            fastest <= MAX_SPEED * f64::from(plan.crop_w) * 1.01,
            "{fastest}"
        );
    }

    #[test]
    fn a_webcam_bubble_in_a_corner_is_not_followed() {
        let plan = plan_follow(
            &samples(60, |_| Some(face(0.92, 0.88, 0.12))),
            20.0,
            GEO,
            0.5,
        );
        assert!(!plan.followed);
    }

    #[test]
    fn short_dropouts_hold_the_camera_and_long_ones_release_it() {
        let gap = samples(120, |t| (t < 14.0).then(|| face(0.25, 0.45, 0.3)));
        let plan = plan_follow(&gap, 40.0, GEO, 0.5);
        assert!(plan.followed);
        let rest = f64::from(1920 - plan.crop_w) * 0.5;
        let early = lerp_at(
            &plan.keys.iter().map(|k| (k.t, k.x)).collect::<Vec<_>>(),
            15.0,
        );
        let late = lerp_at(
            &plan.keys.iter().map(|k| (k.t, k.x)).collect::<Vec<_>>(),
            39.0,
        );
        assert!(
            early < rest - 100.0,
            "held near the subject at 15 s: {early}"
        );
        assert!(
            (late - rest).abs() < (early - rest).abs(),
            "released by 39 s: {late}"
        );
    }

    #[test]
    fn the_crop_stays_inside_the_source() {
        let edge = samples(60, |_| Some(face(0.02, 0.5, 0.3)));
        let plan = plan_follow(&edge, 20.0, GEO, 0.5);
        for key in &plan.keys {
            assert!(key.x >= 0.0 && key.x + f64::from(plan.crop_w) <= 1920.0);
            assert!(key.y >= 0.0 && key.y + f64::from(plan.crop_h) <= 1080.0);
        }
    }

    #[test]
    fn the_filter_is_a_piecewise_expression_in_t() {
        let walk = samples(90, |t| Some(face(0.3 + 0.4 * (t / 30.0) as f32, 0.45, 0.3)));
        let filter = crop_filter(&plan_follow(&walk, 30.0, GEO, 0.5), 1080, 1920);
        assert!(
            filter.starts_with("crop=w=606:h=1080:x='if(lt(t,"),
            "{filter}"
        );
        assert!(filter.ends_with("scale=1080:1920:flags=bicubic,setsar=1"));
        let fixed = crop_filter(&fixed_plan(GEO, 10.0, 0.5, 0.0), 1080, 1920);
        assert_eq!(
            fixed,
            "crop=w=606:h=1080:x='657':y='0',scale=1080:1920:flags=bicubic,setsar=1"
        );
    }
}
