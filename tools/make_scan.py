"""Make the annotator's scan for a Matterport3D house: data/scans/<house>.glb from Matterport's photo-textured mesh.

    ~/miniforge3/envs/viewer/bin/python annotator/tools/make_scan.py <house> [<house> ...] [--out DIR] [--scans DIR]

Reads <scans>/<house>/matterport_mesh/<id>/<id>.obj with its .mtl and .jpg textures (read only; the default is the
lab's copy of Matterport3D on cs-3dlg-03) and writes one textured, unlit glTF primitive per texture atlas, in the
mesh's own frame (metres, +Z up), which is the frame of the annotations. Large houses (over 40 MB of textures) get
their textures downscaled to 1024 px so the browser can load them; the geometry is kept in full.
Needs numpy and Pillow (the `viewer` conda environment has both).
"""
import argparse
import io
import json
import struct
import sys
from pathlib import Path

import numpy as np
from PIL import Image

SCANS = Path("/datasets/internal/matterport/public_extracted/v1/scans")
OUT = Path(__file__).resolve().parent.parent / "data" / "scans"
TEX_LIMIT = 40e6        # bytes of textures above which they are downscaled
TEX_MAX = 1024


def find_obj(scans, house):
    objs = sorted((scans / house / "matterport_mesh").glob("*/*.obj"))
    if not objs:
        sys.exit(f"{house}: no matterport_mesh/*/*.obj under {scans / house}")
    return objs[0]


def parse_obj(path):
    """Vertices, texture coordinates and faces (vertex / uv indices) grouped by material (= texture file)."""
    V, UV, faces = [], [], {}
    cur = None
    with open(path) as fh:
        for line in fh:
            if line.startswith("v "):
                V.append(line.split()[1:4])
            elif line.startswith("vt "):
                UV.append(line.split()[1:3])
            elif line.startswith("usemtl"):
                cur = line.split(None, 1)[1].strip()
            elif line.startswith("f "):
                idx = [p.split("/") for p in line.split()[1:]]
                vs = [int(p[0]) - 1 for p in idx]
                ts = [int(p[1]) - 1 if len(p) > 1 and p[1] else -1 for p in idx]
                lst = faces.setdefault(cur, [])
                for k in range(1, len(vs) - 1):           # fan-triangulate polygons
                    lst.append((vs[0], vs[k], vs[k + 1], ts[0], ts[k], ts[k + 1]))
    return np.array(V, np.float64), np.array(UV, np.float64), {m: np.array(f, np.int64) for m, f in faces.items()}


def texture_of(mtl_path):
    """{material name: texture file} from the .mtl (map_Kd)."""
    out, cur = {}, None
    for line in open(mtl_path):
        if line.startswith("newmtl"):
            cur = line.split(None, 1)[1].strip()
        elif line.strip().startswith("map_Kd") and cur:
            out[cur] = line.split(None, 1)[1].strip()
    return out


