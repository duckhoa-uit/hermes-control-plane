#!/usr/bin/env python3
"""
Validate a Hermes-style SKILL.md against:

1. Hermes' own validator (ported from
   hermes-agent/tools/skill_manager_tool.py::_validate_frontmatter).
2. The "Skill authoring HARDLINE" rules from hermes-agent/AGENTS.md
   §"Skills" (description ≤60 chars, ends with period, no marketing
   words; required section order; author is a human; ...).

Usage:
    python3 scripts/validate-skill.py skills/hermes-control-plane/SKILL.md

Exits 0 on pass, 1 on any failure. Lists every check it ran.
"""
from __future__ import annotations

import pathlib
import re
import sys

try:
    import yaml
except ImportError:
    sys.stderr.write(
        "pyyaml is required: pip install pyyaml (or: pip3 install pyyaml)\n"
    )
    sys.exit(2)


# Hermes constants (tools/skill_manager_tool.py).
MAX_NAME_LENGTH = 64
MAX_DESCRIPTION_LENGTH = 1024  # hard limit; hardline §1 tightens to 60
MAX_SKILL_CONTENT_CHARS = 100_000

# Hardline §1 forbidden marketing words.
FORBIDDEN_MARKETING = ("powerful", "comprehensive", "seamless", "advanced")

# Hardline §5 required section order.
REQUIRED_SECTIONS = (
    "## When to Use",
    "## Prerequisites",
    "## How to Run",
    "## Quick Reference",
    "## Procedure",
    "## Pitfalls",
    "## Verification",
)


def fail(msg: str) -> None:
    print(f"✘ {msg}", file=sys.stderr)


def ok(msg: str) -> None:
    print(f"✓ {msg}")


def validate_frontmatter(content: str) -> tuple[dict | None, list[str]]:
    """Hermes' own validator. Returns (parsed_frontmatter, errors)."""
    errs: list[str] = []
    if not content.strip():
        return None, ["content is empty"]
    if not content.startswith("---"):
        return None, ["must start with YAML frontmatter (---)"]
    m = re.search(r"\n---\s*\n", content[3:])
    if not m:
        return None, ["frontmatter is not closed with ---"]
    yaml_block = content[3 : m.start() + 3]
    try:
        parsed = yaml.safe_load(yaml_block)
    except yaml.YAMLError as e:
        return None, [f"yaml parse error: {e}"]
    if not isinstance(parsed, dict):
        return None, ["frontmatter must be a YAML mapping"]
    if "name" not in parsed:
        errs.append("frontmatter missing 'name'")
    if "description" not in parsed:
        errs.append("frontmatter missing 'description'")
    elif len(str(parsed["description"])) > MAX_DESCRIPTION_LENGTH:
        errs.append(
            f"description > {MAX_DESCRIPTION_LENGTH} chars (Hermes hard limit)"
        )
    body = content[m.end() + 3 :].strip()
    if not body:
        errs.append("frontmatter has no body after it")
    return parsed, errs


def validate(path: pathlib.Path) -> list[str]:
    errs: list[str] = []
    content = path.read_text()

    # ── 1. Hermes _validate_frontmatter ───────────────────────────────
    fm, fm_errs = validate_frontmatter(content)
    errs.extend(fm_errs)
    if fm is None:
        return errs
    ok("Hermes _validate_frontmatter passes")

    # ── 2. _validate_name + _validate_content_size ────────────────────
    name = str(fm.get("name", ""))
    if len(name) > MAX_NAME_LENGTH:
        errs.append(f"name > {MAX_NAME_LENGTH} chars")
    else:
        ok(f"name OK ('{name}', {len(name)} chars)")

    if len(content) > MAX_SKILL_CONTENT_CHARS:
        errs.append(f"content > {MAX_SKILL_CONTENT_CHARS} chars")
    else:
        ok(f"size OK ({len(content)} chars)")

    # ── 3. Hardline §1: description ≤60, ends with period, no marketing ─
    desc = str(fm.get("description", ""))
    if len(desc) > 60:
        errs.append(f"hardline §1: description > 60 chars ({len(desc)})")
    elif not desc.endswith("."):
        errs.append("hardline §1: description must end with a period")
    else:
        for w in FORBIDDEN_MARKETING:
            if w in desc.lower():
                errs.append(f'hardline §1: marketing word "{w}" in description')
                break
        else:
            ok(f'hardline §1 OK ("{desc}", {len(desc)} chars)')

    # ── 4. Hardline §3: platforms declared ────────────────────────────
    plats = fm.get("platforms")
    if not isinstance(plats, list) or not plats:
        errs.append("hardline §3: 'platforms' must be a non-empty list")
    else:
        ok(f"hardline §3 OK (platforms={plats})")

    # ── 5. Hardline §4: author is not 'Hermes Agent' alone ────────────
    author = str(fm.get("author", ""))
    if not author:
        errs.append("hardline §4: 'author' missing")
    elif author == "Hermes Agent":
        errs.append(
            "hardline §4: author = 'Hermes Agent' — credit the human contributor"
        )
    else:
        ok(f"hardline §4 OK (author='{author}')")

    # ── 6. Hardline §5: required section order ────────────────────────
    last_idx = -1
    out_of_order = None
    for sec in REQUIRED_SECTIONS:
        idx = content.find(sec)
        if idx == -1:
            errs.append(f"hardline §5: missing section '{sec}'")
            break
        if idx <= last_idx:
            out_of_order = sec
            break
        last_idx = idx
    if out_of_order:
        errs.append(f"hardline §5: section out of order '{out_of_order}'")
    elif not errs or all(not e.startswith("hardline §5") for e in errs):
        ok("hardline §5 OK (section order correct)")

    # ── 7. Hardline §2: don't recommend shell utils as primary surface ─
    # Strip code blocks before scanning prose.
    prose = re.sub(r"```[\s\S]*?```", "", content)
    shell_warnings: list[str] = []
    for tok in ("`grep`", "`sed`", "`awk`", "`find`", "`cat`", "`head`", "`tail`"):
        if tok in prose:
            shell_warnings.append(tok)
    if shell_warnings:
        # Soft warning, not a hard fail — these may be legitimate in
        # rare cases (e.g. naming what you're NOT doing).
        print(
            f"⚠ hardline §2 WARN: prose mentions shell utils {shell_warnings} — "
            f"prefer native Hermes tools (search_files, read_file, patch)",
            file=sys.stderr,
        )
    else:
        ok("hardline §2 OK (no shell-util prose)")

    # ── 8. Size sanity (informational) ────────────────────────────────
    lines = content.count("\n")
    print(f"  → {lines} lines (target: ~100 simple / ~200 complex)")

    return errs


def main() -> int:
    if len(sys.argv) != 2:
        sys.stderr.write("usage: validate-skill.py <path/to/SKILL.md>\n")
        return 2
    path = pathlib.Path(sys.argv[1])
    if not path.exists():
        sys.stderr.write(f"not found: {path}\n")
        return 2

    print(f"Validating {path}")
    print("─" * 60)
    errs = validate(path)
    print("─" * 60)
    if errs:
        for e in errs:
            fail(e)
        print(f"\n{len(errs)} validation error(s)")
        return 1
    print("\nAll validations pass.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
