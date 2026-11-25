"""Shapes: definitions for the symbol fixture."""

LIMIT = 3


class Shape:
    """A shape."""

    def __init__(self, n):
        self.n = n

    @property
    def area(self):
        return 0

    def _hidden(self):
        return None


def helper(a, b):
    # sums
    return a + b


def copy(a, b):
    return a + b


def outer():
    def inner():
        return 1

    return inner
