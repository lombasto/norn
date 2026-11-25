//! calls: one call site of each how class of the call table (SPEC code-graph 4.2)
use crate::shapes::{helper, Area, Square};
use crate::text;
use std::collections::HashMap;

fn near() -> u32 {
    1
}

pub struct Walker(u32);

impl Walker {
    pub fn step(&self) -> u32 {
        near()
    }
    pub fn walk(&self) -> u32 {
        self.step() + Self::make().0
    }
    fn make() -> Walker {
        Walker(0)
    }
}

impl Area for Walker {
    fn area(&self) -> u32 {
        self.0
    }
}

pub fn main(x: &Walker, sq: &Square) -> u32 {
    helper(1, 2);
    text::shout();
    crate::shout();
    crate::shapes::copy(3, 4);
    Square::new(2);
    x.walk();
    sq.area();
    HashMap::<u8, u8>::new();
    Some(1);
    ghost();
    near()
}
