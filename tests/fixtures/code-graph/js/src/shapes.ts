export interface Sized {
  size(): number;
}

export enum Tone {
  Light,
  Dark,
}

export abstract class Base implements Sized {
  abstract size(): number;
  label = (): string => 'base';
}

namespace Inner {
  export function deep(): number {
    return 1;
  }
}
