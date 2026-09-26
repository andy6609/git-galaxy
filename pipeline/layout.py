#!/usr/bin/env python3
"""E1 배치: data/build/collected.json + data/ledger.json
   → data/ledger.json (새 repo만 추가) + web/public/data/galaxy.json + data/build/metrics.json

원칙 (docs/DIRECTION.md D6, D8)
  - 장부에 이미 있는 행성은 움직이지 않는다. 새 repo만 기존 이웃 근처 빈자리에 놓는다.
  - 은하 모양은 데이터가 만든다. UMAP 결과를 원반으로 눕히기만 하고 모양을 덧씌우지 않는다.
  - 특징이 부족한 repo는 관계 미확정 지역(바깥 고리)에 둔다.
"""
import argparse
import hashlib
import json
import math
import re
import warnings
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from collections import defaultdict
from scipy.sparse import csr_matrix
from scipy.spatial import cKDTree
from sklearn.decomposition import PCA, TruncatedSVD
from sklearn.feature_extraction import DictVectorizer
from sklearn.feature_extraction.text import TfidfTransformer
from sklearn.neighbors import NearestNeighbors
from sklearn.preprocessing import normalize

import hierarchy as H

# numpy 2.0 + macOS Accelerate는 정상 값에도 matmul 경고를 낸다 (E1에서 NaN·inf 없음 확인)
warnings.filterwarnings("ignore", message=".*encountered in matmul", category=RuntimeWarning)

ROOT = Path(__file__).resolve().parent.parent
COLLECTED = ROOT / "data/build/collected.json"
LEDGER = ROOT / "data/ledger.json"
METRICS = ROOT / "data/build/metrics.json"
OUT = ROOT / "web/public/data/galaxy.json"

R = 1000.0                 # 98번째 백분위 반지름
THICK_STD = 60.0           # 원반 두께(표준편차)
MIN_SEP = 4.0              # 행성 사이 최소 간격
UNCHARTED = (1150.0, 1300.0)  # 기본값. 계층 배치에서는 은하 바깥 가장자리에 맞춰 다시 정한다
MIN_INFORMATIVE = 3        # 이보다 토큰이 적으면 관계 미확정
SECTOR = "g0"
PLACEMENT_VERSION = 3       # v2: 지역 → 행성계 → 궤도 (D12) / v3: 지역을 나선팔 위에, 기반 지역은 핵에 (D14)
APPEARANCE_VERSION = 2
SEED = 42

W_WORD, W_TOPIC, W_TOPIC_PART, W_DEP, W_WEAK = 1.0, 2.0, 0.5, 1.5, 0.3
W_OWNER = 0.0              # 개인 repo들이 주제와 상관없이 뭉친다 (E1). 개인 별자리는 선으로 보여준다
PROPAGATE_ALPHA = 0.5      # 이웃 평균을 얼마나 섞을지 (E1 sweep: 0.5·1회가 일관성 손실 최소, hub 개선 큼)
PROPAGATE_ITERS = 1

STOP = set("""
a an the and or of for to in on with by from as at is are be this that it its into your you our we
via using use used uses based simple small fast tiny lightweight library libraries module modules
package packages plugin plugins tool tools utility utilities util utils node nodejs npm js javascript
support supports supported provides provide written easy easily other more new like just all any can
make makes etc also get set way which when will not than then them their has have one two way
""".split())


def hfloat(*parts):
    h = hashlib.sha1(":".join(str(p) for p in parts).encode()).digest()
    return int.from_bytes(h[:8], "big") / 2 ** 64


def today():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


# ---------------------------------------------------------------- 특징

def words(text):
    out = []
    for w in re.findall(r"[a-z0-9가-힣][a-z0-9가-힣+#.\-]*", (text or "").lower()):
        w = w.strip(".-")
        if len(w) < 3 or w in STOP or w.replace(".", "").isdigit():
            continue
        if w.endswith("s") and not w.endswith("ss") and len(w) > 4:
            w = w[:-1]
        out.append(w)
    return out


def norm_topic(t):
    return re.sub(r"[\s_]+", "-", t.strip().lower())


