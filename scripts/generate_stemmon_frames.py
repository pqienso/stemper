#!/usr/bin/env python3
"""Generate stem-mon dance animation frames.

Each frame is produced by loading favicon-full.svg and applying a small,
named edit to a fresh copy — move a leaf, close the eyes, shift the body.
stem-mon is never redrawn, so his shape and face stay identical across
every frame; each output is trivially diff-able against the base.

Outputs to frontend/public/stem-mon/:
  frame-<variant>.svg  one-change-at-a-time frames
  dance-<n>.svg        compound poses used by the animated composite
  dancing.svg          all 4 dance poses cycling via CSS @keyframes
"""

from copy import deepcopy
from pathlib import Path
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
BASE_SVG = ROOT / "frontend" / "public" / "favicon-full.svg"
OUT_DIR = ROOT / "frontend" / "public" / "stem-mon"

SVG_NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", SVG_NS)

DARK, BODY, LEAF = "#1d2021", "#b8bb26", "#98971a"


def load():
    return ET.parse(str(BASE_SVG))


def group(tree, fill):
    for g in tree.getroot().findall(f"{{{SVG_NS}}}g"):
        if g.get("fill") == fill:
            return g
    raise KeyError(fill)


def find(g, **attrs):
    for r in g.findall(f"{{{SVG_NS}}}rect"):
        if all(r.get(k) == str(v) for k, v in attrs.items()):
            return r
    return None


def remove(g, **attrs):
    r = find(g, **attrs)
    if r is None:
        raise KeyError(attrs)
    g.remove(r)


def add(g, **attrs):
    r = ET.SubElement(g, f"{{{SVG_NS}}}rect")
    for k, v in attrs.items():
        r.set(k, str(v))


def leaf_up(tree, side):
    """Move one leaf 2 rows up (9/10/11 -> 7/8/9)."""
    g = group(tree, LEAF)
    if side == "left":
        remove(g, x="4", y="9",  width="1", height="1")
        remove(g, x="3", y="10", width="3", height="1")
        remove(g, x="4", y="11", width="1", height="1")
        add(g, x="4", y="7", width="1", height="1")
        add(g, x="3", y="8", width="3", height="1")
        add(g, x="4", y="9", width="1", height="1")
    else:
        remove(g, x="11", y="9",  width="1", height="1")
        remove(g, x="10", y="10", width="3", height="1")
        remove(g, x="11", y="11", width="1", height="1")
        add(g, x="11", y="7", width="1", height="1")
        add(g, x="10", y="8", width="3", height="1")
        add(g, x="11", y="9", width="1", height="1")


def leaf_down(tree, side):
    """Move one leaf 2 rows down (9/10/11 -> 11/12/13)."""
    g = group(tree, LEAF)
    if side == "left":
        remove(g, x="4", y="9",  width="1", height="1")
        remove(g, x="3", y="10", width="3", height="1")
        remove(g, x="4", y="11", width="1", height="1")
        add(g, x="4", y="11", width="1", height="1")
        add(g, x="3", y="12", width="3", height="1")
        add(g, x="4", y="13", width="1", height="1")
    else:
        remove(g, x="11", y="9",  width="1", height="1")
        remove(g, x="10", y="10", width="3", height="1")
        remove(g, x="11", y="11", width="1", height="1")
        add(g, x="11", y="11", width="1", height="1")
        add(g, x="10", y="12", width="3", height="1")
        add(g, x="11", y="13", width="1", height="1")


def _split_multirow_body(tree):
    """Split rects with h>1 in body region (y>=6) into per-row rects, so per-row
    offsets can be applied. Needed before curving — base has h=8 stem rects."""
    for g in tree.getroot().findall(f"{{{SVG_NS}}}g"):
        for r in list(g.findall(f"{{{SVG_NS}}}rect")):
            y, h = int(r.get("y")), int(r.get("height"))
            if y >= 6 and h > 1:
                x, w = int(r.get("x")), int(r.get("width"))
                g.remove(r)
                for dy in range(h):
                    add(g, x=x, y=y + dy, width=w, height=1)


