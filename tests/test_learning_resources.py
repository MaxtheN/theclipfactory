"""Hermetic resource admission checks; no real resource probes or model calls."""

import json
import subprocess
from dataclasses import FrozenInstanceError
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from clip_factory import learning_resources as resources
from clip_factory.learning_resources import GIB, check_learning_resources


def check(*, metadata=None, available=8 * GIB, total=16 * GIB, pressure=1, context=8192):
    return check_learning_resources(
        {"size": 2_370_000_000} if metadata is None else metadata,
        memory_reader=lambda: SimpleNamespace(available=available, total=total),
        pressure_reader=lambda: pressure,
        context_tokens=context,
    )


def test_normal_memory_at_exact_floor_is_admitted_and_snapshot_is_serializable():
    result = check(available=6 * GIB)
    assert result.ready and result.reasons == ()
    assert result.required_available_bytes == result.observed_available_bytes == 6 * GIB
    assert result.memory_pressure == "normal"
    assert result.context_tokens == 8192
    assert json.loads(json.dumps(result.to_dict())) == {
        "ready": True, "reasons": [], "required_available_bytes": 6 * GIB,
        "observed_available_bytes": 6 * GIB, "memory_pressure": "normal", "context_tokens": 8192,
    }
    with pytest.raises(FrozenInstanceError):
        result.ready = False


@pytest.mark.parametrize("available", [0, 6 * GIB - 1, 4_960_000_000, int(4.96 * GIB)])
def test_floor_blocks_low_memory_including_reported_failed_rehearsal(available):
    result = check(available=available)
    assert not result.ready
    assert result.observed_available_bytes == available
    assert any("available memory is required" in reason for reason in result.reasons)


def test_larger_model_adds_reserve_above_floor_without_residency_discount():
    weights = 8 * GIB
    held = check(metadata={"weights_bytes": weights, "resident": True}, available=11 * GIB - 1)
    assert not held.ready and held.required_available_bytes == 11 * GIB
    assert check(metadata={"weights_bytes": weights}, available=11 * GIB).ready


def test_explicit_weight_metadata_takes_precedence_over_ollama_size():
    assert check(metadata={"weights_bytes": 9 * GIB, "size": 1}).required_available_bytes == 12 * GIB
    assert not check(metadata={"weights_bytes": None, "size": 1}).ready


@pytest.mark.parametrize("metadata", [
    {}, {"estimated_gb": 2.4}, {"name": "4b", "parameter_size": "4B"}, {"size": None},
    {"size": 0}, {"size": -1}, {"size": True}, {"size": 2.37}, {"size": "2370000000"},
    {"size": float("nan")}, {"size": float("inf")}, [], "model", 5,
])
def test_unknown_or_invalid_metadata_never_assumes_model_fits(metadata):
    result = check(metadata=metadata, available=16 * GIB)
    assert not result.ready
    assert result.required_available_bytes == 6 * GIB
    assert any("model's size is unknown" in reason for reason in result.reasons)


def test_none_metadata_holds_even_with_healthy_readings():
    result = check_learning_resources(None, memory_reader=lambda: {"available": 8 * GIB, "total": 16 * GIB},
                                      pressure_reader=lambda: "normal")
    assert not result.ready


@pytest.mark.parametrize("pressure,normalized", [
    (2, "warning"), (4, "critical"), ("2", "warning"), ("4", "critical"),
    (" WARNING ", "warning"), ("Critical", "critical"),
])
def test_non_normal_pressure_blocks_even_with_abundant_memory(pressure, normalized):
    result = check(available=16 * GIB, pressure=pressure)
    assert not result.ready and result.memory_pressure == normalized
    assert any(normalized in reason for reason in result.reasons)


@pytest.mark.parametrize("pressure", [None, 0, 3, 5, True, False, 1.0, "", "healthy", {}, "secret=value"])
def test_unknown_pressure_fails_closed_without_exposing_raw_reading(pressure):
    result = check(pressure=pressure)
    assert not result.ready and result.memory_pressure == "unknown"
    assert all("secret" not in reason for reason in result.reasons)


@pytest.mark.parametrize("pressure", [1, "1", "normal", " NORMAL\n"])
def test_verified_normal_pressure_values(pressure):
    assert check(pressure=pressure).ready


@pytest.mark.parametrize("available,total", [
    (None, 16 * GIB), (-1, 16 * GIB), (True, 16 * GIB), (8.0 * GIB, 16 * GIB),
    (float("nan"), 16 * GIB), (float("inf"), 16 * GIB), ("8 GB", 16 * GIB),
    (8 * GIB, None), (8 * GIB, True), (8 * GIB, 0), (8 * GIB, 7 * GIB),
])
def test_invalid_memory_stats_hold_and_do_not_report_valid_observation(available, total):
    result = check(available=available, total=total)
    assert not result.ready and result.observed_available_bytes is None
    assert any("available memory could not be verified" in reason for reason in result.reasons)


