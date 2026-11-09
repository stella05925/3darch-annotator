# Architecture annotator (prototype v0.3)

A browser tool for reviewing and correcting a parametric architecture annotation over the Matterport scan.

**Principle:** every edit writes parametric fields of the scene JSON (wall axis, thickness, base / top, opening u
range, sill / head, polygons, ...). Meshes are never edited; they are always rebuilt from the JSON.

## Scenes

A scene is one annotation JSON in `data/annotations/` plus the scan of its Matterport house in `data/scans/`. The
server looks the folder up on every page load, so a new file shows up in the scene menu without a restart.

Neither is in the git repository (the scans are Matterport3D-derived and cannot be redistributed). After a clone,
copy the annotations from the lab's shared copy (`/project/3dlg-hcvc/3darch/annotator/data/annotations/`) or add your
own (below), and make the scans with `tools/make_scan.py`.

| Scene | What it is |
|---|---|
| `gTV8FGcVJC9` / `gTV8FGcVJC9_v2` | multi-level hillside house (sandbox): first pass, improvement pass |
| `17DRP5sb8fy` · `HxpKQynjfin` · `GdvgFV5R1Z5` | hotel suite · cruise-ship cabin · yurt, hand-annotated (sandbox) |
| `17DRP5sb8fy_effort_low` · `GdvgFV5R1Z5_effort_low` | Claude at effort low (`~/3darch/low_effort_scenes`), to fix |

### Adding a scene yourself

1. Put the annotation (our format, e.g. a `<house>_architecture.json` from a sandbox run) in
   `data/annotations/<scene>.json`. The file name is the scene id: it must start with the 11-character Matterport
   house id, optionally followed by `_` and anything (`17DRP5sb8fy_effort_medium.json`). Letters, digits, `_ . -` only.
2. If `data/scans/<house>.glb` does not exist yet, make it on cs-3dlg-03 (it has Matterport3D; a few seconds). The
   script writes into the `data/scans/` next to it, so run the copy whose scenes you are adding:
   ```bash
   ~/miniforge3/envs/viewer/bin/python /project/3dlg-hcvc/3darch/annotator/tools/make_scan.py <house>   # shared copy
   ~/miniforge3/envs/viewer/bin/python ~/3darch/annotator/tools/make_scan.py <house>                    # local copy
   ```
3. Optionally give it a label in `data/scenes.json` (`{"<scene>": "Hotel suite · effort medium"}`); otherwise the
   menu shows the id.
4. Reload the page.

For the shared copy the folder is `/project/3dlg-hcvc/3darch/annotator/data/`; you can copy files there directly
(`cp` is fine; give them group write: `chmod g+w`). Scenes added there are kept by later deploys.

## Run

```bash
cd ~/3darch
~/miniforge3/envs/viewer/bin/python annotator/server.py          # http://127.0.0.1:8770/
```

The server uses only the Python standard library and listens on localhost. From VS Code, open the forwarded port
(Ports panel); from another machine, use `ssh -L 8770:localhost:8770 cs-3dlg-03`. Chrome or Firefox on a desktop.
A scene opens on its lowest level; `?scene=<id>&level=<level id>` opens another.

## Shared copy on /project, public at aspis.cs.sfu.ca/3darch-annotator/

`annotator/deploy.sh` copies the tool and `data/` to `/project/3dlg-hcvc/3darch/annotator/`. Run it again after
changing the code, then restart the server. It replaces the code, adds and updates scene data (never removes any) and
never touches saves. That copy writes saves and logs to `/project/3dlg-hcvc/3darch/outputs/annotator/`.

The lab's reverse proxy maps `https://aspis.cs.sfu.ca/3darch-annotator/` to port 8017 on aspis. The app uses only
relative URLs, and `run.sh` passes `--base /3darch-annotator`, so it works whether the proxy strips that prefix or
not. The proxy must allow request bodies up to 16 MB (saves of the hillside house are about 3 MB).

```bash
# once, on aspis: an access key (otherwise anyone with the address can read and save)
python3 -c "import secrets; print(secrets.token_urlsafe(16))" > ~/.annotator_key && chmod 600 ~/.annotator_key
tmux new -s annotator                                   # or: tmux attach -t annotator
/project/3dlg-hcvc/3darch/annotator/run.sh 8017         # Ctrl+B D detaches; Ctrl+C stops the server
```