def features(r):
    f = {}

    def add(tok, w):
        if w:
            f[tok] = f.get(tok, 0.0) + w

    texts = {r.get("desc") or ""} | {p.get("desc") or "" for p in r["packages"]}
    for w in set(sum((words(t) for t in texts), [])):
        add("w:" + w, W_WORD)
    # repo topics는 repo 전체의 것이다. 패키지 키워드는 그 키워드를 가진 패키지 비율로 가중한다
    # (React 모노레포의 eslint-plugin 하나가 React 전체를 eslint 지역으로 끌고 가지 않도록)
    share = {norm_topic(t): 1.0 for t in r["topics"] if t}
    for k, v in (r.get("keyword_share") or {}).items():
        t = norm_topic(k)
        if t:
            share[t] = max(share.get(t, 0.0), math.sqrt(v))
    for t, sh in share.items():
        add("t:" + t, W_TOPIC * sh)
        for part in t.split("-"):
            if len(part) >= 3 and part not in STOP:
                add("w:" + part, W_TOPIC_PART * sh)
    for d in r["dep_tokens"]:
        add("d:" + d, W_DEP)
    add("d:r:" + r["id"], W_DEP)  # 자기 토큰: 나를 쓰는 repo와 같은 토큰을 공유한다
    if r.get("lang"):
        add("l:" + r["lang"].lower(), W_WEAK)
    add("o:" + r["name"].split("/")[0].lower(), W_OWNER)
    return f


def propagate(Z, edges, idx, n):
    """관계 → 지리: 확인된 항로로 이어진 이웃의 평균 쪽으로 특징 벡터를 끌어당긴다.
    React처럼 많은 repo가 딛고 선 행성은 그 repo들 한가운데로, 작은 repo는 의존하는 곳 쪽으로 간다."""
    rows, cols, vals = [], [], []
    for e in edges:
        a, b = idx[e["s"]], idx[e["t"]]
        w = 1.0 if e["k"] == "runtime" else 0.6
        rows += [a, b]
        cols += [b, a]
        vals += [w, w]
    A = csr_matrix((vals, (rows, cols)), shape=(n, n))
    A.sum_duplicates()
    deg = np.asarray(A.sum(axis=1)).ravel()
    inv = np.where(deg > 0, 1.0 / np.maximum(deg, 1e-9), 0.0)
    Dinv = csr_matrix((inv, (np.arange(n), np.arange(n))), shape=(n, n))
    for _ in range(PROPAGATE_ITERS):
        Z = normalize(Z + PROPAGATE_ALPHA * (Dinv @ (A @ Z)))
    return Z


@dataclass
class Prepared:
    repos: list
    ids: list
    idx: dict
    X: csr_matrix          # 필터한 토큰 가중치 (TF-IDF 전)
    names: np.ndarray
    df: np.ndarray
    uncharted: np.ndarray  # bool
    Z0: np.ndarray         # SVD 64차원 (정규화)
    Z: np.ndarray          # 항로로 끌어당긴 뒤


def prepare(data):
    repos = data["repos"]
    ids = [r["id"] for r in repos]
    N = len(repos)
    dv = DictVectorizer()
    X = dv.fit_transform([features(r) for r in repos]).tocsc()
    names = np.array(dv.get_feature_names_out())
    df = np.asarray((X > 0).sum(axis=0)).ravel()
    keep = (df >= 2) & (df <= 0.5 * N)
    X = X[:, keep].tocsr()
    names, df = names[keep], df[keep]
    strong = np.array([not (n.startswith("l:") or n.startswith("o:")) for n in names])
    uncharted = np.asarray((X[:, strong] > 0).sum(axis=1)).ravel() < MIN_INFORMATIVE
    Xt = TfidfTransformer(sublinear_tf=True).fit_transform(X)
    Z0 = normalize(TruncatedSVD(n_components=64, n_iter=7, random_state=SEED).fit_transform(Xt))
    idx = {rid: i for i, rid in enumerate(ids)}
    Z = propagate(Z0, data["edges"], idx, N)
    return Prepared(repos, ids, idx, X, names, df, uncharted, Z0, Z)


