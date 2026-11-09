"""Summarise annotator sessions: effort and interaction metrics from the logs, and how far the annotations moved
from the original Opus annotation (accepted / edited / deleted / added, with edit sizes) from the saved versions.

    ~/miniforge3/envs/viewer/bin/python annotator/analyze.py                 # every scene with logs or saves
    ~/miniforge3/envs/viewer/bin/python annotator/analyze.py --scene gTV8FGcVJC9 --idle 60
    ~/miniforge3/envs/viewer/bin/python annotator/analyze.py --notes > notes.md    # every note, as a Markdown list
    ~/miniforge3/envs/viewer/bin/python annotator/analyze.py --out /project/3dlg-hcvc/3darch/outputs/annotator --report-dir /tmp/r

Writes outputs/annotator/<scene>/report.json next to the logs (or under --report-dir), with the notes.

Active time. A gap between two consecutive user events counts as work up to --idle seconds (thinking time); longer
gaps count --idle at most (the rest is AFK), and time while the tab is hidden or the window is in the background
counts nothing. Logs from schema version 3 have a 1 s activity tick whenever there is any input, so the gaps are short
and the context of every second is known (selected element, tool, view); older logs use their other events.
Each active stretch is attributed to the context at its start, and each command to the active time since the previous
command or the selection of its element, whichever is later: "how long did this kind of edit take".
"""
import argparse
import json
import math
import statistics
from collections import Counter, defaultdict
from pathlib import Path

from server import OUT, scenes

KINDS = {"walls": "wall", "openings": "opening", "floors": "floor", "ceilings": "ceiling", "rooms": "room", "stairs": "stair",
         "columns": "column", "bulkheads": "bulkhead", "beams": "beam", "screens": "screen", "builtins": "builtin",
         "railings": "railing", "skylights": "skylight", "separators": "separator", "unscanned_spaces": "unscanned"}


def load_jsonl(path):
    out = []
    for line in open(path):
        line = line.strip()
        if line:
            out.append(json.loads(line))
    return sorted(out, key=lambda e: (e.get("dt", 0), e.get("seq", 0)))


def active_ms(events, idle_s):
    """Sum of gaps between consecutive events, each gap capped at the idle threshold (idle time is not work)."""
    total = 0
    for a, b in zip(events, events[1:]):
        total += min(b["dt"] - a["dt"], idle_s * 1000)
    return total


NOT_ACTIVITY = {"idle_start", "session_start", "scene_loaded", "queue_build"}     # timers and startup, not the user


def timeline(ev, bridge_s):
    """Active stretches [(dt_ms, ms, state)] of a session; state = what was selected / which tool / view at the time."""
    st = {"sel": None, "kind": None, "tool": "translate", "view": "3d", "busy": None, "camera": False}
    away, prev, out = False, None, []
    for e in ev:
        t = e["type"]
        if t in NOT_ACTIVITY or (t == "save" and e.get("autosave")):
            continue
        if prev is not None and not away:
            gap = e["dt"] - prev
            if gap > 0:
                out.append((prev, min(gap, bridge_s * 1000), dict(st)))
        # the state from now on
        if t in ("window_blur",) or (t == "visibility" and e.get("state") == "hidden"):
            away = True
        elif t in ("window_focus",) or (t == "visibility" and e.get("state") == "visible"):
            away = False
        elif t == "tick":
            away = not e.get("vis", 1) or not e.get("foc", 1)
            st.update(sel=e.get("sel"), kind=e.get("kind"), tool=e.get("tool"), view=e.get("view"), busy=e.get("busy"), camera=False)
        elif t == "select":
            st.update(sel=e.get("id"), kind=e.get("kind") or st["kind"])
        elif t == "deselect":
            st.update(sel=None, kind=None)
        elif t == "mode":
            st["tool"] = e.get("mode") if e.get("mode") != "select" else st.get("gizmo", "translate")
        elif t == "view" and e.get("what") == "gizmo_mode":
            st["tool"] = st["gizmo"] = e.get("value")
        elif t == "view" and e.get("what") in ("view", "plan"):
            st["view"] = e.get("value") if e.get("what") == "view" else ("plan" if e.get("value") else "3d")
        st["camera"] = t in ("camera", "camera_start")
        prev = e["dt"]
    return out