class GLB:
    """Minimal binary glTF writer: textured unlit triangle meshes."""

    def __init__(self):
        self.bin = bytearray()
        self.doc = {"asset": {"version": "2.0", "generator": "annotator/tools/make_scan.py"}, "buffers": [], "bufferViews": [],
                    "accessors": [], "meshes": [], "materials": [], "nodes": [], "images": [], "textures": [],
                    "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}],
                    "extensionsUsed": ["KHR_materials_unlit"], "scenes": [], "scene": 0}

    def view(self, data, target=None):
        while len(self.bin) % 4:
            self.bin += b"\0"
        v = {"buffer": 0, "byteOffset": len(self.bin), "byteLength": len(data)}
        if target:
            v["target"] = target
        self.bin += data
        self.doc["bufferViews"].append(v)
        return len(self.doc["bufferViews"]) - 1

    def accessor(self, arr, typ, comp, target, minmax=False):
        arr = np.ascontiguousarray(arr)
        a = {"bufferView": self.view(arr.tobytes(), target), "componentType": comp, "count": int(arr.shape[0]), "type": typ}
        if minmax:
            a["min"] = [float(x) for x in arr.min(0)]
            a["max"] = [float(x) for x in arr.max(0)]
        self.doc["accessors"].append(a)
        return len(self.doc["accessors"]) - 1

    def add(self, name, pos, uv, idx, jpeg):
        self.doc["images"].append({"bufferView": self.view(jpeg), "mimeType": "image/jpeg"})
        self.doc["textures"].append({"source": len(self.doc["images"]) - 1, "sampler": 0})
        self.doc["materials"].append({"name": name, "extensions": {"KHR_materials_unlit": {}},
                                      "pbrMetallicRoughness": {"baseColorTexture": {"index": len(self.doc["textures"]) - 1},
                                                               "metallicFactor": 0.0, "roughnessFactor": 1.0}})
        prim = {"attributes": {"POSITION": self.accessor(pos.astype(np.float32), "VEC3", 5126, 34962, True),
                               "TEXCOORD_0": self.accessor(uv.astype(np.float32), "VEC2", 5126, 34962)},
                "indices": self.accessor(idx.astype(np.uint32).reshape(-1), "SCALAR", 5125, 34963),
                "material": len(self.doc["materials"]) - 1, "mode": 4}
        self.doc["meshes"].append({"name": name, "primitives": [prim]})
        self.doc["nodes"].append({"name": name, "mesh": len(self.doc["meshes"]) - 1})

    def save(self, path, house):
        root = {"name": "scan", "children": list(range(len(self.doc["nodes"])))}
        self.doc["nodes"].append(root)
        self.doc["scenes"] = [{"nodes": [len(self.doc["nodes"]) - 1], "extras": {"house": house, "frame": "Matterport mesh, metres, +Z up"}}]
        while len(self.bin) % 4:
            self.bin += b"\0"
        self.doc["buffers"] = [{"byteLength": len(self.bin)}]
        js = json.dumps(self.doc, separators=(",", ":")).encode()
        js += b" " * ((4 - len(js) % 4) % 4)
        tmp = path.with_suffix(".tmp")
        with open(tmp, "wb") as fh:
            fh.write(struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(js) + 8 + len(self.bin)))
            fh.write(struct.pack("<I4s", len(js), b"JSON") + js)
            fh.write(struct.pack("<I4s", len(self.bin), b"BIN\0") + self.bin)
        tmp.replace(path)
        return path.stat().st_size


def make(house, scans, out):
    obj = find_obj(scans, house)
    folder = obj.parent
    V, UV, faces = parse_obj(obj)
    tex = texture_of(obj.with_suffix(".mtl"))
    tex_bytes = sum((folder / tex.get(m, m)).stat().st_size for m in faces if (folder / tex.get(m, m)).exists())
    shrink = tex_bytes > TEX_LIMIT
    g = GLB()
    for m, F in sorted(faces.items(), key=lambda kv: str(kv[0])):
        tfile = folder / tex.get(m, m)
        if not tfile.exists() or (F[:, 3:] < 0).any():
            print(f"  skipped material {m}: no texture or no uv", file=sys.stderr)
            continue
        pairs = np.stack([F[:, :3].reshape(-1), F[:, 3:].reshape(-1)], 1)        # (vertex, uv) per corner
        uniq, inv = np.unique(pairs, axis=0, return_inverse=True)
        uv = UV[uniq[:, 1]].copy()
        uv[:, 1] = 1.0 - uv[:, 1]                                                 # glTF uv origin: top left
        raw = tfile.read_bytes()
        if shrink:
            im = Image.open(io.BytesIO(raw)).convert("RGB")
            if max(im.size) > TEX_MAX:
                f = TEX_MAX / max(im.size)
                im = im.resize((max(1, int(im.size[0] * f)), max(1, int(im.size[1] * f))), Image.LANCZOS)
            b = io.BytesIO()
            im.save(b, "JPEG", quality=78)
            raw = b.getvalue()
        g.add(Path(tex.get(m, m)).stem, V[uniq[:, 0]], uv, inv.reshape(-1, 3), raw)
    out.mkdir(parents=True, exist_ok=True)
    n = g.save(out / f"{house}.glb", house)
    print(f"{house}: {out / f'{house}.glb'} {n / 1e6:.1f} MB, {len(g.doc['meshes'])} atlases, "
          f"{sum(len(f) for f in faces.values())} triangles{' (textures downscaled)' if shrink else ''}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("houses", nargs="+", help="Matterport house ids, e.g. 17DRP5sb8fy")
    ap.add_argument("--scans", type=Path, default=SCANS, help="Matterport3D scans folder (default: %(default)s)")
    ap.add_argument("--out", type=Path, default=OUT, help="where the .glb files go (default: %(default)s)")
    a = ap.parse_args()
    for h in a.houses:
        make(h, a.scans, a.out)


if __name__ == "__main__":
    main()
