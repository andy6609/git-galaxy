#!/usr/bin/env python3
"""계정 표본 수집 (배치 v4, DIRECTION D16): 계정 = 행성계, 그 계정의 공개 repo = 행성

  1. 계정 고르기
       npm   기존 표본(collect.py)의 repo 주인
       PyPI  ecosyste.ms 패키지 목록(다운로드·의존·키워드)의 repo 주인
       Rust  crates.io 같은 방식
       + data/include.txt (GitHub API로 직접, 가장 정확)
     층을 나눠 뽑는다: 유명한 계정만이 아니라 작은 계정도 (DIRECTION K9)
  2. 계정마다 공개 repo (fork 제외) — repos.ecosyste.ms, 최근 push 순 최대 100개
  3. repo → 패키지 (bulk lookup) → 선언된 dependency (deps.dev) → dependency의 repo
     표본 안의 repo끼리만 항로가 된다

출력: data/build/accounts.json
"""
import json
import random
import sys
import time
import urllib.parse
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from collect import BUILD, DEPSDEV, ECO, GH, INCLUDE, fetch, hkey, now_iso, pmap  # noqa: E402

REPOS_ECO = "https://repos.ecosyste.ms/api/v1/hosts/GitHub"
TARGET = {"npm": 1400, "pypi": 520, "cargo": 360}
REPOS_PER_ACCOUNT = 100
PKGS_PER_REPO = 2
DEPS_SYSTEM = {"npm": "npm", "pypi": "pypi", "cargo": "cargo"}
REGISTRY = {"pypi": "pypi.org", "cargo": "crates.io"}
KEYWORDS = {
    "pypi": ["machine-learning", "data", "web", "cli", "async", "database", "api", "testing", "science",
             "visualization", "nlp", "django", "flask", "image", "audio", "security", "devops", "game"],
    "cargo": ["cli", "async", "web", "parser", "database", "game", "graphics", "wasm", "embedded",
              "crypto", "network", "serialization", "gui", "terminal", "compiler", "audio"],
}


def owner_of(repo_metadata):
    rm = repo_metadata or {}
    if (rm.get("host") or {}).get("name") not in (None, "GitHub"):
        return None
    full = rm.get("full_name") or ""
    return full.split("/")[0].lower() if "/" in full else None


# ---------------------------------------------------------------- 1. 계정 고르기

def npm_owners():
    data = json.loads((BUILD / "collected.json").read_text())
    by_owner = defaultdict(list)
    for r in data["repos"]:
        by_owner[r["name"].split("/")[0].lower()].append(r)
    rows = []
    for owner, rs in by_owner.items():
        best = max(rs, key=lambda r: r.get("stars") or 0)
        rows.append((owner, best.get("stars") or 0, {r["stratum"] for r in rs}))
    return rows


def registry_owners(eco):
    reg = REGISTRY[eco]
    urls = [
        f"{ECO}/registries/{reg}/packages?sort={sort}&order=desc&per_page=100&page={page}"
        for sort in ("downloads", "dependent_packages_count")
        for page in range(1, 6)
    ]
    urls += [f"{ECO}/keywords/{urllib.parse.quote(k)}?per_page=100&page={p}" for k in KEYWORDS[eco] for p in (1, 2)]
    stars = {}
    for data, _ in pmap(fetch, urls):
        pkgs = data.get("packages") if isinstance(data, dict) else data
        for p in pkgs or []:
            if p.get("ecosystem") not in (None, eco):
                continue
            o = owner_of(p.get("repo_metadata"))
            if o:
                stars[o] = max(stars.get(o, 0), (p.get("repo_metadata") or {}).get("stargazers_count") or 0)
    return [(o, s, {"registry"}) for o, s in stars.items()]