def task_times(ev, bridge_s):
    """Where the active time went: by element type / tool / view, per command (editing task) and per element."""
    tl = timeline(ev, bridge_s)
    by = {k: Counter() for k in ("kind", "tool", "view")}
    camera_ms = 0
    for _, ms, st in tl:
        by["kind"][st["kind"] or "(nothing selected)"] += ms
        by["tool"][st["tool"] or "?"] += ms
        by["view"][st["view"] or "?"] += ms
        camera_ms += ms if st["camera"] else 0
    # active ms up to each event, to split it between tasks
    cum, acc, i = {}, 0, 0
    for e in ev:
        while i < len(tl) and tl[i][0] < e["dt"]:
            acc += tl[i][1]; i += 1
        cum[e["seq"] if "seq" in e else id(e)] = acc
    key = lambda e: cum[e["seq"] if "seq" in e else id(e)]
    tasks, per_el, mark, sel_mark, cur = [], defaultdict(float), 0, 0, None
    for e in ev:
        if e["type"] == "select":
            if e.get("id") != cur:
                cur, sel_mark = e.get("id"), key(e)
        elif e["type"] == "deselect":
            cur, sel_mark = None, key(e)
        elif e["type"] == "cmd":
            a = e.get("action")
            op = op_of(e) if e.get("detail") or e.get("op") else "?"
            name = op if a == "do" else f"{a}:{op}"
            start = max(mark, sel_mark)
            secs = (key(e) - start) / 1000
            tasks.append({"op": name, "s": round(secs, 1), "ids": e.get("ids", [])[:3], "input": e.get("input"), "drag_ms": e.get("duration_ms")})
            for i_ in e.get("ids", [])[:1]:
                per_el[i_] += secs
            mark = key(e)
    ops = defaultdict(list)
    for t in tasks:
        ops[t["op"]].append(t["s"])
    op_summary = {k: {"n": len(v), "median_s": round(statistics.median(v), 1), "mean_s": round(statistics.mean(v), 1), "total_s": round(sum(v), 1)}
                  for k, v in sorted(ops.items(), key=lambda kv: -sum(kv[1]))}
    total = sum(ms for _, ms, _ in tl)
    sec = lambda c: {k: round(v / 1000, 1) for k, v in c.most_common()}
    # how much the total depends on the thinking-time allowance (with 1 s ticks, a gap means no input at all)
    sens = {f"{b}s": round(sum(ms for _, ms, _ in timeline(ev, b)) / 1000, 1) for b in (5, 15, 30, 60)}
    return {"active_s": round(total / 1000, 1), "active_s_by_allowance": sens, "camera_s": round(camera_ms / 1000, 1),
            "active_s_by_selected_kind": sec(by["kind"]), "active_s_by_tool": sec(by["tool"]), "active_s_by_view": sec(by["view"]),
            "edit_time_by_op": op_summary, "edit_time_by_element_top": {k: round(v, 1) for k, v in sorted(per_el.items(), key=lambda kv: -kv[1])[:15]},
            "tasks": tasks}


def flatten_cmd(detail):
    if detail.get("op") == "batch":
        for c in detail["cmds"]:
            yield from flatten_cmd(c)
    else:
        yield detail


HANDLE_OPS = {"start": "wall.move_end", "end": "wall.move_end", "move": "wall.translate", "faceL": "wall.move_face",
              "faceR": "wall.move_face", "top": "wall.set_top", "j0": "opening.resize", "j1": "opening.resize",
              "sill": "opening.resize", "head": "opening.resize", "body": "opening.translate"}