def knn(Z, k):
    """코사인 이웃 (자기 자신 포함)"""
    return NearestNeighbors(n_neighbors=k, metric="cosine", algorithm="brute").fit(Z).kneighbors(Z)[1]


# ---------------------------------------------------------------- 배치

def separate(P, fixed_mask=None, min_sep=MIN_SEP, iters=40):
    """가까운 쌍을 밀어낸다. fixed_mask가 True인 점은 움직이지 않는다."""
    P = P.copy()
    fixed = np.zeros(len(P), bool) if fixed_mask is None else fixed_mask
    for _ in range(iters):
        pairs = cKDTree(P).query_pairs(min_sep * 0.999, output_type="ndarray")
        if len(pairs) == 0:
            break
        i, j = pairs[:, 0], pairs[:, 1]
        d = P[j] - P[i]
        dist = np.linalg.norm(d, axis=1)
        zero = dist < 1e-6
        if zero.any():
            d[zero] = np.array([[hfloat("sep", a, b) - 0.5, 0.1, hfloat("sep2", a, b) - 0.5] for a, b in pairs[zero]])
            dist[zero] = np.linalg.norm(d[zero], axis=1)
        mv = d * ((min_sep - dist) / dist * 0.5 * 1.05)[:, None]
        wi = (~fixed[i]).astype(float) * np.where(fixed[j], 2.0, 1.0)
        wj = (~fixed[j]).astype(float) * np.where(fixed[i], 2.0, 1.0)
        delta = np.zeros_like(P)
        np.add.at(delta, i, -mv * wi[:, None])
        np.add.at(delta, j, mv * wj[:, None])
        P += delta
    return P


def uncharted_pos(rid, ring=UNCHARTED):
    a = hfloat("uncharted-angle", rid) * 2 * math.pi
    r = ring[0] + hfloat("uncharted-radius", rid) * (ring[1] - ring[0])
    y = (hfloat("uncharted-y", rid) - 0.5) * 40
    return np.array([math.cos(a) * r, y, math.sin(a) * r])


def full_layout(Z):
    import umap  # 무거워서 필요할 때만 불러온다

    Y = umap.UMAP(
        n_components=3, n_neighbors=15, min_dist=0.3, metric="cosine",
        random_state=SEED, init="spectral",
    ).fit_transform(Z)
    Y = Y - np.median(Y, axis=0)
    Yp = PCA(n_components=3, random_state=SEED).fit_transform(Y)  # 분산 큰 순서
    x, z, y = Yp[:, 0], Yp[:, 1], Yp[:, 2]
    s = R / np.percentile(np.hypot(x, z), 98)
    y = (y - y.mean()) * min(s, THICK_STD / (y.std() + 1e-9))
    return np.stack([x * s, y, z * s], axis=1)


