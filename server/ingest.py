"""새 계정 들이기 (Git City처럼 검색한 사람을 그때 추가한다, DIRECTION D18)

  1. GitHub REST (GITHUB_TOKEN이 있으면 시간당 5,000회, 없으면 60회) — 가장 정확
     안 되면 ecosyste.ms (익명 시간당 5,000회, 조금 늦을 수 있음)
  2. repo → 패키지 → 선언된 dependency → 이미 있는 행성이면 항로
  3. 고정 모델(data/model)로 계정 벡터 → 가장 비슷한 계정들의 은하·지역 → 그 근처 빈자리
  4. 궤도는 만든 순서. 기존 행성은 하나도 움직이지 않는다
"""
import json
import math
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))
import universe as U  # noqa: E402
from accounts import declared_deps, repo_record  # noqa: E402

GH = "https://api.github.com"
ECO = "https://packages.ecosyste.ms/api/v1"
REPOS_ECO = "https://repos.ecosyste.ms/api/v1/hosts/GitHub"
UA = "git-galaxy/0.1"
MAX_DEP_PACKAGES = 24


class IngestError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def get_json(url, body=None, timeout=20, github=False):
    headers = {"User-Agent": UA, "Accept": "application/json"}
    if github and os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = f"Bearer {os.environ['GITHUB_TOKEN']}"
    data = json.dumps(body).encode() if body is not None else None
    if data:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode()), r.headers


def fetch_account(login):
    """GitHub → 안 되면 ecosyste.ms. 반환: 계정 dict (repos는 repo_record 목록)"""
    q = urllib.parse.quote(login)
    try:
        user, _ = get_json(f"{GH}/users/{q}", github=True)
        data, _ = get_json(f"{GH}/users/{q}/repos?per_page=100&type=owner&sort=pushed", github=True)
        at = U.today()
        return {
            "id": str(user["id"]),
            "login": user["login"],
            "kind": (user.get("type") or "User").lower(),
            "name": user.get("name"),
            "truncated": len(data) >= 100,
            "src": "github",
            "fetched_at": at,
            "repos": [repo_record(r, "github", at) for r in data if not r.get("fork")],
        }
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise IngestError(404, f"GitHub에 {login} 계정이 없습니다") from e
        if e.code not in (403, 429):
            raise IngestError(502, f"GitHub 응답 {e.code}") from e
    except (OSError, ValueError):
        pass
    # GitHub 한도 초과·연결 실패 → ecosyste.ms
    try:
        data, _ = get_json(f"{REPOS_ECO}/owners/{q}/repositories?per_page=100&sort=pushed_at&order=desc", timeout=30)
    except urllib.error.HTTPError as e:
        raise IngestError(404 if e.code == 404 else 503, "지금은 이 계정을 가져올 수 없습니다") from e
    except (OSError, ValueError) as e:
        raise IngestError(503, "지금은 이 계정을 가져올 수 없습니다") from e
    try:
        owner, _ = get_json(f"{REPOS_ECO}/owners/{q}", timeout=20)
    except (OSError, ValueError):
        owner = None
    if not owner or not owner.get("uuid"):
        raise IngestError(404, f"{login} 계정을 찾지 못했습니다")
    return {
        "id": str(owner["uuid"]),
        "login": owner.get("login") or login,
        "kind": owner.get("kind") or "user",
        "name": owner.get("name"),
        "truncated": len(data) >= 100,
        "src": "ecosyste.ms",
        "fetched_at": U.today(),
        "repos": [repo_record(r, "ecosyste.ms", U.today()) for r in data if not r.get("fork") and r.get("uuid")],
    }


def enrich(repos, known_full):
    """패키지·키워드·dependency를 붙이고, 이미 있는 행성으로 가는 항로를 찾는다.
    known_full: 소문자 full_name → repo id (장부에 있는 행성)"""
    if not repos:
        return []
    # repo 이름과 같은 이름의 패키지만 묻고, 그 패키지가 이 repo를 가리키는지 확인한다.
    # (repo URL로 묻으면 모노레포 하나에 패키지 수천 개가 붙어 응답이 수백 MB가 된다)
    by_full = {r["name"].lower(): r for r in repos}
    short = sorted({r["name"].split("/")[1] for r in repos})
    pkgs = {}
    for eco in ("npm", "pypi", "cargo"):
        for i in range(0, len(short), 100):
            try:
                data, _ = get_json(f"{ECO}/packages/bulk_lookup", body={"names": short[i:i + 100], "ecosystem": eco}, timeout=30)
            except (OSError, ValueError):
                continue
            for p in data or []:
                full = (p.get("repository_url") or "").lower().replace("https://github.com/", "").strip("/")
                if full in by_full:
                    pkgs.setdefault(full, []).append({
                        "eco": eco, "name": p["name"], "version": p.get("latest_release_number"),
                        "downloads": p.get("downloads") or 0, "keywords": [k.lower() for k in (p.get("keywords_array") or [])],
                    })
    todo = []
    for r in repos:
        ps = sorted(pkgs.get(r["name"].lower(), []), key=lambda p: -p["downloads"])[:2]
        r["packages"] = [{"eco": p["eco"], "name": p["name"]} for p in ps]
        r["keywords"] = sorted({k for p in pkgs.get(r["name"].lower(), []) for k in p["keywords"]})[:24]
        todo += [(r, p) for p in ps]
    todo = todo[:MAX_DEP_PACKAGES]

    def deps_of(item):
        try:
            return declared_deps(item[1])
        except Exception:  # noqa: BLE001 — 의존 정보가 없어도 들이는 건 계속한다
            return []

    with ThreadPoolExecutor(8) as ex:
        results = list(ex.map(deps_of, todo))
    by_eco = {}
    for (r, p), ds in zip(todo, results):
        for d in ds:
            by_eco.setdefault(p["eco"], set()).add(d)
    name2full = {}
    for eco, names in by_eco.items():
        names = sorted(names)
        for i in range(0, len(names), 100):
            try:
                data, _ = get_json(f"{ECO}/packages/bulk_lookup", body={"names": names[i:i + 100], "ecosystem": eco}, timeout=30)
            except (OSError, ValueError):
                continue
            for p in data or []:
                full = (p.get("repository_url") or "").lower().replace("https://github.com/", "").strip("/")
                if full.count("/") == 1:
                    name2full[(eco, p["name"].lower())] = full
    edges = []
    for (r, p), ds in zip(todo, results):
        toks = set(r.get("dep_tokens") or [])
        for d in ds:
            full = name2full.get((p["eco"], d.lower()))
            toks.add(f"r:{full}" if full else f"p:{p['eco']}:{d}")
            t = known_full.get(full) if full else None
            if t and t != r["id"]:
                edges.append((r["id"], t, "runtime", d))
        r["dep_tokens"] = sorted(toks)
    return edges


