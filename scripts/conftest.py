"""Shared pytest setup for the backend tests."""
import pytest

import server_generation


@pytest.fixture(autouse=True)
def _journal_in_tmp(tmp_path, monkeypatch):
    """Finished test jobs must not land in the real step journal (.local_db)."""
    monkeypatch.setattr(server_generation, "JOURNAL_DIR", str(tmp_path / "step-journal"))
    monkeypatch.setattr(server_generation, "_journal_pruned_on", None)