def layout_all(prep, edges, subset=None):
    """장부가 비었을 때 한 번만: 지역 → 행성계 → 궤도 배치 (DIRECTION D12).
    subset: 일부만 배치할 때 (eval_placement). 반환: 장부 dict"""
    rows = np.arange(len(prep.ids)) if subset is None else np.asarray(sorted(subset))
    mapped = rows[~prep.uncharted[rows]]
    unch = rows[prep.uncharted[rows]]
    pos, systems, regions, system_of, ring_of, galaxy = H.layout(prep, edges, full_layout(prep.Z[mapped]), mapped)
    extent = max(math.hypot(p[0], p[2]) for p in pos.values())
    ring = (extent + 220.0, extent + 380.0)
    P = {int(i): np.asarray(p) for i, p in pos.items()}
    if len(unch):
        U = np.array([uncharted_pos(prep.ids[i], ring) for i in unch])
        fixed = np.array(list(P.values()))
        both = separate(np.vstack([fixed, U]), fixed_mask=np.r_[np.ones(len(fixed), bool), np.zeros(len(U), bool)])
        for i, p in zip(unch, both[len(fixed):]):
            P[int(i)] = p
    ledger = {
        "version": 3,
        "placement_version": PLACEMENT_VERSION,
        "sector_default": SECTOR,
        "uncharted_ring": [round(ring[0], 1), round(ring[1], 1)],
        "galaxy": {
            "arms": [{"theta0": round(a["theta0"], 5), "length": round(a["length"], 1)} for a in galaxy["arms"]],
            "pitch": round(galaxy["pitch"], 5),
            "r_core": round(galaxy["r_core"], 1),
            "core_extent": round(galaxy["core_extent"], 1),
            "width": galaxy["width"],
            "thickness": galaxy["thickness"],
        },
        "regions": {r["key"]: {"center": rnd(r["center"]), "radius": round(float(r["radius"]), 1), "arm": r["arm"],
                               "arm_pos": r["arm_pos"], "foundation": round(r["foundation"], 3)} for r in regions},
        "systems": {s["key"]: {"center": rnd(s["center"]), "normal": rnd(s["normal"], 5),
                               "region": f"r{s['region']:02d}", "rings": s["rings"]} for s in systems},
        "placements": {},
    }
    for i, p in P.items():
        rid = prep.ids[i]
        rec = {"sector": SECTOR, "pos": rnd(p), "v": PLACEMENT_VERSION, "at": today()}
        if i in system_of:
            rec.update({"how": "system", "sys": system_of[i], "ring": int(ring_of[i])})
        else:
            rec["how"] = "uncharted"
        ledger["placements"][rid] = rec
    return ledger


def rnd(v, nd=3):
    return [round(float(x), nd) for x in v]


def orbit_angle(system_key, center, pos):
    _, u, v = H.orbit_basis(system_key)
    rel = np.asarray(pos) - np.asarray(center)
    return math.atan2(float(rel @ v), float(rel @ u)) % (2 * math.pi)


def join_systems(prep, ledger, new_idx):
    """고정된 행성은 그대로 두고 새 행성만 들인다 (PLAN.md E-6, DIRECTION D12).
    1. 특징 공간에서 가장 가까운 기존 행성 8개가 속한 행성계에 가중 투표
    2. 표를 많이 받은 행성계부터, 바깥 궤도의 빈자리(없으면 새 궤도)에 둔다
    3. 세 곳 모두 자리가 없으면 이웃의 가중 중심 근처 빈자리
    관계가 부족하면 관계 미확정 지역(바깥 고리)의 빈자리. 장부를 제자리에서 고친다."""
    placed, systems = ledger["placements"], ledger["systems"]
    anchors = [prep.idx[rid] for rid, p in placed.items() if rid in prep.idx and p.get("sys")]
    Za = prep.Z[anchors]
    anchor_sys = [placed[prep.ids[i]]["sys"] for i in anchors]
    anchor_pos = np.array([placed[prep.ids[i]]["pos"] for i in anchors])
    blocked = np.array([p["pos"] for p in placed.values()], float)
    tree = cKDTree(blocked)
    extra = []

    def free(c):
        if tree.query(c)[0] < MIN_SEP:
            return False
        return all(np.linalg.norm(c - e) >= MIN_SEP for e in extra)

    taken = defaultdict(list)
    for p in placed.values():
        if p.get("sys"):
            taken[(p["sys"], p["ring"])].append(orbit_angle(p["sys"], systems[p["sys"]]["center"], p["pos"]))

    ring = ledger.get("uncharted_ring", UNCHARTED)
    out = {}
    for i in new_idx:
        rid = prep.ids[i]
        rec = None
        if prep.uncharted[i]:
            cand, n = uncharted_pos(rid, ring), 0
            while not free(cand) and n < 500:
                n += 1
                cand = uncharted_pos(f"{rid}#{n}", ring)
            rec = {"pos": cand, "how": "uncharted"}
        else:
            sims = Za @ prep.Z[i]
            k = min(8, len(sims))
            top = np.argpartition(-sims, k - 1)[:k]
            votes = defaultdict(float)
            for t in top:
                votes[anchor_sys[t]] += max(0.0, float(sims[t])) ** 2 + 1e-6
            for key in sorted(votes, key=lambda x: -votes[x])[:3]:
                s = systems[key]
                kr, ang = H.next_slot(s, {r: taken[(key, r)] for r in s["rings"]}, key)
                cand = H.orbit_point(s["center"], H.orbit_basis(key), kr, ang)
                if free(cand):
                    taken[(key, kr)].append(ang)
                    if kr not in s["rings"]:
                        s["rings"].append(kr)
                    rec = {"pos": cand, "how": "system", "sys": key, "ring": int(kr)}
                    break
            if rec is None:
                w = np.clip(sims[top], 0, None) ** 2 + 1e-6
                centroid = (anchor_pos[top] * w[:, None]).sum(0) / w.sum()
                cand = centroid
                for n in range(1, 2000):
                    if free(cand):
                        break
                    a = hfloat("slot-a", rid, n) * 2 * math.pi
                    e = (hfloat("slot-e", rid, n) - 0.5) * 0.6
                    rr = MIN_SEP * (0.6 + 0.35 * math.sqrt(n))
                    cand = centroid + rr * np.array([math.cos(a) * math.cos(e), math.sin(e), math.sin(a) * math.cos(e)])
                rec = {"pos": cand, "how": "neighbors"}
        extra.append(rec["pos"])
        if len(extra) >= 256:
            blocked = np.vstack([blocked, np.array(extra)])
            tree = cKDTree(blocked)
            extra = []
        placed[rid] = {"sector": SECTOR, "v": PLACEMENT_VERSION, "at": today(), **rec, "pos": rnd(rec["pos"])}
        out[i] = rec
    return out


