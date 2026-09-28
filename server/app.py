"""Open-source Galaxy 서버

  GET  /api/world             우주 전체: 은하·지역·행성계(계정)·행성(좌표와 이름만)
  GET  /api/system/{id}       행성계 하나의 상세: repo 정보와 항로
  GET  /api/resolve?q=        username / owner/repo / GitHub URL / 패키지 이름 → 어디로 갈지
  GET  /api/suggest?q=        입력 중 후보
  POST /api/ingest/{login}    아직 없는 계정을 들인다 (Git City처럼 검색한 사람을 그때 추가)

장부는 data/universe.db (pipeline/universe.py가 처음 만든다). 한 번 놓인 행성계와 행성은 움직이지 않는다.
실행: .venv/bin/uvicorn server.app:app --port 8787   (GITHUB_TOKEN이 있으면 들이기가 넉넉해진다)
"""
import json
import math
import re
import threading
import time
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from server import ingest as I
from server.database import connect

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data/universe.db"
DIST = ROOT / "web/dist"
LOGIN_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")

app = FastAPI(title="Open-source Galaxy")
app.add_middleware(GZipMiddleware, minimum_size=2048)

_db_lock = threading.Lock()
_ingest_lock = threading.Lock()
_failed = {}  # login → (시각, 이유). 같은 실패를 계속 GitHub에 묻지 않는다


CON = connect(DB_PATH)
MODEL = I.U.Model.load(ROOT / "data/model")


def orbits_by_account():
    """계정마다 궤도 수 (가장 바깥 궤도 번호 + 1). 궤도 하나에 행성 하나 (DIRECTION D19)"""
    return {
        row["account"]: row["max_ring"] + 1
        for row in CON.execute(
            "SELECT account, MAX(ring) AS max_ring FROM repos WHERE visible = 1 GROUP BY account"
        )
    }


def system_row(a, orbits):
    return {
        "id": a["id"], "login": a["login"], "kind": a["kind"],
        "c": [round(a["cx"], 1), round(a["cy"], 1), round(a["cz"], 1)],
        "nrm": [round(a["nx"], 4), round(a["ny"], 4), round(a["nz"], 4)],
        "orbits": orbits,
        "gal": a["galaxy"], "reg": a["region"], "truncated": bool(a["truncated"]),
    }


def planets_block(rows, sys_index):
    ids, names, sys, ring, pos, lang, created, stars = [], [], [], [], [], [], [], []
    for r in rows:
        ids.append(r["id"])
        names.append(r["name"])
        sys.append(sys_index[r["account"]])
        ring.append(r["ring"])
        pos += [round(r["x"], 2), round(r["y"], 2), round(r["z"], 2)]
        lang.append(r["lang"])
        created.append((r["created"] or "")[:10] or None)
        stars.append(r["stars"])
    return {"ids": ids, "names": names, "sys": sys, "ring": ring, "pos": pos, "lang": lang, "created": created, "stars": stars}


@app.get("/api/world")
def world():
    with _db_lock:
        meta = {r["k"]: r["v"] for r in CON.execute("SELECT * FROM meta")}
        galaxies = [{"id": g["id"], "name": g["name"], "c": [g["cx"], g["cy"], g["cz"]], "nrm": [g["nx"], g["ny"], g["nz"]], "r": g["radius"]}
                    for g in CON.execute("SELECT * FROM galaxies ORDER BY id")]
        regions = [{"id": r["id"], "gal": r["galaxy"], "name": r["name"], "c": [r["cx"], r["cy"], r["cz"]], "r": r["radius"]}
                   for r in CON.execute("SELECT * FROM regions ORDER BY id")]
        orbits = orbits_by_account()
        accounts = list(CON.execute("SELECT * FROM accounts ORDER BY placed_at, id"))
        systems = [system_row(a, orbits.get(a["id"], 0)) for a in accounts]
        sys_index = {a["id"]: k for k, a in enumerate(accounts)}
        repos = list(CON.execute("SELECT id, account, name, ring, x, y, z, lang, created, stars FROM repos WHERE visible = 1 ORDER BY placed_at, id"))
        edges = CON.execute("SELECT COUNT(*) AS n FROM edges").fetchone()["n"]
    for s, a in zip(systems, accounts):
        s["n"] = 0
    for r in repos:
        systems[sys_index[r["account"]]]["n"] += 1
    extent = max((math.hypot(s["c"][0], s["c"][2]) for s in systems), default=1000)
    return {
        "meta": {
            "placement_version": int(meta.get("placement_version", 0)),
            "generated_at": meta.get("generated_at"),
            "sources": json.loads(meta.get("sources", "[]")),
            "data_license": "CC BY-SA 4.0 (derived from ecosyste.ms data)",
            "stats": {"accounts": len(systems), "planets": len(repos), "edges": edges, "galaxies": len(galaxies),
                      "regions": len(regions), "radius": round(float(extent), 1)},
            "orbit": {"r0": I.U.ORBIT0, "gap": I.U.ORBIT_GAP},
        },
        "galaxies": galaxies,
        "regions": regions,
        "systems": systems,
        "planets": planets_block(repos, sys_index),
    }


