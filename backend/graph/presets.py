"""Preset graph builders.

Returns plain dicts serializable to JSON, validated against GraphSpec
when loaded. Positions are hardcoded for L->R flow.
"""
from functools import lru_cache
from typing import Dict, List

from .schema import STEM_NAMES_6S


def default_6stem() -> Dict:
    """Source -> Split(htdemucs_6s) -> 6 Output nodes (one per stem)."""
    nodes: List[Dict] = [
        {"type": "source", "id": "source", "position": {"x": -146, "y": 286}},
        {
            "type": "split",
            "id": "split1",
            "position": {"x": 29, "y": 215},
            "source_node": "source",
            "source_port": "out",
            "model": "htdemucs_6s",
            "n_shifts": 2,
        },
    ]
    for i, stem in enumerate(STEM_NAMES_6S):
        nodes.append({
            "type": "output",
            "id": f"out_{stem}",
            "position": {"x": 504, "y": 28 + i * 70},
            "label": stem,
            "source_node": "split1",
            "source_port": stem,
        })
    return {"nodes": nodes}


def horns_vox_isolation_2pass() -> Dict:
    """Additive-only 2-pass isolating the [vocals + other] stream.

        Source -> Split1
            -> Mix(vocals+other) -> Split2 -> Mix(Split2.vocals+Split2.other) -> Output('horns')
            -> Mix(drums+bass+piano+guitar)                                   -> Output('backing')
    """
    nodes: List[Dict] = [
        {"type": "source", "id": "source", "position": {"x": 142, "y": 282}},
        {
            "type": "split",
            "id": "split1",
            "position": {"x": 321, "y": 225},
            "source_node": "source",
            "source_port": "out",
            "model": "htdemucs_6s",
            "n_shifts": 2,
        },
        # Pass-1 horn candidate = vocals + other (horns typically land in 'other',
        # adding vocals lets pass-2 re-allocate any vocal bleed).
        {
            "type": "mix",
            "id": "mix_horn_candidate",
            "position": {"x": 516, "y": 155},
            "inputs": [
                {"source_node": "split1", "source_port": "vocals", "gain": 1.0},
                {"source_node": "split1", "source_port": "other", "gain": 1.0},
            ],
        },
        # Pass-2 re-separates the candidate.
        {
            "type": "split",
            "id": "split2",
            "position": {"x": 696, "y": 147},
            "source_node": "mix_horn_candidate",
            "source_port": "out",
            "model": "htdemucs_6s",
            "n_shifts": 2,
        },
        # Horns = sum of pass-2 [vocals + other] — the purified candidate stream.
        {
            "type": "mix",
            "id": "mix_horns",
            "position": {"x": 882, "y": 105},
            "inputs": [
                {"source_node": "split2", "source_port": "vocals", "gain": 1.0},
                {"source_node": "split2", "source_port": "other", "gain": 1.0},
            ],
        },
        {
            "type": "output",
            "id": "out_horns",
            "position": {"x": 1092, "y": 105},
            "label": "horns",
            "source_node": "mix_horns",
            "source_port": "out",
        },
        # Backing = pass-1 rhythm section + any rhythm content that leaked into pass-2.
        {
            "type": "mix",
            "id": "mix_backing",
            "position": {"x": 882, "y": 294},
            "inputs": [
                {"source_node": "split2", "source_port": "piano", "gain": 1.0},
                {"source_node": "split2", "source_port": "guitar", "gain": 1.0},
                {"source_node": "split2", "source_port": "drums", "gain": 1.0},
                {"source_node": "split2", "source_port": "bass", "gain": 1.0},
                {"source_node": "split1", "source_port": "piano", "gain": 1.0},
                {"source_node": "split1", "source_port": "guitar", "gain": 1.0},
                {"source_node": "split1", "source_port": "drums", "gain": 1.0},
                {"source_node": "split1", "source_port": "bass", "gain": 1.0},
            ],
        },
        {
            "type": "output",
            "id": "out_backing",
            "position": {"x": 1092, "y": 294},
            "label": "backing",
            "source_node": "mix_backing",
            "source_port": "out",
        },
    ]
    return {"nodes": nodes}