def curve_body(tree, dx):
    """Curve the body into a lean. dx=+1 right, -1 left. Head (y<6) untouched.

    Offset profile per row: 6-8 = 0 (connected to head), 9-11 = dx, 12-15 = 2*dx.
    Produces a 3-segment C-curve with the tip at max offset."""
    _split_multirow_body(tree)

    def offset(y):
        if y < 9:
            return 0
        if y < 12:
            return dx
        return 2 * dx

    for g in tree.getroot().findall(f"{{{SVG_NS}}}g"):
        for r in g.findall(f"{{{SVG_NS}}}rect"):
            y = int(r.get("y"))
            if y >= 6:
                r.set("x", str(int(r.get("x")) + offset(y)))


def close_eyes(tree):
    e, b = group(tree, DARK), group(tree, BODY)
    remove(e, x="5", y="3", width="2", height="1")
    remove(e, x="9", y="3", width="2", height="1")
    add(b, x="5", y="3", width="2", height="1")
    add(b, x="9", y="3", width="2", height="1")


def close_mouth(tree):
    e, b = group(tree, DARK), group(tree, BODY)
    remove(e, x="7", y="4", width="2", height="1")
    add(b, x="7", y="4", width="2", height="1")


def serialize(tree):
    ET.indent(tree, space="  ")
    xml = ET.tostring(tree.getroot(), encoding="unicode")
    return xml.replace(" />", "/>") + "\n"


def write(name, tree):
    path = OUT_DIR / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(serialize(tree))
    print(f"  {path.relative_to(ROOT)}")


def arms_rl():
    t = load(); leaf_up(t, "right"); leaf_down(t, "left"); return t


def arms_lr():
    t = load(); leaf_up(t, "left"); leaf_down(t, "right"); return t


def lean_left():
    t = load(); curve_body(t, -1); return t


def lean_right():
    t = load(); curve_body(t, +1); return t


def blink():
    t = load(); close_eyes(t); return t


def mouth_closed():
    t = load(); close_mouth(t); return t


dance_1 = lean_left
dance_2 = lean_right
dance_3 = arms_lr
dance_4 = arms_rl


def dancing():
    """Composite SVG: 4 dance poses interleaved with neutral rests, cycling via
    CSS @keyframes (250ms per frame, 2s loop: pose, rest, pose, rest, ...)."""
    poses = [
        dance_1(), load(),   # lean left, neutral
        dance_2(), load(),   # lean right, neutral
        dance_3(), load(),   # arm up left, neutral
        dance_4(), load(),   # arm up right, neutral
    ]
    root = ET.Element(f"{{{SVG_NS}}}svg", {
        "viewBox": "0 0 16 16",
        "shape-rendering": "crispEdges",
    })
    style = ET.SubElement(root, f"{{{SVG_NS}}}style")
    style.text = (
        "\n    .frame { opacity: 0; animation: cycle 2s steps(1) infinite; }"
        "\n    .f1 { animation-delay: 0s; }"
        "\n    .f2 { animation-delay: 0.25s; }"
        "\n    .f3 { animation-delay: 0.5s; }"
        "\n    .f4 { animation-delay: 0.75s; }"
        "\n    .f5 { animation-delay: 1s; }"
        "\n    .f6 { animation-delay: 1.25s; }"
        "\n    .f7 { animation-delay: 1.5s; }"
        "\n    .f8 { animation-delay: 1.75s; }"
        "\n    @keyframes cycle { 0% { opacity: 1; } 12.5%, 100% { opacity: 0; } }"
        "\n  "
    )
    for i, pose in enumerate(poses, start=1):
        fg = ET.SubElement(root, f"{{{SVG_NS}}}g", {"class": f"frame f{i}"})
        for g in pose.getroot().findall(f"{{{SVG_NS}}}g"):
            fg.append(deepcopy(g))
    return ET.ElementTree(root)


