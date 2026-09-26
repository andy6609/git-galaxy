#!/usr/bin/env python3
"""E1d 검증: 서버가 새 계정을 들일 때(server/ingest.py의 place) 자리가 납득되는가 (DIRECTION D18)

  배치 장부(universe.db)에서 계정 10%를 뺀 것처럼 두고, 그 계정들을 서버와 똑같은 방식으로 다시 놓는다
  (고정 모델로 계정 벡터 → 비슷한 계정의 은하·지역 → 그 근처 빈자리).
    galaxy_agreement     다시 놓은 은하가 배치 때 은하와 같은 비율
    neighbor_similarity  공간상 가까운 계정 5개와의 계정 벡터 유사도 (다시 놓은 자리 vs 배치 자리 vs 무작위)
결과는 data/build/eval_ingest.json. 장부는 건드리지 않는다.
"""
import json
import sqlite3
import sys
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "pipeline"))
from server import ingest as I  # noqa: E402

U = I.U


def main():
    data = json.loads(U.ACCOUNTS.read_text())
    repos = {r["id"]: r for r in data["repos"]}
    full2id = {r["name"].lower(): r["id"] for r in repos.values()}
    con = sqlite3.connect(U.DB)
    con.row_factory = sqlite3.Row
    rows = [r for r in con.execute("SELECT id, galaxy, region, cx, cy, cz, vec FROM accounts") if r["galaxy"] >= 0]
    counts = dict(con.execute("SELECT account, COUNT(*) FROM repos GROUP BY account").fetchall())
    gal_normals = {g["id"]: np.array([g["nx"], g["ny"], g["nz"]]) for g in con.execute("SELECT id, nx, ny, nz FROM galaxies")}
    model = U.Model.load(U.MODEL)
    by_id = {a["id"]: a for a in data["accounts"]}

    n = len(rows)
    hold = set(np.random.default_rng(7).permutation(n)[: n // 10].tolist())
    keep = [k for k in range(n) if k not in hold]
    V = np.array([np.frombuffer(r["vec"], dtype=np.float32) for r in rows])
    C = np.array([[r["cx"], r["cy"], r["cz"]] for r in rows])
    index = {
        "vectors": V[keep],
        "centers": C[keep],
        "radii": np.array([U.system_radius(counts.get(rows[k]["id"], 1)) for k in keep]),
        "galaxy": [rows[k]["galaxy"] for k in keep],
        "region": [rows[k]["region"] for k in keep],
        "galaxy_normals": gal_normals,
        "galaxy_centers": {g["id"]: np.array([g["cx"], g["cy"], g["cz"]]) for g in con.execute("SELECT id, cx, cy, cz FROM galaxies")},
        "galaxy_radii": {g["id"]: g["radius"] for g in con.execute("SELECT id, radius FROM galaxies")},
        "weak_similarity": float(con.execute("SELECT v FROM meta WHERE k = 'weak_similarity'").fetchone()[0]),
        "universe_extent": float(np.max(np.linalg.norm(C[:, [0, 2]], axis=1))),
    }
    tree = cKDTree(C[keep])
    same_galaxy, sim_new, sim_batch, sim_rand = [], [], [], []
    rng = np.random.default_rng(1)
    for k in sorted(hold):
        acc = by_id.get(rows[k]["id"])
        if not acc:
            continue
        rs = [repos[r] for r in acc["repos"] if r in repos]
        placed = I.place(model, acc, rs, full2id, index)
        v = V[k]
        if np.linalg.norm(placed["vector"]) == 0:
            continue
        same_galaxy.append(placed["galaxy"] == rows[k]["galaxy"])
        _, nb_new = tree.query(placed["center"], k=5)
        _, nb_old = tree.query(C[k], k=5)
        sim_new.append(float(np.mean(V[keep][nb_new] @ v)))
        sim_batch.append(float(np.mean(V[keep][nb_old] @ v)))
        sim_rand.append(float(np.mean(V[keep][rng.integers(0, len(keep), 5)] @ v)))
    out = {
        "held_out": len(same_galaxy),
        "galaxy_agreement": round(float(np.mean(same_galaxy)), 3),
        "neighbor_similarity_ingest": round(float(np.mean(sim_new)), 3),
        "neighbor_similarity_batch": round(float(np.mean(sim_batch)), 3),
        "neighbor_similarity_random": round(float(np.mean(sim_rand)), 3),
    }
    (ROOT / "data/build/eval_ingest.json").write_text(json.dumps(out, indent=1))
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