def _stem_isolation_2pass(target: str, complement_label: str = "backing") -> Dict:
    """Additive-only 2-pass isolation of a single Split-model stem.

        Source -> Split1
            -> Split2 (on Split1.<target>) -> Output(<target>)
            -> Mix(every non-<target> stem from both passes) -> Output(<complement_label>)
    """
    others = [s for s in STEM_NAMES_6S if s != target]
    return {
        "nodes": [
            {"type": "source", "id": "source", "position": {"x": 363, "y": 354}},
            {
                "type": "split",
                "id": "split1",
                "position": {"x": 532, "y": 358},
                "source_node": "source",
                "source_port": "out",
                "model": "htdemucs_6s",
                "n_shifts": 2,
            },
            {
                "type": "split",
                "id": "split2",
                "position": {"x": 698, "y": 196},
                "source_node": "split1",
                "source_port": target,
                "model": "htdemucs_6s",
                "n_shifts": 2,
            },
            {
                "type": "output",
                "id": f"out_{target}",
                "position": {"x": 1092, "y": 105},
                "label": target,
                "source_node": "split2",
                "source_port": target,
            },
            {
                "type": "mix",
                "id": f"mix_{complement_label}",
                "position": {"x": 882, "y": 294},
                "inputs": [
                    *[{"source_node": "split2", "source_port": s, "gain": 1.0} for s in others],
                    *[{"source_node": "split1", "source_port": s, "gain": 1.0} for s in others],
                ],
            },
            {
                "type": "output",
                "id": f"out_{complement_label}",
                "position": {"x": 1092, "y": 294},
                "label": complement_label,
                "source_node": f"mix_{complement_label}",
                "source_port": "out",
            },
        ],
    }


def vox_isolation_2pass() -> Dict:
    return _stem_isolation_2pass("vocals", "instrumental")


def guitar_isolation_2pass() -> Dict:
    return _stem_isolation_2pass("guitar")


def piano_isolation_2pass() -> Dict:
    return _stem_isolation_2pass("piano")


def drums_isolation_2pass() -> Dict:
    return _stem_isolation_2pass("drums")


PRESETS = {
    "default_6stem": {
        "id": "default_6stem",
        "name": "Default 6-stem",
        "description": "Standard Demucs 6-stem separation",
        "graph": default_6stem,
    },
    "vox_isolation_2pass": {
        "id": "vox_isolation_2pass",
        "name": "Vox isolation (2-pass)",
        "description": "Re-separate (vocals + other) from pass 1 to clean up vocal leakage",
        "graph": vox_isolation_2pass,
    },
    "horns_vox_isolation_2pass": {
        "id": "horns_vox_isolation_2pass",
        "name": "Horns/vox isolation (2-pass)",
        "description": "Purify the 'other' channel with a second pass — good for saxophone/brass",
        "graph": horns_vox_isolation_2pass,
    },
    "guitar_isolation_2pass": {
        "id": "guitar_isolation_2pass",
        "name": "Guitar isolation (2-pass)",
        "description": "Re-separate the guitar stem from pass 1 to clean up leakage",
        "graph": guitar_isolation_2pass,
    },
    "piano_isolation_2pass": {
        "id": "piano_isolation_2pass",
        "name": "Piano isolation (2-pass)",
        "description": "Re-separate the piano stem from pass 1 to clean up leakage",
        "graph": piano_isolation_2pass,
    },
    "drums_isolation_2pass": {
        "id": "drums_isolation_2pass",
        "name": "Drums isolation (2-pass)",
        "description": "Re-separate the drums stem from pass 1 to clean up leakage",
        "graph": drums_isolation_2pass,
    },
}


def list_presets():
    return [
        {"id": p["id"], "name": p["name"], "description": p["description"]}
        for p in PRESETS.values()
    ]


def _add_pitch_speed_before_outputs(graph: Dict, offset_x: int = 180) -> Dict:
    """Insert a single pass-through pitch_speed node (pitch=0, tempo=1.0) that
    fans every Output node through its own slot. Outputs shift right by
    `offset_x` to make room for the new node; slots are assigned top-to-bottom
    so the input/output port order matches the visual output stack.
    """
    outputs = [n for n in graph["nodes"] if n.get("type") == "output"]
    if not outputs:
        return graph

    outputs_sorted = sorted(outputs, key=lambda n: n["position"]["y"])
    slot_by_output_id = {o["id"]: slot for slot, o in enumerate(outputs_sorted)}

    min_ox = min(o["position"]["x"] for o in outputs)
    avg_oy = sum(o["position"]["y"] for o in outputs) // len(outputs)
    ps_id = "ps_out"

    inputs = [
        {
            "slot_id": slot,
            "source_node": o["source_node"],
            "source_port": o["source_port"],
        }
        for slot, o in enumerate(outputs_sorted)
    ]

    new_nodes: List[Dict] = []
    for n in graph["nodes"]:
        if n.get("type") != "output":
            new_nodes.append(n)
            continue
        slot = slot_by_output_id[n["id"]]
        new_nodes.append({
            **n,
            "position": {"x": n["position"]["x"] + offset_x, "y": n["position"]["y"]},
            "source_node": ps_id,
            "source_port": f"out_{slot}",
        })

    new_nodes.append({
        "type": "pitch_speed",
        "id": ps_id,
        "position": {"x": min_ox, "y": avg_oy},
        "inputs": inputs,
        "pitch_semitones": 0,
        "tempo_ratio": 1.0,
    })

    return {"nodes": new_nodes}


@lru_cache(maxsize=None)
def get_preset(preset_id: str) -> Dict:
    if preset_id not in PRESETS:
        raise KeyError(f"unknown preset: {preset_id}")
    graph = PRESETS[preset_id]["graph"]()
    return _add_pitch_speed_before_outputs(graph)