# Gruvbox palette remaps for the click-easter-egg. Source colors on the left come
# from the default (green) frames; each theme re-skins by swapping the fill
# attribute of each <g> group. A two-pass placeholder hop keeps chained swaps
# collision-free (e.g. pink's body taking the old cheek color).
#
# Source slots: outline, body, highlight, leaf, bud, and (for pink) cheek.
# Eyes/mouth (#1d2021) always stay for face legibility.
#
#                  outline    body       highlight  leaf       bud        [cheek]
_GREEN_OUTLINE  = "#79740e"
_GREEN_BODY     = "#b8bb26"
_GREEN_HILITE   = "#8ec07c"
_GREEN_LEAF     = "#98971a"
_GREEN_BUD      = "#fe8019"
_GREEN_CHEEK    = "#d3869b"

def _theme(outline, body, highlight, leaf, bud, cheek=None):
    mapping = {
        _GREEN_OUTLINE: outline,
        _GREEN_BODY:    body,
        _GREEN_HILITE:  highlight,
        _GREEN_LEAF:    leaf,
        _GREEN_BUD:     bud,
    }
    if cheek is not None:
        mapping[_GREEN_CHEEK] = cheek
    return mapping

THEMES = {
    "blue":   _theme("#076678", "#83a598", "#d5c4a1", "#458588", "#fabd2f"),
    "pink":   _theme("#8f3f71", "#d3869b", "#fabd2f", "#b16286", "#8ec07c", cheek="#8ec07c"),
    "red":    _theme("#9d0006", "#fb4934", "#fabd2f", "#cc241d", "#8ec07c"),
    "yellow": _theme("#b57614", "#fabd2f", "#d5c4a1", "#d79921", "#fb4934"),
    "aqua":   _theme("#427b58", "#8ec07c", "#d5c4a1", "#689d6a", "#d65d03"),
    "orange": _theme("#af3a03", "#fe8019", "#d5c4a1", "#d65d03", "#fabd2f"),
    "purple": _theme("#8f3f71", "#b16286", "#fabd2f", "#8f3f71", "#8ec07c", cheek="#fabd2f"),
}


def apply_theme(src: Path, dst: Path, mapping: dict):
    """Re-skin an SVG by rewriting each `fill="#OLD"` to `fill="#NEW"`.
    Two-pass via unique placeholders so OLD→NEW mappings can chain safely."""
    text = src.read_text()
    for i, old in enumerate(mapping.keys()):
        text = text.replace(f'fill="{old}"', f'fill="__THEME_{i}__"')
    for i, new in enumerate(mapping.values()):
        text = text.replace(f'fill="__THEME_{i}__"', f'fill="{new}"')
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(text)


def generate_themes():
    # Only the files StemmonDancer actually cycles through need re-skinning.
    # `neutral.svg` per theme comes from favicon-full.svg (the base pose).
    sources = [
        ("neutral.svg", BASE_SVG),
        ("dance-1.svg", OUT_DIR / "dance-1.svg"),
        ("dance-2.svg", OUT_DIR / "dance-2.svg"),
        ("dance-3.svg", OUT_DIR / "dance-3.svg"),
        ("dance-4.svg", OUT_DIR / "dance-4.svg"),
        ("frame-blink.svg", OUT_DIR / "frame-blink.svg"),
        ("frame-mouth-closed.svg", OUT_DIR / "frame-mouth-closed.svg"),
    ]
    for theme, mapping in THEMES.items():
        for name, src in sources:
            dst = OUT_DIR / theme / name
            apply_theme(src, dst, mapping)
            print(f"  {dst.relative_to(ROOT)}")


def main():
    print(f"base: {BASE_SVG.relative_to(ROOT)}")
    print(f"out:  {OUT_DIR.relative_to(ROOT)}\n")
    print("single-variable frames:")
    write("frame-arms-rl.svg",      arms_rl())
    write("frame-arms-lr.svg",      arms_lr())
    write("frame-lean-left.svg",    lean_left())
    write("frame-lean-right.svg",   lean_right())
    write("frame-blink.svg",        blink())
    write("frame-mouth-closed.svg", mouth_closed())
    print("compound dance poses:")
    write("dance-1.svg", dance_1())
    write("dance-2.svg", dance_2())
    write("dance-3.svg", dance_3())
    write("dance-4.svg", dance_4())
    print("animated composite:")
    write("dancing.svg", dancing())
    print("themed variants:")
    generate_themes()


if __name__ == "__main__":
    main()