def stratified(rows, n, salt):
    """40%는 가장 알려진 계정, 60%는 나머지에서 고르게 (작은 계정 포함)"""
    rows = sorted(rows, key=lambda r: (-r[1], r[0]))
    top = rows[: int(n * 0.4)]
    rest = sorted(rows[int(n * 0.4):], key=lambda r: hkey(salt, r[0]))
    small = [r for r in rest if r[1] < 20]
    other = [r for r in rest if r[1] >= 20]
    k_small = min(len(small), int(n * 0.3))
    picked = top + small[:k_small] + other[: n - len(top) - k_small]
    return [r[0] for r in picked[:n]]


# ---------------------------------------------------------------- 2. 계정의 repo

def repo_record(r, src, fetched_at):
    lic = r.get("license")
    if isinstance(lic, dict):
        lic = (lic.get("spdx_id") or lic.get("key") or "").lower() or None
    return {
        "id": str(r.get("uuid") or r.get("id")),
        "name": r["full_name"],
        "desc": " ".join((r.get("description") or "").split()) or None,
        "topics": [t.lower() for t in (r.get("topics") or [])],
        "lang": r.get("language"),
        "stars": r.get("stargazers_count"),
        "forks": r.get("forks_count"),
        "archived": bool(r.get("archived")),
        "created": r.get("created_at"),
        "pushed": r.get("pushed_at"),
        "license": lic,
        "size": r.get("size"),
        "observed": r.get("updated_at") if src == "ecosyste.ms" else fetched_at,
        "src": src,
    }


def fetch_account_eco(login):
    url = f"{REPOS_ECO}/owners/{urllib.parse.quote(login)}/repositories?per_page={REPOS_PER_ACCOUNT}&sort=pushed_at&order=desc"
    data, at = fetch(url)
    if not isinstance(data, list) or not data:
        return None
    repos = [repo_record(r, "ecosyste.ms", at) for r in data if not r.get("fork") and r.get("uuid") and r.get("full_name")]
    if not repos:
        return None
    # repo 목록에는 계정 id가 없다 → 계정 정보를 따로 묻는다
    owner, _ = fetch(f"{REPOS_ECO}/owners/{urllib.parse.quote(login)}")
    owner = owner if isinstance(owner, dict) else {}
    return {
        "login": (owner.get("login") or login),
        "id": str(owner.get("uuid") or ""),
        "kind": owner.get("kind") or "user",
        "name": owner.get("name"),
        "truncated": len(data) >= REPOS_PER_ACCOUNT,
        "src": "ecosyste.ms",
        "fetched_at": at,
        "repos": repos,
    }


def fetch_account_github(login):
    user, at = fetch(f"{GH}/users/{urllib.parse.quote(login)}", min_remaining=0)
    data, at = fetch(f"{GH}/users/{urllib.parse.quote(login)}/repos?per_page=100&type=owner&sort=pushed", min_remaining=0)
    if not isinstance(data, list) or not isinstance(user, dict):
        return None
    repos = [repo_record(r, "github", at) for r in data if not r.get("fork")]
    return {
        "login": user.get("login") or login,
        "id": str(user.get("id")),
        "kind": (user.get("type") or "User").lower(),
        "name": user.get("name"),
        "truncated": len(data) >= 100,
        "src": "github",
        "fetched_at": at,
        "repos": repos,
    }


# ---------------------------------------------------------------- 3. 패키지와 항로

def registry_packages():
    """PyPI·Rust 레지스트리 목록(계정 고를 때 받아 둔 응답)의 패키지 → repo.
    repo URL로 bulk lookup을 하면 모노레포 하나에 패키지 수천 개가 붙어 응답이 수백 MB가 된다 (E3에서 325MB)."""
    out = defaultdict(list)
    for eco, reg in REGISTRY.items():
        urls = [f"{ECO}/registries/{reg}/packages?sort={sort}&order=desc&per_page=100&page={page}"
                for sort in ("downloads", "dependent_packages_count") for page in range(1, 6)]
        urls += [f"{ECO}/keywords/{urllib.parse.quote(k)}?per_page=100&page={p}" for k in KEYWORDS[eco] for p in (1, 2)]
        for data, _ in pmap(fetch, urls):
            pkgs = data.get("packages") if isinstance(data, dict) else data
            for p in pkgs or []:
                if p.get("ecosystem") != eco:
                    continue
                full = ((p.get("repo_metadata") or {}).get("full_name") or "").lower()
                if full.count("/") == 1:
                    out[full].append({
                        "eco": eco, "name": p["name"], "version": p.get("latest_release_number"),
                        "downloads": p.get("downloads") or 0,
                        "keywords": [k.lower() for k in (p.get("keywords_array") or [])],
                    })
    return out


