// calls: one call site of each how class of the call table (SPEC code-graph 4.2)
import { helper, Shape } from './shapes.mjs';
import * as shapes from './shapes.mjs';
import fs from 'node:fs';

function near() {
  return 1;
}

class Walker extends Shape {
  step() {
    return near();
  }
  walk() {
    this.step();
    return this.area();
  }
}

export function main(x) {
  helper(1, 2);
  shapes.copy(3, 4);
  Shape.of(2);
  x.walk();
  x.area();
  fs.readFileSync('a');
  JSON.stringify(x);
  ghost();
  return new Walker(1);
}