Share `https://aspis.cs.sfu.ca/3darch-annotator/?key=<key>`; the browser remembers the key. Without a key file (or
`ANNOTATOR_KEY`) the server is open; it says which at startup.

## Using it

The screen: the scene, version, level and view (3D / Plan / Wall) at the top; Review, Elements and View tabs on the
left; the toolbar over the 3D view; the selected element's properties on the right. `?` lists every shortcut.

- **First visit:** enter your name. It only labels your saves and logs (no login; click it at the top right to change).
- **Review tab:** a queue of the level's elements (lowest Opus confidence first). Fix each element as needed, then
  rate how much of it, as it now stands, you could base on the scan: **Strong evidence** (Q: the scan shows it
  directly), **Partial evidence** (A: partly seen, the rest inferred) or **Assumption** (Z: not visible, placed from
  context). Rating moves on to the next element; the same three buttons are in the properties panel. The rating is
  stored per element (`annotation_tool.review[id].evidence`, with who / when) and kept when you edit the element
  later; edits still mark it *fixed*, deletions *wrong*. Colour by evidence in the View tab. Below: **Notes**.
- **Select:** click (again on the same spot: the element behind; an opening comes before its wall), Shift+click adds,
  Shift+drag in Plan or Wall view box-selects.
- **Views:** 3D; Plan (P); **Wall** (V): the selected wall seen straight on, with everything more than 0.5 m in front
  of or behind it cut away. Pan and zoom only; V again shows the other side. Openings are easiest to fix here.
- **Edit tools** (toolbar, second group; they act on the selection):
  - **Move** (W) and **Rotate** (E): the gumball. Only the arrows and rings the record can store appear (walls: along
    / across / up; openings: along the wall / up). Local or world axes (`.`); rotate pivot in the bar under the
    toolbar. Dragging an opening past its wall's end, or with Alt over another wall, moves it to that wall.
    Floors and ceilings move and turn too; a ceiling takes along the bulkheads whose undersides are its patches.
    Rotation about a horizontal axis (tilt): beams and rafters (pitch: a flat beam becomes one with a 3D axis),
    floors and the flat / sloped patches of ceilings (they become sloped planes; plan outlines stay; cone patches
    and bulkheads do not tilt). Walls, columns, screens, built-ins, openings,
    bulkheads and stairs are vertical by definition in the format, so they only turn about the vertical.
  - **Resize** (T): a dashed box around the element with one coloured handle per side (red: length, green:
    thickness / width, blue: height). Drag a handle and only that side moves; the opposite side stays, as in
    PowerPoint. Walls: either end, either face, top, base. Openings: either jamb, sill, head. Columns, built-ins,
    bulkheads, screens, beams: every side.
  - **Points** (Tab): the points that define the element. Outlines (rooms, floors, ceiling patches, columns,
    built-ins, bulkheads, unscanned areas) and lines (railings, separators): drag a white corner, drag a blue
    midpoint to add a corner, Alt+click a corner to delete it; a room's floor follows the room while their outlines
    are the same. Walls and screens: their two axis ends. Beams and rafters: their two ends (Alt+drag moves an end
    up or down). Round walls and skylights: their centre. Every element in the seven scenes has points except
    openings (a span of their wall: use Resize), stairs (generated from their flights), cone ceilings (a cone), and
    note-only bulkheads; the hint under the toolbar says which and why.
  - Dragging snaps within 10 screen pixels to wall ends, axes and faces, other corners, edges, sills and heads (the
    target is named next to the pointer); Ctrl turns snapping off; Shift gives 45° steps; Esc or right-click cancels.
  - Keyboard: G / R / S then X / Y / Z or U / N, then the mouse or a typed value (`0.05*2`, `=0.9`); Enter confirms.
    Arrow keys nudge 1 cm (Shift: 10 cm). Panel fields take arithmetic (`+0.05`, `*2`).
  - **Round walls** (the yurt) are edited through their arc: Move / Rotate the ring (rotating turns its openings
    with it); Resize: red = the radius (thickness kept), green = the outer or the inner face alone, blue = top / base;
    Points: the centre; the panel: centre, radii, thickness, heights. Their openings move along the ring and resize
    by angle (panel: start / end angle); + Door / + Window work on them too.
  - **Merge** (one undoable command; the merged-away records go to the trash): select two or more floors → *Merge
    floors* unites their outlines into the last one clicked (they must touch or overlap; the rooms are not changed).
    Select ceilings → *Merge ceilings* puts all their patches into the last one clicked; one ceiling → *Merge
    patches*. Either way, flat patches of the same kind within 2 cm in height that touch or overlap become one patch;
    sloped and cone patches and patches at other heights are kept.
  - Several selected: the panel offers align, distribute evenly and match properties. Shift+D duplicates and moves,
    Shift+R repeats the last transform.