@app.get("/api/system/{account_id}")
def system(account_id: str):
    with _db_lock:
        a = CON.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
        if not a:
            raise HTTPException(404, "없는 행성계")
        repos = list(CON.execute("SELECT * FROM repos WHERE account = ? AND visible = 1 ORDER BY ring, angle", (account_id,)))
        rid = [r["id"] for r in repos]
        marks = ",".join("?" * len(rid)) or "''"
        out = list(CON.execute(f"SELECT e.s, e.t, e.kind, r.name AS tname FROM edges e JOIN repos r ON r.id = e.t WHERE e.s IN ({marks})", rid))
        inc = list(CON.execute(f"SELECT e.s, e.t, e.kind, r.name AS sname FROM edges e JOIN repos r ON r.id = e.s WHERE e.t IN ({marks}) LIMIT 600", rid))
    return {
        "id": a["id"], "login": a["login"], "kind": a["kind"], "name": a["name"], "truncated": bool(a["truncated"]),
        "src": a["src"], "fetched_at": a["fetched_at"],
        "repos": [{
            "id": r["id"], "name": r["name"], "desc": r["desc"], "topics": json.loads(r["topics"] or "[]"), "lang": r["lang"],
            "stars": r["stars"], "archived": bool(r["archived"]), "created": r["created"], "pushed": r["pushed"],
            "license": r["license"], "observed": r["observed"], "src": r["src"], "packages": json.loads(r["packages"] or "[]"),
            "ring": r["ring"],
        } for r in repos],
        "out": [{"from": e["s"], "to": e["t"], "kind": e["kind"], "name": e["tname"]} for e in out],
        "inc": [{"from": e["s"], "to": e["t"], "kind": e["kind"], "name": e["sname"]} for e in inc],
    }


def normalize_query(raw):
    q = raw.strip()
    q = re.sub(r"^https?://", "", q, flags=re.I)
    q = re.sub(r"^(www\.)?github\.com/", "", q, flags=re.I)
    q = re.split(r"[?#]", q)[0]
    q = re.sub(r"\.git$", "", q, flags=re.I)
    parts = [p for p in q.split("/") if p]
    return "/".join(parts[:2])


@app.get("/api/resolve")
def resolve(q: str = Query(..., min_length=1, max_length=200)):
    n = normalize_query(q)
    with _db_lock:
        if "/" in n and not n.startswith("@"):
            r = CON.execute("SELECT id, account FROM repos WHERE name = ? AND visible = 1", (n,)).fetchone()
            if r:
                return {"kind": "planet", "id": r["id"], "account": r["account"]}
            owner = n.split("/")[0]
            a = CON.execute("SELECT id FROM accounts WHERE login = ?", (owner,)).fetchone()
            if a:
                return {"kind": "system", "id": a["id"], "missing_repo": n}
            return {"kind": "unknown", "login": owner, "repo": n, "ingestable": bool(LOGIN_RE.match(owner))}
        a = CON.execute("SELECT id FROM accounts WHERE login = ?", (n,)).fetchone()
        if a:
            return {"kind": "system", "id": a["id"]}
        p = CON.execute("SELECT repo FROM packages WHERE name = ?", (n,)).fetchone()
        if p:
            r = CON.execute("SELECT id, account FROM repos WHERE id = ?", (p["repo"],)).fetchone()
            if r:
                return {"kind": "planet", "id": r["id"], "account": r["account"]}
    return {"kind": "unknown", "login": n, "ingestable": bool(LOGIN_RE.match(n))}


@app.get("/api/suggest")
def suggest(q: str = Query(..., min_length=2, max_length=100)):
    n = normalize_query(q).lower()
    with _db_lock:
        accs = [{"label": r["login"], "value": r["login"], "sub": "행성계"}
                for r in CON.execute("SELECT login FROM accounts WHERE login LIKE ? ORDER BY length(login) LIMIT 3", (n + "%",))]
        like = f"%/{n}%" if "/" not in n else f"{n}%"
        repos = [{"label": r["name"], "value": r["name"], "sub": r["desc"] or ""}
                 for r in CON.execute('SELECT name, "desc" AS "desc" FROM repos WHERE name LIKE ? AND visible = 1 ORDER BY length(name) LIMIT 6', (like,))]
    return (accs + repos)[:6]


