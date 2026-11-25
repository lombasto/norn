// shapes: definitions for the symbol fixture (no imports)
export class Shape {
  constructor(n) {
    this.n = n;
  }
  area() {
    return 0;
  }
  static of(n) { return new Shape(n); }
}

class Square extends Shape {
  area() {
    return this.n * this.n;
  }
}

export const double = (x) => x * 2;
const twice = (x) => x * 2;

function helper(a, b) {
  // sums
  return a + b;
}

function copy(a, b) {
  return a + b;
}

let counter = copy(0, 0);
export { Square, helper, counter, twice };
