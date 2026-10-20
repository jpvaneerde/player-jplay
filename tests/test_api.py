"""The whole app over HTTP: who the player is, and standby."""
from fastapi.testclient import TestClient

from jplay.app import create_app
from jplay.config import load_config


def make_client(tmp_path):
    cfg = load_config(None)
    cfg["server"]["name"] = "Lounge"
    cfg["paths"].update(state_dir=str(tmp_path / "state"), runtime_dir=str(tmp_path / "run"))
    cfg["audio"]["device"] = "null"
    for s in ("radio", "plex", "cd", "spotify", "bluetooth"):
        cfg[s]["enabled"] = False
    return TestClient(create_app(cfg))


def test_info_gives_a_stable_id(tmp_path):
    with make_client(tmp_path) as client:
        first = client.get("/api/v1/info").json()
    assert first["name"] == "Lounge"
    assert len(first["id"]) == 16
    assert {s["id"] for s in first["sources"]} == {"radio", "plex", "cd", "spotify", "bluetooth"}
    # A restart (same state directory) keeps the id
    with make_client(tmp_path) as client:
        assert client.get("/api/v1/info").json()["id"] == first["id"]


def test_standby_leaves_nothing_active(tmp_path):
    with make_client(tmp_path) as client:
        r = client.post("/api/v1/standby")
        assert r.status_code == 200
        assert r.json()["active"] is None
