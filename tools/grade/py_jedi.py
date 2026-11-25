"""The Python definition and call-edge grader of the code graph (SPEC code-graph section 5, stage S4b): jedi 0.20.1.

`norn-code grade calls` runs it with uv's pinned Python and jedi from tools/grade/jedi.lock.txt (hashes):
`uv run --no-project --python <python> --with-requirements jedi.lock.txt python py_jedi.py <in> <out>`.
In: { root, sites: [{ id, file, line, col, roots }], def_files: [{ file, roots }] } (col: the callee name's 1-based UTF-8 byte
column; roots: the import roots norn-code declares for the file, root-relative, '' the repo root). Out: { results: [{ id, targets:
[{ file, line, name }], outside } | { id, na }], defs: { file: [{ name, type, line, start, end }] } }:
- a site: `Script.goto(follow_imports=True)` at the callee name; each in-repo answer's file and name line (outside: how many
  answers lie outside the repo: builtins, the stdlib, packages);
- a file's definitions: every `def` / `class` statement's name (`get_names(all_scopes=True)`, the names imports and assignments
  bind left out), its line and its definition's start / end lines (`get_definition_start_position` / `get_definition_end_position`).
jedi infers in this process (InterpreterEnvironment): no project code runs, nothing is imported from the repo.
"""
import json
import os
import sys

import jedi

src, dst = sys.argv[1], sys.argv[2]
with open(src, encoding="utf-8") as f:
    inp = json.load(f)
ROOT = os.path.realpath(inp["root"])
ENV = jedi.InterpreterEnvironment()
_projects, _code = {}, {}


def rel(p):
    """an absolute path -> repo-relative with '/' (None outside the repo)"""
    if p is None:
        return None
    r = os.path.relpath(os.path.realpath(str(p)), ROOT)
    return None if r.startswith("..") or os.path.isabs(r) else r.replace(os.sep, "/")


def project(roots):
    key = tuple(roots)
    if key not in _projects:
        paths = [os.path.join(ROOT, r) if r else ROOT for r in roots]
        _projects[key] = jedi.Project(ROOT, added_sys_path=paths, smart_sys_path=False)
    return _projects[key]


def script(file, roots):
    if file not in _code:
        with open(os.path.join(ROOT, file), encoding="utf-8", errors="replace") as f:
            _code[file] = f.read()
    return jedi.Script(_code[file], path=os.path.join(ROOT, file), project=project(roots), environment=ENV)


def char_col(file, line, col):
    """a 1-based UTF-8 byte column -> jedi's 0-based character column"""
    text = _code[file].split("\n")[line - 1] if file in _code else ""
    return len(text.encode("utf-8")[: col - 1].decode("utf-8", errors="ignore"))


results = []
for s in inp["sites"]:
    try:
        sc = script(s["file"], s["roots"])
        names = sc.goto(s["line"], char_col(s["file"], s["line"], s["col"]), follow_imports=True)
        targets, outside = [], 0
        for n in names:
            r = rel(n.module_path)
            if r is None or n.line is None:
                outside += 1
            else:
                targets.append({"file": r, "line": n.line, "name": n.name, "type": n.type})
        if not targets and not outside:
            results.append({"id": s["id"], "na": "jedi found no definition"})
        else:
            results.append({"id": s["id"], "targets": targets, "outside": outside})
    except Exception as e:  # one site jedi cannot infer is n/a, never a guess
        results.append({"id": s["id"], "na": f"jedi: {type(e).__name__}: {str(e).splitlines()[0] if str(e) else ''}"})

defs = {}
for d in inp.get("def_files", []):
    try:
        rows = []
        for n in script(d["file"], d["roots"]).get_names(all_scopes=True, definitions=True, references=False):
            if n.type not in ("function", "class"):
                continue
            # a def / class statement of its own name only: get_names also lists the names an import or an assignment binds
            tn = getattr(n._name, "tree_name", None)
            node = tn.get_definition() if tn is not None else None
            if node is None or node.type not in ("funcdef", "classdef") or node.name is not tn:
                continue
            a, b = n.get_definition_start_position(), n.get_definition_end_position()
            if a is None or b is None:
                continue
            # an end at column 0 is the line before (the newline closing the body), as norn-code's bounds read it
            end = b[0] - 1 if b[1] == 0 and b[0] > a[0] else b[0]
            rows.append({"name": n.name, "type": n.type, "line": n.line, "start": a[0], "end": end})
        defs[d["file"]] = rows
    except Exception as e:
        defs[d["file"]] = {"na": f"jedi: {type(e).__name__}"}

with open(dst, "w", encoding="utf-8") as f:
    json.dump({"results": results, "defs": defs}, f)
