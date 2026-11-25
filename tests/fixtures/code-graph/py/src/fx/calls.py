"""Calls: one call site of each how class of the call table (SPEC code-graph 4.2)."""
import os

from fx import shapes
from fx.shapes import Shape, helper


def near():
    return 1


class Walker(Shape):
    def step(self):
        return near()

    def walk(self):
        self.step()
        return self._hidden()


class Runner:
    def step(self):
        return 2


def main(x):
    helper(1, 2)
    shapes.copy(3, 4)
    Walker.walk(x)
    x.walk()
    x.step()
    os.getcwd()
    len(x)
    ghost()
    return Walker(1)
