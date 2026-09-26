#!/usr/bin/env python3
"""배치 v4 (DIRECTION D16–D18): 계정 = 행성계, 은하·지역은 계정 관계망이 정한다, 모양은 데이터가 만든다.

  data/build/accounts.json
    → data/universe.db    서버가 읽고 쓰는 장부 (계정·repo·좌표·항로)
    → data/model/         새 계정을 배치할 때 쓰는 고정 모델 (어휘·IDF·SVD·계정 벡터)
    → data/build/universe-metrics.json

  행성계   계정 하나. 별 = 계정(repo 아님), 행성 = 그 계정의 공개 repo (fork 제외)
  궤도     만든 순서. 첫 repo가 별에 가장 가깝다. 새 repo는 바깥 궤도로 들어간다
  지역     비슷한 계정들 (계정 관계망의 Leiden)
  은하     더 큰 계정 무리 (낮은 해상도의 Leiden). 이름은 두드러진 언어·주제
  모양     계정 벡터의 UMAP. 은하마다 자기 주축으로 조금 납작하게 눕힌다 (원반). 나선은 강제하지 않는다
"""
import argparse
import json
import math
import sqlite3
import sys
import time
import warnings
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree
from sklearn.decomposition import PCA, TruncatedSVD
from sklearn.feature_extraction import DictVectorizer
from sklearn.feature_extraction.text import TfidfTransformer
from sklearn.neighbors import NearestNeighbors
from sklearn.preprocessing import normalize

sys.path.insert(0, str(Path(__file__).parent))
import hierarchy as H  # noqa: E402
import layout as L  # noqa: E402

warnings.filterwarnings("ignore", message=".*encountered in matmul", category=RuntimeWarning)

ROOT = Path(__file__).resolve().parent.parent
ACCOUNTS = ROOT / "data/build/accounts.json"
DB = ROOT / "data/universe.db"
MODEL = ROOT / "data/model"
METRICS = ROOT / "data/build/universe-metrics.json"

PLACEMENT_VERSION = 5
SEED = 42
SVD_DIM = 64
MIN_INFORMATIVE = 3        # 이보다 토큰이 적은 repo는 계정 벡터에 넣지 않는다
GALAXY_TARGET = (4, 9)     # 은하 수
GALAXY_MIN_SHARE = 0.04    # 이보다 작은 무리는 옆 은하에 합친다
REGION_RESOLUTION = 1.0
REGION_MIN = 6
SYSTEM_GAP = 18.0          # 행성계 사이
ORBIT0 = 6.0               # 첫 궤도 반지름
ORBIT_GAP = 2.0            # 궤도 사이. 궤도 하나에 행성 하나 (DIRECTION D19)
ORBIT_APART = 4.0          # 이웃 궤도의 행성끼리 이보다 가깝지 않게
GALAXY_GAP = 0.6           # 은하 사이 빈 공간 (은하 반지름의 배수)
DISC_FLATTEN = 0.35        # 은하의 가장 얇은 축을 이만큼 누른다
FLAT_UNIVERSE = 0.3        # 은하들끼리의 세로 흩어짐


# ---------------------------------------------------------------- 특징

def repo_features(r, full2id):
    rec = {
        "id": r["id"],
        "name": r["name"],
        "desc": r.get("desc"),
        "packages": [],
        "topics": r.get("topics") or [],
        "keywords": r.get("keywords") or [],
        "keyword_share": {k: 1.0 for k in r.get("keywords") or []},
        "dep_tokens": [],
        "lang": r.get("lang"),
    }
    for t in r.get("dep_tokens") or []:
        if t.startswith("r:"):
            rid = full2id.get(t[2:])
            rec["dep_tokens"].append(f"r:{rid}" if rid else t)
        else:
            rec["dep_tokens"].append(t)
    return L.features(rec)


def sublinear(X):
    """1 이상인 가중치만 1 + log. sklearn의 sublinear_tf는 0.3 같은 약한 가중치를 음수로 뒤집는다
    (E1–E3 배치에 있던 버그: 언어 토큰이 -0.2가 되어 같은 언어끼리 오히려 멀어졌다)"""
    X = X.tocsr(copy=True).astype(float)
    big = X.data >= 1
    X.data[big] = 1 + np.log(X.data[big])
    return X