def op_of(e):
    """Structured operation of a logged command: the `op` field (schema_version >= 2), derived for older logs."""
    if e.get("op"):
        return e["op"]
    via = e.get("via") or ""
    leaves = [c for c in flatten_cmd(e["detail"]) if c.get("op") != "review"] or list(flatten_cmd(e["detail"]))
    first = leaves[0] if leaves else {}
    kind = first.get("kind", "?")
    if leaves and all(c.get("op") == "delete" for c in leaves):
        return f"{leaves[-1]['kind']}.delete"   # dependents (a wall's openings) are deleted before the element itself
    if via.startswith("handle:"):
        return HANDLE_OPS.get(via.split(":", 1)[1], f"{kind}.edit")
    if first.get("op") == "review":
        return "review.note" if via == "note" else "review.set"
    if via == "panel":
        return f"{kind}.delete" if first.get("op") == "delete" else f"{kind}.set_field"
    if via == "nudge":
        return f"{kind}.translate"
    if via == "snap_scan":
        return "wall.snap_to_scan"
    if via.startswith("tool:"):
        return {"tool:paste": "opening.paste", "tool:add-wall": "wall.add"}.get(via, "opening.add")
    if first.get("op") in ("add", "delete"):
        return f"{kind}.{first['op']}"
    return f"{kind}.edit"


def session_metrics(path, idle_s):
    ev = load_jsonl(path)
    start = next((e for e in ev if e["type"] == "session_start"), {})
    types = Counter(e["type"] for e in ev)
    cmds = [e for e in ev if e["type"] == "cmd"]
    done = [e for e in cmds if e["action"] == "do"]
    ops = Counter(op_of(e) for e in done)
    derived_ops = sum(1 for e in done if not e.get("op"))
    via = Counter((e.get("via") or "?").split(":")[0] for e in done)
    via_detail = Counter(e.get("via") or "?" for e in done)
    drags = [e for e in ev if e["type"] == "drag_end"]
    effective_drags = [d for d in drags if d.get("changed")]
    snaps = Counter((d.get("snap") or {}).get("type") for d in effective_drags if d.get("snap"))
    reviews, auto_reviews = Counter(), Counter()   # explicit decisions vs statuses set automatically by edits
    for e in done:
        for c in flatten_cmd(e["detail"]):
            if c.get("op") == "review" and c.get("after"):
                (auto_reviews if c.get("via") == "auto" else reviews)[c["after"]] += 1
    cam = []
    t0 = None
    for e in ev:
        if e["type"] == "camera_start":
            t0 = e["dt"]
        elif e["type"] == "camera_end" and t0 is not None:
            cam.append(e["dt"] - t0)
            t0 = None
    tt = task_times(ev, idle_s)
    act = tt["active_s"] * 1000
    handle_cmds = [e for e in done if e.get("input") in ("box_handle", "shape_handle", "gumball", "handle")]
    evidence = Counter()
    for e in done:
        for c in flatten_cmd(e["detail"]):
            if c.get("op") == "review" and c.get("evidence_after") and c.get("evidence_after") != c.get("evidence_before"):
                evidence[c["evidence_after"]] += 1
    ticks = [e for e in ev if e["type"] == "tick"]
    touched = {i for e in done for i in e.get("ids", [])}
    selects = [e for e in ev if e["type"] == "select"]
    snap_scan = [e for e in ev if e["type"] == "snap_scan"]
    return {
        "session": path.stem,
        "annotator": start.get("annotator"),
        "scene": start.get("scene"),
        "loaded_version": start.get("version"),
        "tool_version": start.get("tool_version"),
        "events": len(ev),
        "duration_min": round((ev[-1]["dt"] - ev[0]["dt"]) / 60000, 2) if ev else 0,
        "active_min": round(act / 60000, 2),
        "idle_periods": types.get("idle_start", 0),
        "commands": len(done),
        "commands_by_op": dict(ops.most_common()),
        "ops_derived_from_old_log_fields": derived_ops,
        "undone_by_op": dict(Counter(op_of(e) for e in cmds if e["action"] == "undo")),
        "commands_by_input": dict(via),
        "commands_by_input_detail": dict(via_detail.most_common()),
        "undo": types and sum(1 for e in cmds if e["action"] == "undo"),
        "redo": sum(1 for e in cmds if e["action"] == "redo"),
        "undo_rate": round(sum(1 for e in cmds if e["action"] == "undo") / max(len(done), 1), 3),
        "activity_ticks": len(ticks),
        "away_periods": sum(1 for e in ev if e["type"] == "window_blur" or (e["type"] == "visibility" and e.get("state") == "hidden")),
        "handle_drags": len(handle_cmds), "handle_drag_median_ms": statistics.median([e["duration_ms"] for e in handle_cmds if e.get("duration_ms")]) if any(e.get("duration_ms") for e in handle_cmds) else None,
        "cancelled": sum(1 for e in cmds if e.get("action") == "cancel"),
        "evidence_ratings": dict(evidence),
        "time": {k: v for k, v in tt.items() if k != "tasks"}, "tasks": tt["tasks"],
        "drags": len(drags),
        "drags_without_change": len(drags) - len(effective_drags),
        "drag_median_ms": statistics.median([d["ms"] for d in drags]) if drags else None,
        "snapped_drag_share": round(sum(snaps.values()) / max(len(effective_drags), 1), 3),
        "snap_types": dict(snaps),
        "snap_to_scan": {"uses": len(snap_scan), "applied": sum(1 for e in snap_scan if e.get("ok") and e.get("changed"))},
        "review_decisions": dict(reviews),
        "auto_review_marks": dict(auto_reviews),
        "elements_touched": len(touched),
        "active_s_per_touched_element": round(act / 1000 / max(len(touched), 1), 1),
        "selections": len(selects),
        "selection_via": dict(Counter(e.get("via") for e in selects)),
        "click_cycles": sum(1 for e in selects if (e.get("cycle") or 0) > 0),
        "camera_moves": len(cam),
        "camera_time_share": round(tt["camera_s"] * 1000 / max(act, 1), 3),
        "views": dict(Counter(f"{e.get('what')}={e.get('value')}" for e in ev if e["type"] == "view")),
        "keys": dict(Counter(e.get("key") for e in ev if e["type"] == "key").most_common(15)),
        "saves": types.get("save", 0),
        "errors": [e.get("message") for e in ev if e["type"] == "error"],
    }


def dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def edit_sizes(kind, orig, now):
    """Size of each edit relative to the original record, in metres (walls, openings, beams; others: none)."""
    g = lambda r, *ks: [r.get(k) for k in ks]
    if kind == "wall" and orig.get("shape") == "arc" and now.get("arc"):
        a0, a1 = orig["arc"], now["arc"]
        return {"end_shift_max": round(dist(a0["center"], a1["center"]), 4),
                "radius_delta": round(a1["radius_axis"] - a0["radius_axis"], 4),
                "thickness_delta": round((a1["r_outer"] - a1["r_inner"]) - (a0["r_outer"] - a0["r_inner"]), 4),
                "top_delta": round(now["top_z"] - orig["top_z"], 4)}
    if kind in ("wall", "screen"):
        return {
            "end_shift_max": round(max(dist(orig["axis"]["start"], now["axis"]["start"]), dist(orig["axis"]["end"], now["axis"]["end"])), 4),
            "thickness_delta": round(now["thickness"] - orig["thickness"], 4),
            "top_delta": round(now["top_z"] - orig["top_z"], 4),
            "category": None if orig.get("category") == now.get("category") else [orig.get("category"), now.get("category")],
        }
    if kind == "beam":
        return {"end_shift_max": round(max(dist(orig["axis"]["start"], now["axis"]["start"]), dist(orig["axis"]["end"], now["axis"]["end"])), 4),
                "width_delta": round((now.get("width") or 0) - (orig.get("width") or 0), 4), "depth_delta": round((now.get("depth") or 0) - (orig.get("depth") or 0), 4),
                "bottom_delta": round((now.get("bottom_z") or 0) - (orig.get("bottom_z") or 0), 4)}
    if kind == "opening":
        p0, p1 = orig["position"], now["position"]
        return {
            "jamb_shift_max": round(max(abs(p1["u_start"] - p0["u_start"]), abs(p1["u_end"] - p0["u_end"])), 4),
            "width_delta": round((p1["u_end"] - p1["u_start"]) - (p0["u_end"] - p0["u_start"]), 4),
            "sill_delta": round(now["sill_z"] - orig["sill_z"], 4),
            "head_delta": round(now["head_z"] - orig["head_z"], 4),
            "type": None if orig.get("type") == now.get("type") else [orig.get("type"), now.get("type")],
            "rehosted": orig.get("host_wall") != now.get("host_wall"),
        }
    return {}


