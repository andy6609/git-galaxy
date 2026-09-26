#!/usr/bin/env python3
"""E1 검증: 장부를 고정한 채 새 repo를 넣어도 지도가 납득되는가 (PLAN.md E-6, DIRECTION D6).

  1. 표본의 90%만으로 전체 배치한다 (이미 공개된 장부라고 가정)
  2. 남은 10%를 place_incremental로 추가한다 (기존 행성은 움직이지 않는다)
  3. 추가된 repo들의 이웃 일관성을, 100%를 한 번에 배치했을 때 같은 repo들의 값과 비교한다

결과는 data/build/eval_placement.json
"""
import json
import sys
import time
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).parent))
import layout as L  # noqa: E402


def main():
    data = json.loads(L.COLLECTED.read_text())
    prep = L.prepare(data)
    N = len(prep.ids)
    rel = L.Relations(prep, data["edges"])
    hold = set(np.random.default_rng(7).permutation(N)[: N // 10].tolist())
    base = [i for i in range(N) if i not in hold]
    new = sorted(hold)

    t0 = time.time()
    ledger = L.layout_all(prep, data["edges"], subset=base)
    t1 = time.time()
    got = L.join_systems(prep, ledger, new)
    t2 = time.time()
    P_inc = np.array([ledger["placements"][rid]["pos"] for rid in prep.ids])
    full = L.layout_all(prep, data["edges"])
    P_full = np.array([full["placements"][rid]["pos"] for rid in prep.ids])

    members_new = [i for i in new if not prep.uncharted[i]]
    members_base = [i for i in base if not prep.uncharted[i]]
    nb_inc = cKDTree(P_inc).query(P_inc, k=11)[1]
    nb_full = cKDTree(P_full).query(P_full, k=11)[1]
    min_gap = float(cKDTree(P_inc).query(P_inc, k=2)[0][:, 1].min())
    how = {}
    for rec in got.values():
        how[rec["how"]] = how.get(rec["how"], 0) + 1
    # 새 행성이 들어간 행성계의 기존 구성원과 관련 있는 비율
    by_sys = {}
    for i in base:
        k = ledger["placements"][prep.ids[i]].get("sys")
        if k:
            by_sys.setdefault(k, []).append(i)
    joined = []
    for i, rec in got.items():
        if rec.get("sys") and by_sys.get(rec["sys"]):
            joined.append(np.mean([rel.related(i, j) for j in by_sys[rec["sys"]]]))
    out = {
        "repos": N,
        "held_out": len(new),
        "new_incremental": rel.coherence(nb_inc, members_new),
        "new_if_full_layout": rel.coherence(nb_full, members_new),
        "base_after_insert": rel.coherence(nb_inc, members_base),
        "random": rel.coherence(np.random.default_rng(1).integers(0, N, size=(N, 11)), members_new),
        "joined_how": how,
        "new_related_to_system": float(np.mean(joined)) if joined else 0.0,
        "base_moved": 0,
        "min_gap": round(min_gap, 3),
        "seconds_layout_90": round(t1 - t0, 1),
        "seconds_insert_10": round(t2 - t1, 2),
    }
    (L.ROOT / "data/build/eval_placement.json").write_text(json.dumps(out, indent=1))
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