# ---------------------------------------------------------------- 지표

class Relations:
    """이웃 일관성 판정: 직접 항로 / 흔하지 않은 topic 공유 / 흔하지 않은 dependency 2개 이상 공유"""

    def __init__(self, prep, edges):
        N = len(prep.ids)
        self.E = set()
        for e in edges:
            a, b = prep.idx[e["s"]], prep.idx[e["t"]]
            self.E.add((min(a, b), max(a, b)))
        rare = prep.df <= max(3, 0.05 * N)
        self.names = prep.names
        self.T, self.D = [], []
        for i in range(N):
            cols = prep.X.indices[prep.X.indptr[i]:prep.X.indptr[i + 1]]
            self.T.append({c for c in cols if rare[c] and prep.names[c].startswith("t:")})
            self.D.append({c for c in cols if rare[c] and prep.names[c].startswith("d:")})

    def related(self, i, j):
        return (min(i, j), max(i, j)) in self.E or bool(self.T[i] & self.T[j]) or len(self.D[i] & self.D[j]) >= 2

    def reason(self, i, j):
        why = []
        if (min(i, j), max(i, j)) in self.E:
            why.append("항로")
        if self.T[i] & self.T[j]:
            why.append("topic:" + ",".join(sorted(self.names[c][2:] for c in self.T[i] & self.T[j])[:2]))
        if len(self.D[i] & self.D[j]) >= 2:
            why.append(f"공통 dep {len(self.D[i] & self.D[j])}")
        return " / ".join(why) or "-"

    def coherence(self, nbrs, members):
        fr = []
        for i in members:
            ns = [j for j in nbrs[i] if j != i][:10]
            if ns:
                fr.append(sum(self.related(i, j) for j in ns) / len(ns))
        return float(np.mean(fr)) if fr else 0.0


# ---------------------------------------------------------------- 출력