def ingest_index():
    """배치 모델과 같은 공간의 계정 벡터·중심·반지름"""
    rows = list(CON.execute("SELECT id, galaxy, region, cx, cy, cz, vec FROM accounts"))
    counts = {
        row["account"]: row["n"]
        for row in CON.execute("SELECT account, COUNT(*) AS n FROM repos GROUP BY account")
    }
    gal_rows = list(CON.execute("SELECT id, nx, ny, nz, cx, cy, cz, radius FROM galaxies"))
    gal = {g["id"]: np.array([g["nx"], g["ny"], g["nz"]]) for g in gal_rows}
    weak = CON.execute("SELECT v FROM meta WHERE k = 'weak_similarity'").fetchone()
    centers = np.array([[r["cx"], r["cy"], r["cz"]] for r in rows])
    return {
        "vectors": np.array([np.frombuffer(r["vec"], dtype=np.float32) for r in rows]),
        "centers": centers,
        "radii": np.array([I.U.system_radius(counts.get(r["id"], 1)) for r in rows]),
        "galaxy": [r["galaxy"] for r in rows],
        "region": [r["region"] for r in rows],
        "galaxy_normals": gal,
        "galaxy_centers": {g["id"]: np.array([g["cx"], g["cy"], g["cz"]]) for g in gal_rows},
        "galaxy_radii": {g["id"]: g["radius"] for g in gal_rows},
        "weak_similarity": float(weak["v"]) if weak else 0.0,
        "universe_extent": float(np.max(np.linalg.norm(centers[:, [0, 2]], axis=1))),
    }


@app.post("/api/ingest/{login}")
def ingest(login: str):
    if not LOGIN_RE.match(login):
        raise HTTPException(400, "GitHub username 형식이 아닙니다")
    with _ingest_lock:  # 한 번에 하나씩. 같은 계정을 동시에 들이지 않는다
        with _db_lock:
            a = CON.execute("SELECT id FROM accounts WHERE login = ?", (login,)).fetchone()
        if a:
            return {"status": "exists", "id": a["id"]}
        failed = _failed.get(login.lower())
        if failed and time.time() - failed[0] < 600:
            return JSONResponse({"status": "failed", "message": failed[1]}, status_code=failed[2])
        t0 = time.time()
        try:
            acc = I.fetch_account(login)
        except I.IngestError as e:
            _failed[login.lower()] = (time.time(), str(e), e.status)
            return JSONResponse({"status": "failed", "message": str(e)}, status_code=e.status)
        with _db_lock:
            known = {r["name"].lower(): r["id"] for r in CON.execute("SELECT id, name FROM repos")}
            dup = CON.execute("SELECT id FROM accounts WHERE id = ?", (acc["id"],)).fetchone()
        if dup:  # 이름이 바뀐 계정
            with _db_lock, CON.transaction():
                CON.execute("UPDATE accounts SET login = ? WHERE id = ?", (acc["login"], acc["id"]))
            return {"status": "exists", "id": acc["id"]}
        taken = set(known.values())
        repos = [r for r in acc["repos"] if r["id"] not in taken]
        edges = I.enrich(repos, known)
        with _db_lock, CON.transaction():
            placed = I.place(MODEL, acc, repos, known, ingest_index())
            CON.execute("INSERT INTO accounts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
                acc["id"], acc["login"], acc["kind"], acc.get("name"), placed["galaxy"], placed["region"],
                *placed["center"], *placed["normal"], int(acc["truncated"]), acc["src"], acc["fetched_at"], I.U.today(),
                I.U.PLACEMENT_VERSION, "search", placed["vector"].astype(np.float32).tobytes(),
            ))
            for r, ring, ang, xyz in placed["planets"]:
                CON.execute("INSERT INTO repos VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING", (
                    r["id"], acc["id"], r["name"], r.get("desc"), json.dumps(r.get("topics") or []), r.get("lang"),
                    r.get("stars"), int(bool(r.get("archived"))), r.get("created"), r.get("pushed"), r.get("license"),
                    r.get("observed"), r.get("src"), json.dumps(r.get("packages") or []), ring, ang, *xyz, I.U.today(), 1,
                ))
                for p in r.get("packages") or []:
                    CON.execute("INSERT INTO packages VALUES (?,?,?) ON CONFLICT DO NOTHING", (p["eco"], p["name"], r["id"]))
            CON.executemany("INSERT INTO edges VALUES (?,?,?,?) ON CONFLICT DO NOTHING", edges)
            a = CON.execute("SELECT * FROM accounts WHERE id = ?", (acc["id"],)).fetchone()
            rows = list(CON.execute("SELECT id, account, name, ring, x, y, z, lang, created, stars FROM repos WHERE account = ? ORDER BY placed_at, id", (acc["id"],)))
        s = system_row(a, max((r["ring"] for r in rows), default=-1) + 1)
        s["n"] = len(rows)
        return {
            "status": "added",
            "seconds": round(time.time() - t0, 1),
            "system": s,
            "planets": planets_block(rows, {acc["id"]: -1}),
            "edges": len(edges),
        }


if DIST.exists():
    app.mount("/", StaticFiles(directory=DIST, html=True), name="web")
