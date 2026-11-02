"""Print the section tree of the most recently stored parsing entry.

Usage: uv run python -m utilis.test.inspect_tree [entry_id]
"""
import json
import sys

from utilis.database import JsonDatabase


def _print_section(sec, indent: str, is_last: bool):
    branch = "└─ " if is_last else "├─ "
    num = f"[{sec.get('no')}] " if sec.get("no") else ""
    title = sec.get("title") or "?"
    print(f"{indent}{branch}L{sec.get('level')} {num}{title}")

    n_blocks = len(sec.get("blocks") or [])
    child_indent = indent + ("   " if is_last else "│  ")
    if n_blocks:
        types = {}
        for b in sec.get("blocks") or []:
            t = b.get("type", "?")
            types[t] = types.get(t, 0) + 1
        summary = ", ".join(f"{t}x{c}" for t, c in sorted(types.items()))
        print(f"{child_indent}└─ <blocks: {n_blocks} [{summary}]>")

    children = sec.get("children") or []
    for i, child in enumerate(children):
        _print_section(child, child_indent, i == len(children) - 1)


def main():
    db = JsonDatabase()
    keys = db.list_keys()
    if not keys:
        print("No entries in database.")
        return

    wanted = sys.argv[1] if len(sys.argv) > 1 else None
    if wanted is None:
        # newest by insertion position is last written key
        wanted = keys[-1]

    entry = db.get(wanted)
    if entry is None:
        print(f"Entry '{wanted}' not found.")
        return

    print(f"\n=== {entry.get('title')}  (id: {entry.get('unique_id')}) ===\n")
    sections = entry.get("sections") or []
    for i, sec in enumerate(sections):
        _print_section(sec, "", i == len(sections) - 1)


if __name__ == "__main__":
    main()