@pytest.mark.parametrize("memory", [None, {}, {"available": 8 * GIB}, object()])
def test_missing_memory_telemetry_holds(memory):
    result = check_learning_resources({"size": 1}, memory_reader=lambda: memory, pressure_reader=lambda: 1)
    assert not result.ready and result.observed_available_bytes is None


def test_reader_exceptions_are_sanitized_and_both_checks_are_attempted():
    memory = Mock(side_effect=RuntimeError("private/key/value"))
    pressure = Mock(side_effect=RuntimeError("private/key/value"))
    result = check_learning_resources({"size": 1}, memory_reader=memory, pressure_reader=pressure)
    assert not result.ready and len(result.reasons) == 2
    memory.assert_called_once_with()
    pressure.assert_called_once_with()
    assert "private" not in json.dumps(result.to_dict())


def test_valid_mapping_memory_stats_are_supported():
    result = check_learning_resources({"size": 1}, memory_reader=lambda: {"available": 8 * GIB, "total": 16 * GIB},
                                      pressure_reader=lambda: 1)
    assert result.ready


@pytest.mark.parametrize("context", [2048, 4096, 8192])
def test_supported_context_returned_unchanged(context):
    result = check(context=context)
    assert result.ready and result.context_tokens == context


@pytest.mark.parametrize("context", [None, 0, 2047, 8193, 16384, True, 8192.0, "8192"])
def test_invalid_or_oversized_context_holds_with_safe_default(context):
    result = check(context=context)
    assert not result.ready and result.context_tokens == 8192
    assert any("context" in reason for reason in result.reasons)


def test_all_hold_reasons_accumulate_for_review():
    result = check(metadata={}, available=1, pressure=4, context=16384)
    assert not result.ready and len(result.reasons) == 4


@pytest.mark.parametrize("raw,expected", [("1\n", "normal"), ("2\n", "warning"), ("4\n", "critical"),
                                         ("5\n", "unknown")])
def test_macos_pressure_reader_is_read_only_bounded_and_normalized(monkeypatch, raw, expected):
    monkeypatch.setattr(resources.platform, "system", lambda: "Darwin")
    run = Mock(return_value=SimpleNamespace(stdout=raw))
    monkeypatch.setattr(resources.subprocess, "run", run)
    assert resources.read_macos_memory_pressure() == expected
    run.assert_called_once_with(
        ["/usr/sbin/sysctl", "-n", "kern.memorystatus_vm_pressure_level"],
        capture_output=True, text=True, check=True, timeout=1,
    )


@pytest.mark.parametrize(("system", "available", "expected"), [
    ("Linux", 8, "normal"), ("Windows", 8, "normal"), ("Linux", 1.5, "warning"),
    ("Windows", 1.5, "warning"), ("Linux", 0.5, "critical"),
])
def test_windows_and_linux_pressure_comes_from_psutil_without_subprocess(monkeypatch, system, available, expected):
    monkeypatch.setattr(resources.platform, "system", lambda: system)
    run = Mock()
    monkeypatch.setattr(resources.subprocess, "run", run)
    monkeypatch.setattr(resources.psutil, "virtual_memory",
                        lambda: Mock(available=int(available * GIB), total=16 * GIB))
    assert resources.read_memory_pressure() == expected
    result = check_learning_resources({"size": 1}, memory_reader=lambda: {"available": 8 * GIB, "total": 16 * GIB})
    assert result.memory_pressure == expected and result.ready is (expected == "normal")
    if expected != "normal":
        assert any("this computer reports" in reason for reason in result.reasons)
    run.assert_not_called()


def test_unreadable_memory_total_reads_as_unknown_pressure(monkeypatch):
    monkeypatch.setattr(resources.platform, "system", lambda: "Linux")
    monkeypatch.setattr(resources.psutil, "virtual_memory", lambda: Mock(available=0, total=0))
    assert resources.read_memory_pressure() == "unknown"


@pytest.mark.parametrize("error", [OSError("private"), subprocess.TimeoutExpired("sysctl", 1),
                                 subprocess.CalledProcessError(1, "sysctl", stderr="private")])
def test_default_pressure_command_failure_becomes_safe_hold(monkeypatch, error):
    monkeypatch.setattr(resources.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(resources.subprocess, "run", Mock(side_effect=error))
    result = check_learning_resources({"size": 1}, memory_reader=lambda: {"available": 8 * GIB, "total": 16 * GIB})
    assert not result.ready and result.memory_pressure == "unknown"
    assert "private" not in json.dumps(result.to_dict())
