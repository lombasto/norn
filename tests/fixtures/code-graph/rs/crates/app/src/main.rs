mod cli;
mod net {
    pub mod http;
}
#[path = "platform/win.rs"]
mod platform;
#[cfg(test)]
mod tests;
mod missing_mod;

use crate::net::http::{get, Client};
use fx_util::text::shout;
use std::fs;

const SHADER: &str = include_str!("../shaders/water.wgsl");

fn main() {}