def declared_deps(pkg):
    """deps.dev: npm·PyPI는 선언된 requirements, Cargo는 해석된 그래프의 직접 의존"""
    system = DEPS_SYSTEM[pkg["eco"]]
    if not pkg.get("version"):
        return []
    base = f"{DEPSDEV}/systems/{system}/packages/{urllib.parse.quote(pkg['name'], safe='')}/versions/{urllib.parse.quote(pkg['version'], safe='')}"
    if system == "cargo":
        data, _ = fetch(f"{base}:dependencies", min_remaining=0)
        return sorted({n["versionKey"]["name"] for n in (data or {}).get("nodes", []) if n.get("relation") == "DIRECT"})
    data, _ = fetch(f"{base}:requirements", min_remaining=0)
    if system == "npm":
        d = ((data or {}).get("npm") or {}).get("dependencies") or {}
        return sorted({x["name"] for x in (d.get("dependencies") or []) + (d.get("peerDependencies") or [])})
    d = ((data or {}).get("pypi") or {}).get("dependencies") or []
    return sorted({x["projectName"].lower() for x in d if not x.get("environmentMarker")})


def resolve_names(eco, names):
    """패키지 이름 → GitHub repo (full_name, 소문자)"""
    names = sorted(set(names))
    chunks = [names[i:i + 100] for i in range(0, len(names), 100)]
    out = {}
    for data, _ in pmap(lambda c: fetch(f"{ECO}/packages/bulk_lookup", body={"names": c, "ecosystem": eco}), chunks):
        for p in data or []:
            full = (p.get("repository_url") or "").lower().replace("https://github.com/", "").strip("/")
            if full.count("/") == 1:
                out[p["name"].lower() if eco == "pypi" else p["name"]] = full
    return out