class Model:
    """새 계정도 같은 공간에 놓을 수 있게 고정해 두는 모델"""

    def __init__(self, names, idf, components):
        self.names = list(names)
        self.index = {n: i for i, n in enumerate(self.names)}
        self.idf = np.asarray(idf)
        self.components = np.asarray(components)

    def embed(self, feats):
        """특징 dict 목록 → 정규화된 SVD 벡터. 모르는 토큰은 버린다"""
        from scipy.sparse import csr_matrix

        rows, cols, vals = [], [], []
        for k, f in enumerate(feats):
            for tok, w in f.items():
                j = self.index.get(tok)
                if j is not None and w > 0:
                    rows.append(k)
                    cols.append(j)
                    vals.append(1 + math.log(w) if w >= 1 else w)  # sublinear()와 같은 변환
        X = csr_matrix((vals, (rows, cols)), shape=(len(feats), len(self.names)))
        X = normalize(X.multiply(self.idf).tocsr())
        return normalize(X @ self.components.T)

    def save(self, path):
        path.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(path / "model.npz", idf=self.idf, components=self.components)
        (path / "vocab.json").write_text(json.dumps(self.names))

    @classmethod
    def load(cls, path):
        z = np.load(path / "model.npz")
        return cls(json.loads((path / "vocab.json").read_text()), z["idf"], z["components"])


# ---------------------------------------------------------------- 묶음

def account_graph(A, members, acc_edges, k=10):
    import igraph as ig

    local = {g: l for l, g in enumerate(members)}
    Am = A[members]
    nb = NearestNeighbors(n_neighbors=min(k + 1, len(members)), metric="cosine", algorithm="brute").fit(Am).kneighbors(Am)[1]
    w = {}
    for a in range(len(members)):
        for b in nb[a][1:]:
            s = float(Am[a] @ Am[b])
            if s > 0:
                key = (min(a, b), max(a, b))
                w[key] = max(w.get(key, 0.0), s)
    for (ga, gb), c in acc_edges.items():
        a, b = local.get(ga), local.get(gb)
        if a is None or b is None or a == b:
            continue
        key = (min(a, b), max(a, b))
        w[key] = w.get(key, 0.0) + min(1.0, 0.25 * c)
    g = ig.Graph(n=len(members), edges=list(w))
    g.es["weight"] = list(w.values())
    return g


def find_galaxies(g):
    """해상도를 올려 가며 은하 수가 GALAXY_TARGET 안에 들어오는 첫 분할"""
    n = g.vcount()
    best = None
    for r in (0.02, 0.04, 0.06, 0.08, 0.12, 0.16, 0.2, 0.3, 0.4, 0.5):
        parts = H.merge_small(g, H.leiden(g, r), max(20, int(GALAXY_MIN_SHARE * n)))
        best = parts
        if len(parts) >= GALAXY_TARGET[0]:
            break
    return best[: GALAXY_TARGET[1]] if len(best) <= GALAXY_TARGET[1] else merge_to(g, best, GALAXY_TARGET[1])


def merge_to(g, parts, k):
    while len(parts) > k:
        parts = sorted(parts, key=len)
        parts = H.merge_small(g, parts, len(parts[0]) + 1)
    return parts


# ---------------------------------------------------------------- 기하

def pack_tree(P, R, gap, iters=300, flatten=1.0):
    """구(반지름 R + gap/2)를 겹치지 않게 민다. 이웃만 본다 (많은 행성계용)"""
    P = np.array(P, float)
    R = np.asarray(R, float) + gap / 2
    reach = 2 * R.max()
    for _ in range(iters):
        pairs = cKDTree(P).query_pairs(reach, output_type="ndarray")
        if len(pairs) == 0:
            break
        i, j = pairs[:, 0], pairs[:, 1]
        d = P[j] - P[i]
        dist = np.linalg.norm(d, axis=1) + 1e-9
        over = R[i] + R[j] - dist
        m = over > 0
        if not m.any():
            break
        i, j, d, dist, over = i[m], j[m], d[m], dist[m], over[m]
        mv = d / dist[:, None] * (over / 2 * 1.02)[:, None]
        delta = np.zeros_like(P)
        np.add.at(delta, i, -mv)
        np.add.at(delta, j, mv)
        delta[:, 1] *= flatten
        P += delta
    return P


