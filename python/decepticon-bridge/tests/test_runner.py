from __future__ import annotations

from dataclasses import dataclass

from decepticon_bridge.runner import (
    DecepticonRunner,
    RunResult,
    _content_to_text,
    _extract_text,
)


@dataclass
class _Msg:
    content: object


def test_unknown_role_fails_cleanly() -> None:
    result = DecepticonRunner().run("not_a_role", "do thing")
    assert isinstance(result, RunResult)
    assert result.ok is False
    assert "unknown role" in (result.error or "")


def test_missing_decepticon_runtime_degrades_with_hint() -> None:
    # decepticon is intentionally NOT installed in the bridge's own test env;
    # the lazy import must fail with an actionable message, not crash.
    result = DecepticonRunner().run("recon", "enumerate hosts")
    assert result.ok is False
    assert "Decepticon runtime is not importable" in (result.error or "")
    assert "vendor/decepticon" in (result.error or "")


def test_content_to_text_handles_shapes() -> None:
    assert _content_to_text(None) == ""
    assert _content_to_text("hello") == "hello"
    assert _content_to_text(["a", "b"]) == "a\nb"
    assert _content_to_text([{"type": "text", "text": "x"}, {"text": "y"}]) == "x\ny"


def test_extract_text_from_message_object_and_dict() -> None:
    assert _extract_text({"messages": [_Msg(content="final answer")]}) == "final answer"
    assert _extract_text({"messages": [{"content": "dict answer"}]}) == "dict answer"
    assert _extract_text({"messages": []}) == ""
    assert _extract_text({}) == ""