def save_metrics(path, original):
    doc = json.load(open(path))
    tool = doc.get("annotation_tool", {})
    review = tool.get("review", {})
    orig_ids, now_ids = {}, {}
    for key, kind in KINDS.items():
        for r in original.get(key, []):
            orig_ids[r["id"]] = (kind, r)
        for r in doc.get(key, []):
            now_ids[r["id"]] = (kind, r)
    outcome = defaultdict(Counter)
    sizes = defaultdict(list)
    for i, (kind, r0) in orig_ids.items():
        st = (review.get(i) or {}).get("status")
        if i not in now_ids:
            outcome[kind]["deleted"] += 1
            continue
        changed = i in tool.get("changes", {}).get("edited", {})
        if changed:
            outcome[kind]["edited"] += 1
            sizes[kind].append({"id": i, **edit_sizes(kind, r0, now_ids[i][1])})
        elif (review.get(i) or {}).get("evidence"):
            outcome[kind]["rated_unchanged"] += 1
        elif st == "ok":                                   # older saves: correct / wrong / unsure decisions
            outcome[kind]["accepted"] += 1
        elif st == "wrong":
            outcome[kind]["marked_wrong_kept"] += 1
        elif st == "unsure":
            outcome[kind]["unsure"] += 1
        else:
            outcome[kind]["not_reviewed"] += 1
    evidence = defaultdict(Counter)                        # how much of each kept / added element the editor based on the scan
    for i, (kind, _) in now_ids.items():
        if i not in orig_ids:
            outcome[kind]["added"] += 1
        evidence[kind][(review.get(i) or {}).get("evidence") or "not_rated"] += 1
    summary = {}
    for kind, s in sizes.items():
        key = "end_shift_max" if kind in ("wall", "screen", "beam") else "jamb_shift_max" if kind == "opening" else None
        vals = [abs(x[key]) for x in s if key and x.get(key) is not None]
        if vals:
            summary[kind] = {"edits": len(vals), "median_m": round(statistics.median(vals), 4), "max_m": round(max(vals), 4)}
    return {
        "save": path.stem, "annotator": tool.get("annotator"), "saved_at": tool.get("saved_at"),
        "outcome_by_kind": {k: dict(v) for k, v in outcome.items()},
        "evidence_by_kind": {k: dict(v) for k, v in evidence.items()},
        "edit_size_summary": summary, "edits": {k: v for k, v in sizes.items()},
        "levels_checked_for_missing": sorted(tool.get("levels_checked", {})),
    }


def all_notes(saves):
    """Every note in the saves (a note is in each later save too: keep its latest copy), oldest first."""
    seen = {}
    for p in saves:
        try:
            for n in json.load(open(p)).get("annotation_tool", {}).get("notes", []) or []:
                seen[n["id"]] = n
        except (OSError, ValueError, KeyError):
            continue
    return sorted(seen.values(), key=lambda n: n.get("at", ""))