def orbit_radius(k):
    return ORBIT0 + k * ORBIT_GAP


def system_radius(n):
    return orbit_radius(max(1, n) - 1) + 3.0


def basis_from_normal(n):
    n = np.asarray(n, float) / np.linalg.norm(n)
    u = np.cross(n, [0.0, 0.0, 1.0])
    if np.linalg.norm(u) < 1e-6:
        u = np.cross(n, [1.0, 0.0, 0.0])
    u /= np.linalg.norm(u)
    return n, u, np.cross(n, u)


def orbit_normal(key, galaxy_normal):
    """행성계 궤도면: 은하 원반에서 최대 24° 기울인다"""
    n0, u0, v0 = basis_from_normal(galaxy_normal)
    tilt = H.hfloat("tilt", key) * H.MAX_TILT
    az = H.hfloat("tilt-az", key) * 2 * math.pi
    n = n0 * math.cos(tilt) + math.sin(tilt) * (u0 * math.cos(az) + v0 * math.sin(az))
    return n / np.linalg.norm(n)


def orbit_positions(center, normal, key, count):
    """만든 순서로 안쪽 궤도부터, 궤도 하나에 행성 하나. 반환: [(ring, angle, xyz)]
    각도는 계정 키와 궤도 번호로 정해지고, 바로 안쪽 두 궤도의 행성과 붙으면 다음 후보로 넘어간다."""
    n, u, v = basis_from_normal(normal)
    out, prev = [], []
    for k in range(count):
        r = orbit_radius(k)
        for salt in range(24):
            a = H.hfloat("phase", key, k, salt) * 2 * math.pi
            if all(r * r + pr * pr - 2 * r * pr * math.cos(a - pa) >= ORBIT_APART ** 2 for pr, pa in prev):
                break
        prev = (prev + [(r, a)])[-2:]
        out.append((k, a, np.asarray(center) + r * (math.cos(a) * u + math.sin(a) * v)))
    return out


# ---------------------------------------------------------------- 장부 (SQLite)

SCHEMA = """
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE galaxies (id INTEGER PRIMARY KEY, name TEXT, cx REAL, cy REAL, cz REAL, nx REAL, ny REAL, nz REAL, radius REAL);
CREATE TABLE regions (id INTEGER PRIMARY KEY, galaxy INTEGER, name TEXT, cx REAL, cy REAL, cz REAL, radius REAL);
CREATE TABLE accounts (
  id TEXT PRIMARY KEY, login TEXT UNIQUE COLLATE NOCASE, kind TEXT, name TEXT,
  galaxy INTEGER, region INTEGER, cx REAL, cy REAL, cz REAL, nx REAL, ny REAL, nz REAL,
  truncated INTEGER, src TEXT, fetched_at TEXT, placed_at TEXT, placement_version INTEGER, origin TEXT,
  vec BLOB
);
CREATE TABLE repos (
  id TEXT PRIMARY KEY, account TEXT, name TEXT COLLATE NOCASE, desc TEXT, topics TEXT, lang TEXT,
  stars INTEGER, archived INTEGER, created TEXT, pushed TEXT, license TEXT, observed TEXT, src TEXT,
  packages TEXT, ring INTEGER, angle REAL, x REAL, y REAL, z REAL, placed_at TEXT, visible INTEGER DEFAULT 1
);
CREATE TABLE edges (s TEXT, t TEXT, kind TEXT, via TEXT, PRIMARY KEY (s, t));
CREATE TABLE packages (eco TEXT, name TEXT COLLATE NOCASE, repo TEXT, PRIMARY KEY (eco, name));
CREATE INDEX repos_account ON repos(account);
CREATE INDEX repos_name ON repos(name);
"""


