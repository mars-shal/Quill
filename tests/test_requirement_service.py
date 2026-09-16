"""RequirementService regression tests: plural-safe evidence regexes."""

from quill_engine.models import ContentUnit, new_section
from quill_engine.requirement_service import build_requirements


def _section(title: str, text: str):
    return new_section(
        title=title,
        level=2,
        order=1,
        parent_id=None,
        content=[ContentUnit(text=text)],
    )


def _field(sec, field):
    for req in build_requirements(sec):
        if req.field == field:
            return req
    raise AssertionError(f"no requirement field {field!r} for {sec.title!r}")


def test_materials_field_matches_plural_forms():
    sec = _section(
        "2.5.2 MATERIALS AND MIX RATIOS",
        "We sourced the materials and calibrated the machines and instruments "
        "before checking the tools at the workshop.",
    )
    assert _field(sec, "materials").present


def test_materials_field_matches_machinery():
    sec = _section("2.5.2 MATERIALS AND MIX RATIOS", "The machinery was serviced weekly.")
    assert _field(sec, "materials").present


def test_locations_field_matches_plural_forms():
    sec = _section(
        "2.1 WEEK ONE ORIENTATION",
        "We visited several sites and workshops across the laboratories.",
    )
    assert _field(sec, "locations").present


def test_supervisors_field_matches_plural_forms():
    sec = _section(
        "2.1 WEEK ONE ORIENTATION",
        "Both supervisors and the site engineers reviewed the logbook.",
    )
    assert _field(sec, "supervisors").present


def test_logbook_field_required_for_logbook_titles():
    sec = _section("2.3 LOGBOOK RECORD", "Daily entries recorded.")
    fields = [r.field for r in build_requirements(sec)]
    assert "logbook" in fields
    assert "dates" in fields
    assert "activities" in fields


def test_logbook_field_present_with_recorded_entries():
    sec = _section(
        "2.3 LOGBOOK RECORD",
        "I logged daily entries and recorded every task performed each day.",
    )
    assert _field(sec, "logbook").present


def test_logbook_field_absent_without_markers():
    sec = _section("2.3 LOGBOOK RECORD", "The week covered general orientation activities.")
    assert not _field(sec, "logbook").present


def test_artifacts_field_required_and_present():
    sec = _section(
        "5.1 DELIVERABLES",
        "We designed and built a prototype dashboard for the site.",
    )
    fields = [r.field for r in build_requirements(sec)]
    assert "artifacts" in fields
    assert _field(sec, "artifacts").present


def test_week_logbook_title_prefers_logbook_rule():
    sec = _section("2.1 WEEK ONE LOGBOOK", "Recorded entries each day.")
    fields = [r.field for r in build_requirements(sec)]
    assert fields[0] == "logbook"  # logbook rule fires before the week rule


def test_evidence_counts_toward_lenient_fields_only():
    sec = _section("2.1 WEEK ONE ORIENTATION", "")
    evidence = (
        "Students at the orientation gained hands-on practical experience "
        "across multiple workshop activities during the first week of the "
        "programme at the engineering complex."
    )
    reqs = build_requirements(sec, evidence=evidence)
    by_field = {r.field: r for r in reqs}
    assert by_field["activities"].present
    assert not by_field["dates"].present
    assert not by_field["locations"].present
    assert not by_field["supervisors"].present


def test_structure_only_section_passes_on_research_evidence():
    sec = _section("3.0 CONCLUSION", "")
    evidence = (
        "The research notes summarise the key findings and recommendations "
        "drawn from the industrial attachment across all the stations."
    )
    reqs = build_requirements(sec, evidence=evidence)
    assert all(r.present for r in reqs)
