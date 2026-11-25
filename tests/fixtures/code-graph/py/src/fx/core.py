from typing import TYPE_CHECKING
from . import helpers
from .models import Model
import common
import fx_native._fast
import _accel
import numpy as np
import fx.missing
from extra import tools

if TYPE_CHECKING:
    from fx.models import Model


def later():
    import json
    return json
