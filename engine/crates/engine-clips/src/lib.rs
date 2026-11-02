//! Short-clip engine: face-following framing and a fast single-pass render.
//!
//! Methods: `clips.render` (make the clip) and `clips.frame` (only plan the
//! framing, for diagnostics and tests).

pub mod analyse;
pub mod encoder;
pub mod framing;
pub mod graph;
pub mod params;
pub mod render;
pub mod verify;
pub mod yunet;

pub use params::{RenderParams, RenderReport};
pub use render::{plan_framing, render, render_ladder, Attempt};
