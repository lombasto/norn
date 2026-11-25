"""The Python file-edge grader of the code graph (SPEC code-graph section 5, stage S4a): the stdlib's PathFinder, step by step.

`norn-code grade files` runs it with uv's pinned Python (tools/grade/manifest.json): `py_find.py <in> <out>`.
In: { root, sites: [{ id, from, line, roots }] } (roots: the import roots norn-code declares for that file, root-relative, '' the
repo root, in search order). Out: { results: [{ id, modules: [file], inits: [file] } | { id, na }] }: for the import statement(s)
at that line, the files the imported modules are (a namespace package: its folder) and the ancestor packages' __init__ files.
Only the finder is asked (importlib.machinery.PathFinder.find_spec): no module code runs. A stdlib or builtin top-level name is
outside the repo (on sys.path the stdlib comes before the project roots), and so is anything the roots do not hold.
"""
import ast
import json
import os
import sys
from importlib.machinery import PathFinder

src, dst = sys.argv[1], sys.argv[2]
with open(src, encoding="utf-8") as f:
    inp = json.load(f)
ROOT = os.path.realpath(inp["root"])
STD = set(sys.stdlib_module_names) | set(sys.builtin_module_names)
_trees = {}


def rel(p):
    """an absolute path -> repo-relative with '/' (None outside the repo)"""
    r = os.path.relpath(os.path.realpath(p), ROOT)
    return None if r.startswith("..") or os.path.isabs(r) else r.replace(os.sep, "/")


def tree(f):
    if f not in _trees:
        try:
            with open(os.path.join(ROOT, f), "rb") as h:
                _trees[f] = ast.parse(h.read())
        except (SyntaxError, ValueError, OSError):
            _trees[f] = None
    return _trees[f]


def where(spec):
    """a spec -> its file (a namespace package: its folder), repo-relative or None"""
    if spec.origin and spec.origin not in ("namespace", "built-in", "frozen"):
        return rel(spec.origin)
    locs = list(spec.submodule_search_locations or [])
    return rel(locs[0]) if locs else None


def chain(parts, paths):
    """find a.b.c one step at a time from `paths` -> [spec of a, spec of a.b, ...] for as far as it is found"""
    out, name = [], ""
    for p in parts:
        name = f"{name}.{p}" if name else p
        s = PathFinder.find_spec(name, paths)
        if s is None:
            break
        out.append(s)
        paths = list(s.submodule_search_locations or [])
        if not paths and p != parts[-1]:
            break
    return out


def package_dir(f):
    """the folder a relative import of file f starts from (its package)"""
    return os.path.dirname(os.path.join(ROOT, f))


def resolve(f, node, roots):
    modules, inits = [], []

    def take(specs, want):
        if len(specs) == want:
            modules.append(where(specs[-1]))
            inits.extend(where(s) for s in specs[:-1] if s.origin and s.origin.endswith("__init__.py"))
        else:
            inits.extend(where(s) for s in specs if s.origin and s.origin.endswith("__init__.py"))

    paths = [os.path.join(ROOT, r) if r else ROOT for r in roots]
    if isinstance(node, ast.Import):
        for a in node.names:
            parts = a.name.split(".")
            if parts[0] in STD:
                continue
            take(chain(parts, paths), len(parts))
        return modules, inits
    parts = node.module.split(".") if node.module else []
    if node.level:
        base = package_dir(f)
        for _ in range(node.level - 1):
            base = os.path.dirname(base)
        specs, at = [], [base]
        for p in parts:
            s = PathFinder.find_spec(p, at)
            if s is None:
                break
            specs.append(s)
            at = list(s.submodule_search_locations or [])
        found = len(specs) == len(parts)
        locs = at if found else []
        names = [a.name for a in node.names if a.name != "*"]
        subs = [PathFinder.find_spec(n, locs) if locs else None for n in names]
        hit = [s for s in subs if s is not None]
        if hit:
            modules.extend(where(s) for s in hit)
        if found and (len(hit) < len(names) or not names) and specs:
            modules.append(where(specs[-1]))
        if not parts and not hit:
            init = os.path.join(base, "__init__.py")
            if os.path.isfile(init):
                modules.append(rel(init))
        return modules, inits
    if not parts or parts[0] in STD:
        return modules, inits
    specs = chain(parts, paths)
    if len(specs) < len(parts):
        take(specs, len(parts))
        return modules, inits
    locs = list(specs[-1].submodule_search_locations or [])
    names = [a.name for a in node.names if a.name != "*"]
    hit = [s for s in (PathFinder.find_spec(f"{node.module}.{n}", locs) if locs else None for n in names) if s is not None]
    if hit:
        modules.extend(where(s) for s in hit)
        inits.extend(where(s) for s in specs if s.origin and s.origin.endswith("__init__.py"))
    if len(hit) < len(names) or not names:
        take(specs, len(parts))
    return modules, inits


def grade(site):
    t = tree(site["from"])
    if t is None:
        return {"id": site["id"], "na": "python could not parse the file"}
    nodes = [
        n
        for n in ast.walk(t)
        if isinstance(n, (ast.Import, ast.ImportFrom)) and n.lineno <= site["line"] <= (n.end_lineno or n.lineno)
    ]
    if not nodes:
        return {"id": site["id"], "na": "no import statement at that line"}
    modules, inits = [], []
    for n in nodes:
        m, i = resolve(site["from"], n, site["roots"])
        modules += m
        inits += i
    return {"id": site["id"], "modules": sorted({x for x in modules if x}), "inits": sorted({x for x in inits if x})}


with open(dst, "w", encoding="utf-8") as f:
    json.dump({"results": [grade(s) for s in inp["sites"]]}, f)
