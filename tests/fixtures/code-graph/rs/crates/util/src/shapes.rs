//! shapes: definitions for the symbol fixture
pub trait Area {
    fn area(&self) -> u32;
}

pub struct Square(pub u32);

pub enum Tone {
    Light,
    Dark,
}

impl Square {
    pub fn new(n: u32) -> Self {
        Square(n)
    }
    fn side(&self) -> u32 {
        self.0
    }
}

impl Area for Square {
    fn area(&self) -> u32 {
        self.0 * self.0
    }
}

pub(crate) static LIMIT: u32 = 3;

pub fn helper(a: u32, b: u32) -> u32 {
    // sums
    a + b
}

pub fn copy(a: u32, b: u32) -> u32 {
    a + b
}