def notes_markdown(SCENES, out_dir=OUT):
    """All notes of all scenes as Markdown (for the list of things that are hard or impossible to do)."""
    cats = {"hard": "hard to do", "impossible": "impossible", "wrong": "wrong, can't fix", "bug": "tool bug", "other": "other"}
    out = ["# Annotator notes", ""]
    for scene in sorted(SCENES):
        d = out_dir / scene / "saves"
        notes = all_notes(sorted(d.glob("*.json"), key=lambda p: p.stat().st_mtime)) if d.is_dir() else []
        if not notes:
            continue
        out += [f"## {scene} ({SCENES[scene]['label']})", ""]
        for n in notes:
            els = f" ({', '.join(n.get('elements') or [])})" if n.get("elements") else ""
            out.append(f"- **{cats.get(n.get('category'), n.get('category'))}**{els}: {n.get('text', '').strip()} "
                       f"*[{n.get('by', '?')}, {str(n.get('at', ''))[:16].replace('T', ' ')} UTC, tool: {n.get('mode', '?')}]*")
        out.append("")
    return "\n".join(out)


def main():
    SCENES = scenes()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scene", choices=sorted(SCENES))
    ap.add_argument("--idle", type=float, default=30, help="longest gap (s) between user events that still counts as work")
    ap.add_argument("--out", type=Path, default=OUT, help="where the scenes' logs/ and saves/ are (default: %(default)s)")
    ap.add_argument("--report-dir", type=Path, default=None, help="write report.json files here instead of next to the logs")
    ap.add_argument("--notes", action="store_true", help="print every note (all scenes) as Markdown and stop")
    a = ap.parse_args()
    if a.notes:
        print(notes_markdown(SCENES, a.out))
        return
    for scene in [a.scene] if a.scene else sorted(SCENES):
        d = a.out / scene
        logs = sorted((d / "logs").glob("*.jsonl")) if (d / "logs").is_dir() else []
        saves = sorted((d / "saves").glob("*.json"), key=lambda p: p.stat().st_mtime) if (d / "saves").is_dir() else []
        if not logs and not saves:
            continue
        original = json.load(open(SCENES[scene]["annotation"]))
        report = {"scene": scene, "idle_threshold_s": a.idle,
                  "sessions": [session_metrics(p, a.idle) for p in logs],
                  "saves": [save_metrics(p, original) for p in saves],
                  "notes": all_notes(saves)}
        rd = (a.report_dir / scene) if a.report_dir else d
        rd.mkdir(parents=True, exist_ok=True)
        (rd / "report.json").write_text(json.dumps(report, indent=1))
        print(f"\n=== {scene}: {len(logs)} sessions, {len(saves)} saves -> {rd / 'report.json'}")
        for s in report["sessions"]:
            print(f"- session {s['session']} ({s['annotator']}): {s['active_min']} active min of {s['duration_min']}, "
                  f"{s['commands']} commands {s['commands_by_op']}, undo rate {s['undo_rate']}, "
                  f"handle drags {s['handle_drags']}, cancelled {s['cancelled']}, evidence ratings {s['evidence_ratings']}, "
                  f"{s['active_s_per_touched_element']} s per touched element, "
                  f"camera {s['camera_time_share']:.0%} of active time, errors {len(s['errors'])}")
        if saves:
            last = report["saves"][-1]
            print(f"- latest save {last['save']} ({last['annotator']}): outcomes {last['outcome_by_kind']}")
            print(f"  evidence {last['evidence_by_kind']}")
            print(f"  edit sizes {last['edit_size_summary']}; levels checked for missing: {last['levels_checked_for_missing'] or 'none'}")
        if report["notes"]:
            print(f"- notes: {len(report['notes'])} ({dict(Counter(n.get('category') for n in report['notes']))}); --notes prints them")


if __name__ == "__main__":
    main()