def today():
    return time.strftime("%Y-%m-%d")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reset", action="store_true", help="장부(universe.db)를 새로 만든다 (Prototype 튜닝 중에만)")
    args = ap.parse_args()
    if DB.exists() and not args.reset:
        raise SystemExit(f"{DB.relative_to(ROOT)}가 이미 있습니다. 좌표를 모두 새로 정하려면 --reset을 명시하세요.")

    t0 = time.time()
    data = json.loads(ACCOUNTS.read_text())
    accounts = data["accounts"]
    repos = {r["id"]: r for r in data["repos"]}
    ids = list(repos)
    idx = {rid: i for i, rid in enumerate(ids)}
    full2id = {r["name"].lower(): r["id"] for r in repos.values()}
    print(f"계정 {len(accounts)}, repo {len(ids)}, 항로 {len(data['edges'])}")

    # --- repo 특징 → SVD (고정 모델로 저장)
    feats = [repo_features(repos[rid], full2id) for rid in ids]
    dv = DictVectorizer()
    X = dv.fit_transform(feats).tocsc()
    names = np.array(dv.get_feature_names_out())
    df = np.asarray((X > 0).sum(axis=0)).ravel()
    N = len(ids)
    keep = (df >= 2) & (df <= 0.5 * N)
    X, names, df = X[:, keep].tocsr(), names[keep], df[keep]
    strong = np.array([not (n.startswith("l:") or n.startswith("o:")) for n in names])
    informative = np.asarray((X[:, strong] > 0).sum(axis=1)).ravel() >= MIN_INFORMATIVE
    Xs = sublinear(X)
    tfidf = TfidfTransformer(sublinear_tf=False).fit(Xs)
    svd = TruncatedSVD(n_components=SVD_DIM, n_iter=7, random_state=SEED).fit(tfidf.transform(Xs))
    model = Model(names, tfidf.idf_, svd.components_)
    Z0 = normalize(svd.transform(tfidf.transform(Xs)))
    edges = [e for e in data["edges"] if e["s"] in idx and e["t"] in idx]
    Z = L.propagate(Z0, edges, idx, N)
    print(f"토큰 {len(names)}, 특징이 충분한 repo {int(informative.sum())}")

    # --- 계정 벡터와 관계망
    acc_ids = [a["id"] for a in accounts]
    acc_idx = {a: k for k, a in enumerate(acc_ids)}
    repo_acc = {rid: a["id"] for a in accounts for rid in a["repos"]}
    A = np.zeros((len(accounts), SVD_DIM))
    for k, a in enumerate(accounts):
        rows = [idx[r] for r in a["repos"] if r in idx and informative[idx[r]]]
        if rows:
            v = Z[rows].mean(axis=0)
            A[k] = v / (np.linalg.norm(v) + 1e-9)
    has_vec = np.linalg.norm(A, axis=1) > 0
    acc_edges = Counter()
    for e in edges:
        a, b = repo_acc.get(e["s"]), repo_acc.get(e["t"])
        if a and b and a != b:
            acc_edges[(acc_idx[a], acc_idx[b])] += 1
    members = [k for k in range(len(accounts)) if has_vec[k]]
    g = account_graph(A, members, acc_edges)
    galaxies = find_galaxies(g)
    print(f"은하 {len(galaxies)}: " + ", ".join(str(len(c)) for c in sorted(galaxies, key=len, reverse=True)))

    gal_of, reg_of, regions = {}, {}, []
    for gi, gv in enumerate(galaxies):
        sub = g.induced_subgraph(gv)
        parts = H.merge_small(sub, H.leiden(sub, REGION_RESOLUTION), REGION_MIN)
        for p in parts:
            rid = len(regions)
            regions.append({"galaxy": gi, "members": [members[gv[v]] for v in p]})
            for v in p:
                gal_of[members[gv[v]]] = gi
                reg_of[members[gv[v]]] = rid
    print(f"지역 {len(regions)}")

    # --- 모양: 계정 벡터의 UMAP, 은하마다 원반으로
    import umap

    Y = umap.UMAP(n_components=3, n_neighbors=15, min_dist=0.4, metric="cosine", random_state=SEED,
                  init="spectral").fit_transform(A[members])
    Yp = {members[k]: Y[k] for k in range(len(members))}
    sys_r = {k: system_radius(len(accounts[k]["repos"])) for k in range(len(accounts))}

    gal_geo = []
    for gi, gv in enumerate(galaxies):
        ks = [members[v] for v in gv]
        P = np.array([Yp[k] for k in ks])
        c = P.mean(axis=0)
        pca = PCA(n_components=3, random_state=SEED).fit(P - c)
        local = (P - c) @ pca.components_.T          # 은하 자기 주축
        local[:, 2] *= DISC_FLATTEN                   # 가장 얇은 축을 누른다
        R = np.array([sys_r[k] for k in ks])
        volume = np.sum((2 * R + SYSTEM_GAP) ** 3)
        target = (volume / DISC_FLATTEN) ** (1 / 3) * 0.75
        spread = np.percentile(np.linalg.norm(local, axis=1), 90) + 1e-9
        local *= target / spread
        # 원반 좌표(x, z가 원반, y가 두께)로 바꿔서 민다
        disc = np.stack([local[:, 0], local[:, 2], local[:, 1]], axis=1)
        disc = pack_tree(disc, R, SYSTEM_GAP, flatten=0.5)
        disc -= disc.mean(axis=0)
        extent = float(np.max(np.linalg.norm(disc, axis=1) + R))
        # 은하마다 기울기가 다른 원반 (자기 주축에서 온 방향)
        tilt = H.hfloat("galaxy-tilt", gi) * math.radians(35)
        az = H.hfloat("galaxy-az", gi) * 2 * math.pi
        normal = np.array([math.sin(tilt) * math.cos(az), math.cos(tilt), math.sin(tilt) * math.sin(az)])
        gal_geo.append({"ks": ks, "disc": disc, "extent": extent, "centroid": c, "normal": normal})

    anchors = np.array([gg["centroid"] for gg in gal_geo])
    anchors -= anchors.mean(axis=0)
    anchors[:, 1] *= FLAT_UNIVERSE
    ext = np.array([gg["extent"] for gg in gal_geo])
    anchors *= (ext.max() * 2.2) / (np.percentile(np.linalg.norm(anchors, axis=1), 90) + 1e-9)
    centers = H.pack(anchors, ext * (1 + GALAXY_GAP), 0, iters=3000, flatten=FLAT_UNIVERSE)
    centers -= centers.mean(axis=0)

    acc_center, acc_normal = {}, {}
    for gi, gg in enumerate(gal_geo):
        n, u, v = basis_from_normal(gg["normal"])
        for k, p in zip(gg["ks"], gg["disc"]):
            acc_center[k] = centers[gi] + p[0] * u + p[2] * v + p[1] * n
            acc_normal[k] = orbit_normal(accounts[k]["id"], gg["normal"])

    # 관계 미확정 계정 (특징 있는 repo가 없음): 우주 가장자리의 고리
    lost = [k for k in range(len(accounts)) if not has_vec[k]]
    u_ext = max(np.linalg.norm(centers[gi]) + gal_geo[gi]["extent"] for gi in range(len(gal_geo)))
    for k in lost:
        a = H.hfloat("lost-a", accounts[k]["id"]) * 2 * math.pi
        r = u_ext * (1.15 + 0.1 * H.hfloat("lost-r", accounts[k]["id"]))
        acc_center[k] = np.array([math.cos(a) * r, (H.hfloat("lost-y", accounts[k]["id"]) - 0.5) * 200, math.sin(a) * r])
        acc_normal[k] = orbit_normal(accounts[k]["id"], [0, 1, 0])
        gal_of[k], reg_of[k] = -1, -1
    if lost:
        P = pack_tree(np.array([acc_center[k] for k in lost]), [sys_r[k] for k in lost], SYSTEM_GAP)
        for k, p in zip(lost, P):
            acc_center[k] = p

    # --- 궤도: 만든 순서
    placements = {}
    for k, a in enumerate(accounts):
        rs = sorted((repos[r] for r in a["repos"] if r in repos), key=lambda r: (r.get("created") or "", r["id"]))
        for r, (ring, ang, xyz) in zip(rs, orbit_positions(acc_center[k], acc_normal[k], a["id"], len(rs))):
            placements[r["id"]] = (ring, ang, xyz)

    # --- 이름
    def rows_of(ks):
        return [idx[r] for k in ks for r in accounts[k]["repos"] if r in idx]

    def lang_label(ks):
        c = Counter(repos[r].get("lang") for k in ks for r in accounts[k]["repos"] if r in repos and repos[r].get("lang"))
        return c.most_common(1)[0][0] if c else None

    prep = L.Prepared(list(repos.values()), ids, idx, X, names, df, ~informative, Z0, Z)
    # 이름: 계정 단위로 센다 (repo 100개짜리 계정 하나가 이름을 좌우하지 않게).
    # 그 무리의 계정 중 몇이 가진 주제인가를 전체와 비교해 두드러진 것. 언어 이름·흔한 태그는 뺀다
    from scipy.sparse import csr_matrix as _csr

    rows_i, cols_i = [], []
    for k, a in enumerate(accounts):
        for r in a["repos"]:
            if r in idx:
                rows_i.append(k)
                cols_i.append(idx[r])
    M = _csr((np.ones(len(rows_i)), (rows_i, cols_i)), shape=(len(accounts), N))
    AT = ((M @ (X > 0).astype(float)) > 0).astype(float).tocsc()   # 계정 × 토큰
    acc_df = np.asarray(AT.sum(axis=0)).ravel()
    NA = len(accounts)
    SKIP = {"python", "python3", "rust", "rust-lang", "javascript", "typescript", "js", "ts", "node", "nodejs", "node.j",
            "go", "golang", "java", "ruby", "php", "c", "cpp", "c++", "html", "css", "shell", "npm", "pypi", "crate",
            "hacktoberfest", "example", "library", "file", "extension", "project", "code", "app", "tool", "api"}
    namable = np.array([(n.startswith("t:") or n.startswith("d:")) for n in names])

    def name_accounts(ks, n_labels):
        sub = AT[ks]
        cnt = np.asarray(sub.sum(axis=0)).ravel()
        fg = cnt / max(1, len(ks))
        f = acc_df / NA
        ok = namable & (cnt >= max(2, 0.12 * len(ks)))
        score = np.where(ok, fg * np.log(np.maximum(fg, 1e-9) / np.maximum(f, 1e-9)), -1)
        labels = []
        for c in np.argsort(-score)[:80]:
            if score[c] <= 0:
                break
            lab = H.token_label(prep, names[c])
            if not lab or lab.lower() in SKIP or len(lab) < 2 or any(lab in l or l in lab for l in labels):
                continue
            labels.append(lab)
            if len(labels) >= n_labels:
                break
        return labels

    gal_names = []
    for gg in gal_geo:
        lang = lang_label(gg["ks"])
        topic = name_accounts(gg["ks"], 1)
        gal_names.append(" · ".join([x for x in [lang] + topic if x]) or "—")
    reg_names = [" · ".join(name_accounts(r["members"], 2)) or (lang_label(r["members"]) or "—") for r in regions]

    # --- 지표: 계정 이웃이 관련 있나
    rel = L.Relations(prep, edges)
    pos = np.array([placements[rid][2] for rid in ids])
    nb = cKDTree(pos).query(pos, k=11)[1]
    mem = [i for i in range(N) if informative[i]]
    same_acc = defaultdict(list)
    for rid in ids:
        same_acc[repo_acc[rid]].append(idx[rid])
    m = {
        "planet_layout": rel.coherence(nb, mem),
        "random": rel.coherence(np.random.default_rng(SEED).integers(0, N, size=(N, 11)), mem),
    }
    C = np.array([acc_center[k] for k in members])
    anb = cKDTree(C).query(C, k=6)[1]
    related_acc = []
    for a_i, row in enumerate(anb):
        ka = members[a_i]
        related_acc.append(np.mean([float(A[ka] @ A[members[b]]) for b in row[1:]]))
    rnd = np.random.default_rng(1).integers(0, len(members), size=(len(members), 5))
    m["account_neighbor_similarity"] = float(np.mean(related_acc))
    m["account_random_similarity"] = float(np.mean([np.mean([float(A[members[a]] @ A[members[b]]) for b in row]) for a, row in enumerate(rnd)]))

    # 새 계정이 '비슷한 계정이 있다'고 할 만한 기준: 표본 계정의 이웃 8개 평균 유사도 하위 10%
    Am = A[members]
    S = Am @ Am.T
    np.fill_diagonal(S, -1)
    top8 = np.sort(S, axis=1)[:, -8:].mean(axis=1)
    weak_similarity = float(np.percentile(top8, 10))
    m["weak_similarity"] = weak_similarity

    # --- 장부 쓰기
    if DB.exists():
        DB.unlink()
    db = sqlite3.connect(DB)
    db.executescript(SCHEMA)
    db.executemany("INSERT INTO meta VALUES (?, ?)", [
        ("placement_version", str(PLACEMENT_VERSION)), ("generated_at", data["generated_at"]),
        ("sources", json.dumps(data["sources"], ensure_ascii=False)),
        ("weak_similarity", f"{weak_similarity:.4f}"),
    ])
    for gi, gg in enumerate(gal_geo):
        db.execute("INSERT INTO galaxies VALUES (?,?,?,?,?,?,?,?,?)",
                   (gi, gal_names[gi], *centers[gi], *gg["normal"], gg["extent"]))
    for ri, r in enumerate(regions):
        c = np.mean([acc_center[k] for k in r["members"]], axis=0)
        rad = max(np.linalg.norm(acc_center[k] - c) + sys_r[k] for k in r["members"])
        db.execute("INSERT INTO regions VALUES (?,?,?,?,?,?,?)", (ri, r["galaxy"], reg_names[ri], *c, rad))
    for k, a in enumerate(accounts):
        db.execute("INSERT INTO accounts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
            a["id"], a["login"], a["kind"], a.get("name"), gal_of.get(k, -1), reg_of.get(k, -1),
            *acc_center[k], *acc_normal[k], int(a["truncated"]), a["src"], a["fetched_at"], today(),
            PLACEMENT_VERSION, a.get("origin"), A[k].astype(np.float32).tobytes(),
        ))
    for rid, r in repos.items():
        if rid not in placements:
            continue
        ring, ang, xyz = placements[rid]
        db.execute("INSERT INTO repos VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
            rid, repo_acc[rid], r["name"], r.get("desc"), json.dumps(r.get("topics") or []), r.get("lang"),
            r.get("stars"), int(bool(r.get("archived"))), r.get("created"), r.get("pushed"), r.get("license"),
            r.get("observed"), r.get("src"), json.dumps(r.get("packages") or []), ring, ang, *xyz, today(), 1,
        ))
        for p in r.get("packages") or []:
            db.execute("INSERT OR IGNORE INTO packages VALUES (?,?,?)", (p["eco"], p["name"], rid))
    db.executemany("INSERT OR IGNORE INTO edges VALUES (?,?,?,?)", [(e["s"], e["t"], e["k"], e.get("via")) for e in edges])
    db.commit()
    db.close()
    model.save(MODEL)

    sizes = Counter(gal_of.values())
    summary = {
        "accounts": len(accounts), "repos": len(placements), "galaxies": len(galaxies), "regions": len(regions),
        "lost_accounts": len(lost), "galaxy_names": gal_names, "galaxy_sizes": [sizes[i] for i in range(len(galaxies))],
        "coherence": m, "seconds": round(time.time() - t0, 1),
    }
    METRICS.write_text(json.dumps(summary, ensure_ascii=False, indent=1))
    print(json.dumps(summary, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