- **Add tools** (third group): door, window, passage (click on a wall), wall (two clicks), **Shape** (6): draw a room
  (with its floor), column, built-in, bulkhead or unscanned area by clicking its corners; Enter, double-click or a click
  on the first corner finishes; Backspace removes the last corner. Ctrl+C / Ctrl+V copies an opening onto any wall.
- **Fit plane** (7): click a flat part of the scan; a plane is fitted to the surface around the click (Shift+click adds
  more surface; radius in the hint). The panel then lists what the plane can set on the selected element: a wall
  face (keeping the thickness and turning the wall, or moving only that face), a wall's top or base, a sill, head or
  jamb, a floor or ceiling patch height or slope, a column / built-in / bulkhead / beam top or bottom. A change of more
  than 15 cm asks first (a click on furniture instead of the floor).
- **Note** (N): write down something that is hard or impossible to do, with a kind (hard / impossible / wrong but
  can't fix / tool bug). The note keeps the view, level and selection; click it in the Review tab to go back there.
  `analyze.py --notes` prints every note of every scene as a Markdown list.
- **Delete** removes the selection from the view and the annotation, but it stays in the element list, struck
  through; click it there to **Restore** it (a wall with its openings, a room with its floor and ceiling).
- **Undo** (Ctrl+Z / Ctrl+Shift+Z): every edit is one command; undoing restores the JSON byte for byte.
- **View tab:** scan and annotation layers and opacity, colour by type / review / confidence / thickness source, one
  layer per element type the scene has.
- **Door / window details** (hinge, panes, ...) are not drawn: a move carries them along; a resize, rotation or
  re-host lists them in the element's `stale_detail` and the panel warns.

## Where the annotations are stored

Nothing is stored per person on the server except what you save. The name you type is kept in your browser
(localStorage) and written into every save and log line.

| Path (under `outputs/annotator/<scene>/`; on /project: `/project/3dlg-hcvc/3darch/outputs/annotator/`) | Content |
|---|---|
| `saves/<YYYYMMDD-HHMMSS>_<name>.json` (Ctrl+S, Save) | A new file every save: the whole annotation in our format plus `annotation_tool`: per-element `review`, `levels_checked`, `changes` against the original, `stale_detail`, `deleted` (the trash), `notes`. |
| `saves/autosave_<name>.json` | Overwritten every minute while there are unsaved changes. |
| `logs/<name>-<time>-<id>.jsonl` | One line per event of a browser session (edits, views, camera, keys, notes ...), posted every few seconds. |

After a save or autosave the page address names that version, so a reload reopens your work; opening a scene
without a version offers your latest save of it. An autosave left by an earlier session is never overwritten: it is
first kept as `<time>_<name>_autosave` (in the version menu). The original files in `data/annotations/` are never
changed. To continue from a save, pick it in the version menu
(top left). Two people on the same scene each get their own saves (named after them); there is no merging or locking.

Each completed edit is one `cmd` log event with `op` (e.g. `wall.scale_length`, `room.move_vertex`, `wall.fit_plane`),
the ids, `input` (gumball / box_handle / shape_handle / keyboard / numeric / panel / layout / fit_plane), the
constraint, snap targets, 10 Hz path samples and before / after values of the changed fields. A cancelled one is
logged with `cancelled: true`.

Low-level activity (log schema 3): every second with any input (pointer moves, presses, keys, wheel) or a drag in
progress writes a `tick` with the input counts, whether the tab is visible and focused, and the task context (selected
element and type, tool, view, level, element under the pointer, drag / keyboard transform / typing). Entering and
leaving a field writes `field_focus` / `field_blur`. Window blur, tab hide and show, saves, views, selections and the
camera (start, end, 4 Hz) are logged too; every event has wall-clock `t`, monotonic `dt` (ms since the session began)
and `seq`. `analyze.py` turns this into active time (a gap counts as work up to `--idle` seconds, default 30; time while
the tab is hidden or in the background counts nothing; the report also gives the total at 5 / 15 / 30 / 60 s), where
it went (by selected element type, tool, view, camera) and the time of each editing task (each command gets the active
time since the previous command or since its element was selected).

```bash
~/miniforge3/envs/viewer/bin/python annotator/analyze.py            # metrics per session and save -> report.json
~/miniforge3/envs/viewer/bin/python annotator/analyze.py --notes    # every note, as Markdown
```

## Code

No build step: plain ES modules, three.js r160 vendored in `web/vendor/` (with `TransformControls`), and
polygon-clipping 0.15.7 (MIT, `web/vendor/polygon-clipping/`) for the polygon unions of the merge tool.

| File | Role |
|---|---|
| `server.py` | static files, scene discovery in `data/`, scan / annotation download, save and log endpoints, proxy prefix, access key |
| `tools/make_scan.py` | Matterport textured mesh → `data/scans/<house>.glb` |
| `web/js/registry.js` | **element-type registry**: per type its JSON list, levels, drawing, colours, panel fields, read-only rule, evidence, related elements, actions, transform adapter, editable shapes, match fields, duplication |
| `web/js/xform.js` | per-type transform adapters: frame, pivots, axes, move / rotate / scale → fields, resize faces and extents (walls, openings, screens, polygons, beams, stairs, railings, separators, skylights) |
| `web/js/transform.js` | `TransformSession`: one transform of a selection (snapping, constraints, re-hosting, path samples, confirm / cancel) |
| `web/js/gumball.js`, `boxhandles.js`, `shapes.js` | Move / Rotate gumball; Resize face handles; Points editing and the Shape draw tool |
| `web/js/fitplane.js`, `notes.js`, `merge.js` | scan plane fit and what it can set on each type; notes; merging floors / ceilings |
| `web/js/modal.js`, `layout.js` | G / R / S keyboard transforms; align / distribute / match / duplicate / repeat |
| `web/js/render.js` | three.js scene, draw order and transparency, levels and cut, 3D / Plan / Wall views, camera |
| `web/js/selection.js`, `snap.js`, `tools.js` | picking and selection; pixel-tolerance snapping; handle drags, add tools, delete / copy / nudge, snap-to-scan, pointer input |
| `web/js/commands.js` | the only way the annotation changes: edit transactions, commit / undo (exact values), review marks, trash |
| `web/js/model.js`, `build.js` | data conventions and derived fields; records → geometry |
| `web/js/review.js`, `panel.js`, `ui.js`, `scene.js` | review queue; properties panel, element list, legend; UI wiring and keys; loading, saving, startup |
| `web/js/logging.js`, `logger.js`, `history.js` | what is logged and its transport; undo / redo stacks |
| `analyze.py` | metrics from logs and saves, notes export |

## Known limitations (prototype)

- Rooms, floors and ceilings are **not recomputed** after wall edits (edit their corners with Points), and joined walls
  do not follow a moved wall.
- Round walls: no snapping while dragging them or their openings, no distribute / align, no re-hosting of their
  openings to another wall, no plane fit of their faces (only top / base). Cone ceilings have no editable corners.
- Stairs can be moved and rotated, but not reshaped (treads, risers and landings are kept as they are).
- Not drawn: wall cladding / linings, the yurt's lattice, door leaves, window panes and glass planes.
- No login and no locking: the name is typed in, and two people editing one scene save separate versions.
- Tested in headless Chrome with software rendering; real-GPU performance not measured yet.