def place(model, account, repos, known_full, index):
    """계정의 자리. index: 서버가 들고 있는 계정 벡터·중심·반지름·은하·지역"""
    feats = [U.repo_features(r, known_full) for r in repos]
    informative = [f for f in feats if sum(1 for t in f if not (t.startswith("l:") or t.startswith("o:"))) >= U.MIN_INFORMATIVE]
    R_new = U.system_radius(len(repos))
    if informative:
        V = model.embed(informative)
        v = V.mean(axis=0)
        v = v / (np.linalg.norm(v) + 1e-9)
    else:
        v = np.zeros(U.SVD_DIM)

    tree = cKDTree(index["centers"])
    reach = R_new + index["radii"].max() + U.SYSTEM_GAP

    def free(c):
        for j in tree.query_ball_point(c, reach):
            if np.linalg.norm(c - index["centers"][j]) < R_new + index["radii"][j] + U.SYSTEM_GAP:
                return False
        return True

    key = account["id"]
    if np.linalg.norm(v) == 0:
        # 관계 미확정: 우주 가장자리 고리
        galaxy, region = -1, -1
        normal = np.array([0.0, 1.0, 0.0])
        r0 = index["universe_extent"] * 1.15
        for n in range(4000):
            a = U.H.hfloat("lost-a", key, n) * 2 * math.pi
            c = np.array([math.cos(a) * r0 * (1 + 0.1 * U.H.hfloat("lost-r", key, n)), (U.H.hfloat("lost-y", key, n) - 0.5) * 200, math.sin(a) * r0])
            if free(c):
                break
    else:
        sims = index["vectors"] @ v
        top = np.argsort(-sims)[:8]
        votes = {}
        for t in top:
            votes[(index["galaxy"][t], index["region"][t])] = votes.get((index["galaxy"][t], index["region"][t]), 0) + max(0.0, float(sims[t])) ** 2
        galaxy, region = max(votes, key=votes.get)
        near = [t for t in top if index["galaxy"][t] == galaxy][:6] or list(top[:6])
        w = np.array([max(0.0, float(sims[t])) ** 2 + 1e-6 for t in near])
        centroid = (index["centers"][near] * w[:, None]).sum(0) / w.sum()
        gnormal = index["galaxy_normals"][galaxy] if galaxy >= 0 else np.array([0.0, 1.0, 0.0])
        n0, u, vv = U.basis_from_normal(gnormal)
        weak = float(sims[top].mean()) < index.get("weak_similarity", 0.0)
        if weak and galaxy in index.get("galaxy_centers", {}):
            # 비슷한 계정이 아직 적다: 이웃 한가운데 끼워 넣지 않고 그 은하의 변두리에 둔다 (region = -1)
            gc = index["galaxy_centers"][galaxy]
            out = centroid - gc
            out -= n0 * (out @ n0)
            out = out / (np.linalg.norm(out) + 1e-9)
            centroid = gc + out * index["galaxy_radii"][galaxy] * 1.12
            region = -1
        c = centroid
        step = R_new + U.SYSTEM_GAP
        for n in range(1, 6000):
            if free(c):
                break
            a = U.H.hfloat("slot-a", key, n) * 2 * math.pi
            rr = step * (0.5 + 0.3 * math.sqrt(n))
            c = centroid + rr * (math.cos(a) * u + math.sin(a) * vv) + n0 * (U.H.hfloat("slot-y", key, n) - 0.5) * step
        normal = U.orbit_normal(key, gnormal)
    rs = sorted(repos, key=lambda r: (r.get("created") or "", r["id"]))
    orbit = U.orbit_positions(c, normal, key, len(rs))
    return {"vector": v, "center": c, "normal": normal, "galaxy": int(galaxy), "region": int(region),
            "radius": R_new, "planets": [(r, ring, ang, xyz) for r, (ring, ang, xyz) in zip(rs, orbit)]}