def main():
    t0 = time.time()
    print("1/4 계정 고르기")
    seeds = {
        "npm": stratified(npm_owners(), TARGET["npm"], "npm"),
        "pypi": stratified(registry_owners("pypi"), TARGET["pypi"], "pypi"),
        "cargo": stratified(registry_owners("cargo"), TARGET["cargo"], "cargo"),
    }
    origin = {}
    for eco, owners in seeds.items():
        for o in owners:
            origin.setdefault(o, eco)
    include = []
    if INCLUDE.exists():
        for line in INCLUDE.read_text().splitlines():
            line = line.split("#")[0].strip()
            if line.startswith("user:"):
                include.append(line[5:].lower())
    for o in include:
        origin[o] = "include"
    print("    " + ", ".join(f"{k} {v}" for k, v in Counter(origin.values()).items()))

    print("2/4 계정의 repo")
    logins = sorted(origin)
    accounts = {}
    for login, acc in zip(logins, pmap(lambda l: fetch_account_github(l) if origin[l] == "include" else fetch_account_eco(l), logins)):
        if acc and acc["repos"] and acc["id"]:
            acc["origin"] = origin[login]
            accounts[acc["id"]] = acc
    repos = [r for a in accounts.values() for r in a["repos"]]
    seen = set()
    repos = [r for r in repos if not (r["id"] in seen or seen.add(r["id"]))]
    print(f"    계정 {len(accounts)}, repo {len(repos)}")

    print("3/4 패키지와 dependency")
    # npm 표본(collect.py)이 이미 가진 패키지·dependency를 그대로 쓴다
    col = json.loads((BUILD / "collected.json").read_text())
    col_by_id = {r["id"]: r for r in col["repos"]}
    col_name = {r["id"]: r["name"].lower() for r in col["repos"]}
    reg = registry_packages()
    todo = []
    for r in repos:
        r["packages"], r["keywords"], r["dep_tokens"] = [], [], []
        c = col_by_id.get(r["id"])
        if c:
            r["packages"] = [{"eco": "npm", "name": p["name"]} for p in c["packages"][:PKGS_PER_REPO]]
            r["keywords"] = list(c.get("keywords") or [])[:24]
            for t in c["dep_tokens"]:
                if t.startswith("r:"):
                    name = col_name.get(t[2:])
                    r["dep_tokens"].append(f"r:{name}" if name else f"q:{t[2:]}")
                else:
                    r["dep_tokens"].append(f"p:npm:{t[2:]}")
        ps = sorted(reg.get(r["name"].lower(), []), key=lambda p: -p["downloads"])[:PKGS_PER_REPO]
        if ps:
            r["packages"] += [{"eco": p["eco"], "name": p["name"]} for p in ps]
            r["keywords"] = sorted(set(r["keywords"]) | {k for p in ps for k in p["keywords"]})[:24]
            todo += [(r["id"], p) for p in ps]
    deps = pmap(lambda x: declared_deps(x[1]), todo, workers=8)
    by_eco = defaultdict(set)
    repo_deps = defaultdict(list)
    for (rid, p), ds in zip(todo, deps):
        for d in ds:
            by_eco[p["eco"]].add(d)
            repo_deps[rid].append((p["eco"], d))
    name2repo = {eco: resolve_names(eco, names) for eco, names in by_eco.items()}
    print(f"    npm 표본과 겹친 repo {sum(1 for r in repos if r['id'] in col_by_id)}, "
          f"PyPI·Rust 패키지 {len(todo)}, dependency 이름 {sum(len(v) for v in by_eco.values())}")

    print("4/4 항로")
    ids = {r["id"] for r in repos}
    full2id = {r["name"].lower(): r["id"] for r in repos}
    edges = {}
    for e in col["edges"]:  # npm 표본의 항로 중 이번 표본 안의 것
        if e["s"] in ids and e["t"] in ids:
            edges[(e["s"], e["t"])] = {"s": e["s"], "t": e["t"], "k": e["k"], "via": e.get("via")}
    for r in repos:
        tokens = set(r["dep_tokens"])
        for eco, d in repo_deps.get(r["id"], []):
            full = name2repo.get(eco, {}).get(d.lower() if eco == "pypi" else d)
            tokens.add(f"r:{full}" if full else f"p:{eco}:{d}")
            t = full2id.get(full) if full else None
            if t and t != r["id"]:
                edges[(r["id"], t)] = {"s": r["id"], "t": t, "k": "runtime", "via": d}
        r["dep_tokens"] = sorted(tokens)
    for a in accounts.values():
        a["repos"] = [r["id"] for r in a["repos"]]
    out = {
        "generated_at": now_iso(),
        "sources": [
            {"name": "ecosyste.ms", "url": "https://ecosyste.ms", "license": "CC BY-SA 4.0"},
            {"name": "deps.dev", "url": "https://deps.dev", "use": "npm · PyPI · Cargo dependencies"},
            {"name": "GitHub REST API", "url": "https://api.github.com", "use": "include 목록, 서버의 새 계정"},
        ],
        "accounts": list(accounts.values()),
        "repos": repos,
        "edges": list(edges.values()),
        "stats": {
            "accounts": len(accounts),
            "by_origin": dict(Counter(a["origin"] for a in accounts.values())),
            "repos": len(repos),
            "truncated_accounts": sum(1 for a in accounts.values() if a["truncated"]),
            "edges": len(edges),
            "seconds": round(time.time() - t0, 1),
        },
    }
    (BUILD / "accounts.json").write_text(json.dumps(out, ensure_ascii=False))
    print(json.dumps(out["stats"], ensure_ascii=False, indent=1))


if __name__ == "__main__":
    random.seed(0)
    main()