def planet_record(r, pos, uncharted):
    desc = r.get("desc") or next((p["desc"] for p in r["packages"] if p.get("desc")), None)
    if desc and len(desc) > 140:
        desc = desc[:137].rstrip() + "…"
    tags = []
    for t in r["topics"] + r["keywords"]:
        t = norm_topic(t)
        if t and t not in tags:
            tags.append(t)
    rec = {
        "id": r["id"],
        "n": r["name"],
        "d": desc,
        "t": tags[:6],
        "l": r.get("lang"),
        "s": r.get("stars"),
        "c": (r.get("created") or "")[:10] or None,
        "p": (r.get("pushed") or "")[:10] or None,
        "a": bool(r.get("archived")),
        "lic": r.get("license"),
        "pk": [p["name"] for p in r["packages"][:3]],
        "st": r["stratum"],
        "pl": "uncharted" if uncharted else "mapped",
        "pos": [round(float(v), 1) for v in pos],
        "o": (r.get("observed") or "")[:10] or None,
    }
    if r.get("src") != "ecosyste.ms":
        rec["src"] = r.get("src")
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reset-ledger", action="store_true", help="장부를 비우고 처음부터 배치 (Prototype 튜닝 중에만)")
    args = ap.parse_args()

    data = json.loads(COLLECTED.read_text())
    prep = prepare(data)
    ids, N = prep.ids, len(prep.ids)
    print(f"repo {N}, edge {len(data['edges'])}, 토큰 {prep.X.shape[1]}, 관계 미확정 {int(prep.uncharted.sum())}")

    # --- 장부
    ledger = None
    if LEDGER.exists() and not args.reset_ledger:
        ledger = json.loads(LEDGER.read_text())
        if ledger.get("placement_version", 1) != PLACEMENT_VERSION:
            raise SystemExit(
                f"장부의 배치 버전(v{ledger.get('placement_version', 1)})이 코드(v{PLACEMENT_VERSION})와 다릅니다. "
                "좌표를 모두 바꾸려면 --reset-ledger를 명시하세요 (공개된 주소가 있다면 이동 계획이 먼저입니다)."
            )
    new_idx = [i for i, rid in enumerate(ids) if not ledger or rid not in ledger["placements"]]
    if ledger is None:
        ledger = layout_all(prep, data["edges"])
    elif new_idx:
        join_systems(prep, ledger, new_idx)
    placed = ledger["placements"]
    pos = np.array([placed[rid]["pos"] for rid in ids])
    print(f"새로 배치 {len(new_idx)}, 기존 유지 {N - len(new_idx)}")
    LEDGER.write_text(json.dumps(ledger, indent=1, sort_keys=True))

    # --- 행성계·지역 (이름은 매번 지금의 구성원으로 다시 짓는다. 좌표는 바뀌지 않는다)
    sys_keys = sorted(ledger["systems"])
    sys_index = {k: n for n, k in enumerate(sys_keys)}
    reg_keys = sorted(ledger["regions"])
    reg_index = {k: n for n, k in enumerate(reg_keys)}
    members = defaultdict(list)
    for i, rid in enumerate(ids):
        if placed[rid].get("sys"):
            members[placed[rid]["sys"]].append(i)
    reg_members = defaultdict(list)
    for k in sys_keys:
        reg_members[ledger["systems"][k]["region"]] += members[k]
    systems_out = []
    for k in sys_keys:
        s = ledger["systems"][k]
        systems_out.append({
            "key": k,
            "name": H.name_group(prep, members[k], 1) if members[k] else "",
            "c": [round(v, 1) for v in s["center"]],
            "nrm": [round(v, 4) for v in s["normal"]],
            "rings": [round(H.ring_radius(r), 2) for r in s["rings"]],
            "n": len(members[k]),
            "reg": reg_index[s["region"]],
        })
    regions_out = []
    for k in reg_keys:
        r = ledger["regions"][k]
        regions_out.append({
            "key": k,
            "name": H.name_group(prep, reg_members[k], 2) if reg_members[k] else "",
            "c": [round(v, 1) for v in r["center"]],
            "r": r["radius"],
            "n": len(reg_members[k]),
            "arm": r.get("arm", -1),
            "arm_pos": r.get("arm_pos", 0),
        })
    sizes = sorted((s["n"] for s in systems_out), reverse=True)
    print(f"지역 {len(regions_out)}, 행성계 {len(systems_out)} (크기 중앙값 {sizes[len(sizes) // 2]}, 최대 {sizes[0]})")
    arm_name = lambda a: "핵" if a < 0 else f"팔{a + 1}"
    for a in sorted({r["arm"] for r in regions_out}):
        names = [r["name"] for r in sorted(regions_out, key=lambda r: r["arm_pos"]) if r["arm"] == a]
        print(f"  {arm_name(a)}: " + " → ".join(names))

    # --- 이웃 일관성
    rel = Relations(prep, data["edges"])
    mem = [i for i in range(N) if not prep.uncharted[i]]
    nb_space = cKDTree(pos).query(pos, k=11)[1]
    rng = np.random.default_rng(SEED)
    same_sys = [i for i in mem if placed[ids[i]].get("sys")]
    sys_rel = []
    for i in same_sys:
        mates = [j for j in members[placed[ids[i]]["sys"]] if j != i]
        if mates:
            sys_rel.append(np.mean([rel.related(i, j) for j in mates]))
    m = {
        "layout": rel.coherence(nb_space, mem),
        "feature_space": rel.coherence(knn(prep.Z, 11), mem),
        "feature_space_before_propagation": rel.coherence(knn(prep.Z0, 11), mem),
        "random": rel.coherence(rng.integers(0, N, size=(N, 11)), mem),
        "same_system": float(np.mean(sys_rel)) if sys_rel else 0.0,
    }
    m["ratio_vs_random"] = m["layout"] / max(m["random"], 1e-9)
    gaps = cKDTree(pos).query(pos, k=2)[0][:, 1]
    print("이웃 일관성:", json.dumps({k: round(v, 3) for k, v in m.items()}), f"최소 간격 {gaps.min():.2f}")

    probes = ["mrdoob/three.js", "react/react", "vuejs/core", "sveltejs/svelte", "expressjs/express",
              "eslint/eslint", "d3/d3", "pmndrs/react-three-fiber", "webpack/webpack", "lodash/lodash",
              "chalk/chalk", "prisma/prisma"]
    probes += [r["name"] for r in prep.repos if r["stratum"] == "include"]
    examples = {}
    for name in probes:
        i = next((k for k, r in enumerate(prep.repos) if r["name"] == name), None)
        if i is None:
            continue
        key = placed[ids[i]].get("sys")
        sysname = systems_out[sys_index[key]]["name"] if key else "관계 미확정"
        examples[name] = {
            "system": sysname,
            "region": regions_out[systems_out[sys_index[key]]["reg"]]["name"] if key else "-",
            "neighbors": [f"{prep.repos[j]['name']} ({rel.reason(i, j)})" for j in nb_space[i] if j != i][:6],
        }
    METRICS.write_text(json.dumps({"coherence": m, "examples": examples, "uncharted": int(prep.uncharted.sum()),
                                   "tokens": int(prep.X.shape[1]), "regions": len(regions_out),
                                   "systems": len(systems_out), "system_sizes": sizes}, ensure_ascii=False, indent=1))

    # --- 클라이언트용 출력
    planets = []
    for i, r in enumerate(prep.repos):
        rec = planet_record(r, pos[i], prep.uncharted[i])
        key = placed[ids[i]].get("sys")
        rec["sys"] = sys_index[key] if key else -1
        rec["ring"] = placed[ids[i]].get("ring", -1)
        planets.append(rec)
    edges = [[prep.idx[e["s"]], prep.idx[e["t"]], 0 if e["k"] == "runtime" else 1] for e in data["edges"]]
    observed = sorted(p["o"] for p in planets if p["o"])
    by_stratum = {}
    for p in planets:
        by_stratum[p["st"]] = by_stratum.get(p["st"], 0) + 1
    radius = float(np.percentile(np.hypot(pos[:, 0], pos[:, 2]), 99.5))
    out = {
        "version": 3,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "placement_version": PLACEMENT_VERSION,
        "appearance_version": APPEARANCE_VERSION,
        "scope": "npm 생태계 표본 + 테스트 참가자 repo",
        "observed_range": [observed[0], observed[-1]] if observed else None,
        "sources": data["sources"],
        "data_license": "CC BY-SA 4.0 (ecosyste.ms 파생 데이터)",
        "stats": {"planets": N, "edges": len(edges), "uncharted": int(prep.uncharted.sum()), "by_stratum": by_stratum,
                  "regions": len(regions_out), "systems": len(systems_out), "radius": round(radius, 1)},
        "galaxy": ledger.get("galaxy"),
        "regions": regions_out,
        "systems": systems_out,
        "planets": planets,
        "edges": edges,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"→ {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
