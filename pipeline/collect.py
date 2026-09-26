#!/usr/bin/env python3
"""E1 수집: npm 생태계 표본 + include 목록 → data/build/collected.json

소스
  ecosyste.ms packages API  패키지 목록, 패키지→GitHub repo, repo 정보 (데이터 CC BY-SA 4.0)
  deps.dev requirements     최신 버전의 dependencies / peerDependencies
                            (npm registry는 동시 요청에 429를 준다. deps.dev가 같은 manifest 정보를 준다)
  GitHub REST (비인증)       include 목록 전용
  raw.githubusercontent.com include repo의 package.json

모든 응답은 data/raw/cache/ 에 fetched_at과 함께 캐시한다. 다시 돌려도 API를 다시 부르지 않는다.
표본 구성은 docs/PROTOTYPE_SPEC.md §5를 따른다.
"""
import hashlib
import json
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data/raw/cache"
BUILD = ROOT / "data/build"
INCLUDE = ROOT / "data/include.txt"

UA = "git-galaxy-prototype/0.1"
ECO = "https://packages.ecosyste.ms/api/v1"
DEPSDEV = "https://api.deps.dev/v3"
GH = "https://api.github.com"
RAW = "https://raw.githubusercontent.com"

TARGET = {"landmark": 1600, "varied": 3200, "small": 2000, "neighbor": 1200}
STAR_BUCKETS = [(0, 9), (10, 99), (100, 999), (1000, 9999), (10000, float("inf"))]
SMALL_MAX_STARS = 19
LANDMARK_PAGES = 15
KEYWORD_PAGES = 5
PKGS_PER_REPO = 3

# 분야를 넓게 덮는 키워드. 순서는 의미 없음.
KEYWORDS = [
    "react", "vue", "svelte", "angular", "solid", "web-components", "webgl", "threejs",
    "canvas", "svg", "d3", "chart", "visualization", "animation", "audio", "music",
    "game", "physics", "cli", "terminal", "parser", "compiler", "ast", "eslint",
    "linter", "formatter", "typescript", "testing", "mock", "http", "server", "framework",
    "api", "graphql", "websocket", "database", "sql", "orm", "cache", "queue",
    "stream", "crypto", "security", "authentication", "jwt", "markdown", "editor", "i18n",
    "date", "math", "geometry", "color", "image", "video", "pdf", "ai",
    "llm", "machine-learning", "nlp", "bot", "discord", "blockchain", "ethereum", "iot",
    "serialport", "bluetooth", "arduino", "react-native", "electron", "bundler", "webpack", "vite",
    "build", "css", "tailwind", "sass", "design-system", "ui", "components", "icons",
    "font", "accessibility", "map", "geo", "finance", "science", "education", "generative-art",
    "creative-coding", "shader", "wasm", "emoji", "github", "git", "docker", "kubernetes",
    "aws", "serverless", "logging", "monitoring", "email", "scraper", "crawler", "proxy",
    "ssh", "compression", "encoding", "validation", "schema", "json", "yaml", "config",
    "state-management", "router", "forms", "table", "drag-and-drop", "virtual-dom", "static-site", "blog",
    "documentation", "monorepo", "package-manager", "benchmark", "performance",
]

_stats = {"cache": 0, "net": 0, "miss": 0, "err": 0}
_stats_lock = threading.Lock()


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def hkey(*parts):
    """결정론적 정렬 키. 무작위 추출을 재현 가능하게 만든다."""
    return hashlib.sha1(":".join(parts).encode()).hexdigest()


def _bump(k):
    with _stats_lock:
        _stats[k] += 1


REPO_KEYS = {"uuid", "id", "full_name", "owner", "description", "topics", "language", "stargazers_count", "forks_count",
             "fork", "archived", "created_at", "pushed_at", "license", "size", "updated_at", "default_branch", "host",
             "html_url", "status", "type", "login", "name"}
PKG_KEYS = {"ecosystem", "name", "repository_url", "latest_release_number", "downloads", "keywords_array", "description",
            "dependent_packages_count", "dependent_repos_count", "status", "repo_metadata", "repo_metadata_updated_at"}


def _slim_repo(r):
    out = {k: r[k] for k in REPO_KEYS if k in r}
    if isinstance(out.get("host"), dict):
        out["host"] = {"name": out["host"].get("name")}
    return out


def _slim_pkg(p):
    out = {k: p[k] for k in PKG_KEYS if k in p}
    if isinstance(out.get("repo_metadata"), dict):
        out["repo_metadata"] = _slim_repo(out["repo_metadata"])
    return out


def slim(d):
    """쓰는 필드만 남긴다. ecosyste.ms 응답에는 scorecard·commit 통계 같은 큰 필드가 붙어 있어서
    그대로 캐시하면 수 GB가 된다 (E3에서 12GB → 314MB)"""
    if isinstance(d, list) and d and isinstance(d[0], dict):
        if "ecosystem" in d[0]:
            return [_slim_pkg(p) for p in d]
        if "full_name" in d[0]:
            return [_slim_repo(r) for r in d]
    if isinstance(d, dict) and isinstance(d.get("packages"), list):
        return {**{k: v for k, v in d.items() if k != "packages"}, "packages": [_slim_pkg(p) for p in d["packages"]]}
    return d


def fetch(url, body=None, min_remaining=30, tries=5):
    """JSON을 가져온다. 404는 None으로 캐시한다. 반환: (data, fetched_at)"""
    raw_key = url + "\n" + (json.dumps(body, sort_keys=True) if body is not None else "")
    key = hashlib.sha1(raw_key.encode()).hexdigest()
    path = CACHE / key[:2] / f"{key}.json"
    if path.exists():
        try:
            wrapped = json.loads(path.read_text())
            _bump("cache")
            return wrapped["data"], wrapped["fetched_at"]
        except (json.JSONDecodeError, KeyError):
            path.unlink()  # 쓰다 끊긴 캐시: 지우고 다시 받는다

    data = json.dumps(body).encode() if body is not None else None
    headers = {"User-Agent": UA, "Accept": "application/json"}
    if data:
        headers["Content-Type"] = "application/json"
    payload = None
    for attempt in range(tries):
        req = urllib.request.Request(url, data=data, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                payload = slim(json.loads(r.read().decode()))
                remaining = r.headers.get("x-ratelimit-remaining")
                if remaining is not None and min_remaining and int(remaining) < min_remaining:
                    reset = int(r.headers.get("x-ratelimit-reset") or 0)
                    # ecosyste.ms는 창이 '시작된' 시각을 준다 → 다음 창은 한 시간 뒤
                    if reset and reset < time.time():
                        reset += 3600
                    wait = min(max(10, reset - time.time()), 3600)
                    print(f"  rate limit 가까움 ({remaining} 남음). {wait:.0f}초 대기", file=sys.stderr)
                    time.sleep(wait)
            _bump("net")
            break
        except urllib.error.HTTPError as e:
            if e.code == 404:
                _bump("miss")
                payload = None
                break
            if e.code in (403, 429, 500, 502, 503, 504) and attempt < tries - 1:
                retry_after = e.headers.get("Retry-After")
                wait = float(retry_after) if retry_after and retry_after.isdigit() else 2 ** attempt * 2
                time.sleep(min(wait, 120))
                continue
            _bump("err")
            print(f"  HTTP {e.code}: {url}", file=sys.stderr)
            return None, None
        except (OSError, json.JSONDecodeError) as e:  # URLError, socket.timeout(3.9), 연결 끊김
            if attempt < tries - 1:
                time.sleep(2 ** attempt * 2)
                continue
            _bump("err")
            print(f"  실패 {type(e).__name__}: {url}", file=sys.stderr)
            return None, None

    fetched_at = now_iso()
    path.parent.mkdir(parents=True, exist_ok=True)
    # 원자적으로 쓴다: 도중에 끊겨도 반쯤 쓴 캐시가 남지 않게
    tmp = path.with_suffix(f".{threading.get_ident()}.tmp")
    tmp.write_text(json.dumps({"fetched_at": fetched_at, "data": payload}))
    tmp.replace(path)
    return payload, fetched_at


def pmap(fn, items, workers=8):
    with ThreadPoolExecutor(workers) as ex:
        return list(ex.map(fn, items))


def clean_text(s):
    if not s:
        return None
    s = " ".join(str(s).split())
    return s or None


# ---------------------------------------------------------------- pool

class Pool:
    """repo ID → 항목. 패키지 이름 → repo ID."""

    def __init__(self):
        self.repos = {}
        self.pkg2repo = {}
        self.lock = threading.Lock()

    def add_package(self, p, tag):
        if not p or p.get("ecosystem") not in (None, "npm"):
            return None
        rm = p.get("repo_metadata") or {}
        if (rm.get("host") or {}).get("name") != "GitHub" or not rm.get("uuid") or not rm.get("full_name"):
            return None
        rid = str(rm["uuid"])
        pkg = {
            "name": p["name"],
            "desc": clean_text(p.get("description")),
            "keywords": [k.lower() for k in (p.get("keywords_array") or []) if k],
            "downloads": p.get("downloads"),
            "dependents": p.get("dependent_packages_count"),
            "version": p.get("latest_release_number"),
            "status": p.get("status"),
        }
        with self.lock:
            e = self.repos.get(rid)
            if e is None:
                e = self.repos[rid] = {
                    "repo": {
                        "id": rid,
                        "name": rm["full_name"],
                        "desc": clean_text(rm.get("description")),
                        "topics": [t.lower() for t in (rm.get("topics") or [])],
                        "lang": rm.get("language"),
                        "stars": rm.get("stargazers_count"),
                        "forks": rm.get("forks_count"),
                        "fork": bool(rm.get("fork")),
                        "archived": bool(rm.get("archived")),
                        "created": rm.get("created_at"),
                        "pushed": rm.get("pushed_at"),
                        "license": rm.get("license"),
                        "default_branch": rm.get("default_branch"),
                        "observed": p.get("repo_metadata_updated_at") or rm.get("updated_at"),
                        "src": "ecosyste.ms",
                    },
                    "packages": {},
                    "tags": set(),
                }
            e["packages"].setdefault(pkg["name"], pkg)
            e["tags"].add(tag)
            self.pkg2repo[pkg["name"]] = rid
        return rid

    def add_github_repo(self, r, fetched_at):
        rid = str(r["id"])
        lic = ((r.get("license") or {}).get("spdx_id") or "").lower() or None
        if lic == "noassertion":
            lic = "other"
        with self.lock:
            e = self.repos.get(rid)
            if e is None:
                e = self.repos[rid] = {
                    "repo": {
                        "id": rid,
                        "name": r["full_name"],
                        "desc": clean_text(r.get("description")),
                        "topics": [t.lower() for t in (r.get("topics") or [])],
                        "lang": r.get("language"),
                        "stars": r.get("stargazers_count"),
                        "forks": r.get("forks_count"),
                        "fork": bool(r.get("fork")),
                        "archived": bool(r.get("archived")),
                        "created": r.get("created_at"),
                        "pushed": r.get("pushed_at"),
                        "license": lic,
                        "default_branch": r.get("default_branch"),
                        "observed": fetched_at,
                        "src": "github",
                    },
                    "packages": {},
                    "tags": set(),
                }
            e["tags"].add("include")
        return rid


# 템플릿 그대로인 repo와 tea.xyz 보상을 노린 스팸 (서로 의존해서 '많이 쓰이는 dependency'로 끼어든다, E2)
BOILERPLATE = re.compile(
    r"this is a \[?next\.js\]?.{0,40}bootstrapped|getting started with create react app|"
    r"this template should help get you started|tea\.?xyz|tea protocol",
    re.I,
)


def is_spam(e):
    r = e["repo"]
    texts = [r["desc"] or ""] + [p["desc"] or "" for p in e["packages"].values()]
    tags = set(r["topics"]) | {k for p in e["packages"].values() for k in p["keywords"]}
    return any(BOILERPLATE.search(t) for t in texts) or bool(tags & {"tea", "teaxyz", "tea-xyz", "tea-protocol"})


def eligible(e, allow_fork=False):
    r = e["repo"]
    if r["fork"] and not allow_fork:
        return False
    pkgs = list(e["packages"].values())
    if pkgs and all(p["status"] == "removed" for p in pkgs):
        return False
    if is_spam(e) and "include" not in e["tags"]:
        return False
    has_text = bool(r["desc"]) or any(p["desc"] for p in pkgs)
    has_tags = bool(r["topics"]) or any(p["keywords"] for p in pkgs)
    return has_text or has_tags


def bucket_of(stars):
    if stars is None:
        return None
    for i, (lo, hi) in enumerate(STAR_BUCKETS):
        if lo <= stars <= hi:
            return i
    return None


def first_keyword_tag(e):
    kws = sorted(t for t in e["tags"] if t.startswith("kw:"))
    return kws[0] if kws else "kw:?"


def round_robin(cands, n, salt):
    """키워드별로 번갈아 뽑는다. 한 분야가 표본을 독점하지 않게 한다."""
    groups = {}
    for rid, e in cands:
        groups.setdefault(first_keyword_tag(e), []).append(rid)
    for g in groups.values():
        g.sort(key=lambda rid: hkey(salt, rid))
    order = sorted(groups, key=lambda g: hkey(salt, g))
    out = []
    while len(out) < n and any(groups[g] for g in order):
        for g in order:
            if groups[g] and len(out) < n:
                out.append(groups[g].pop(0))
    return out


# ---------------------------------------------------------------- steps

def collect_landmark_pool(pool):
    urls = [
        f"{ECO}/registries/npmjs.org/packages?sort={sort}&order=desc&per_page=100&page={page}"
        for sort in ("downloads", "dependent_packages_count", "dependent_repos_count")
        for page in range(1, LANDMARK_PAGES + 1)
    ]
    for data, _ in pmap(fetch, urls):
        for p in data or []:
            pool.add_package(p, "landmark-pool")


def collect_keyword_pool(pool):
    urls = [
        (kw, f"{ECO}/keywords/{urllib.parse.quote(kw)}?per_page=100&page={page}")
        for kw in KEYWORDS
        for page in range(1, KEYWORD_PAGES + 1)
    ]
    results = pmap(lambda u: fetch(u[1]), urls)
    for (kw, _), (data, _) in zip(urls, results):
        for p in (data or {}).get("packages") or []:
            pool.add_package(p, f"kw:{kw}")


def select_core(pool):
    chosen = {}

    lm = [(rid, e) for rid, e in pool.repos.items() if "landmark-pool" in e["tags"] and eligible(e)]
    lm.sort(key=lambda x: (-(x[1]["repo"]["stars"] or -1), x[0]))
    for rid, _ in lm[: TARGET["landmark"]]:
        chosen[rid] = "landmark"

    kw_pool = [
        (rid, e) for rid, e in pool.repos.items()
        if rid not in chosen and any(t.startswith("kw:") for t in e["tags"]) and eligible(e)
    ]

    # varied: star 구간 × 키워드를 균등하게
    per_bucket = TARGET["varied"] // len(STAR_BUCKETS)
    by_bucket = {i: [] for i in range(len(STAR_BUCKETS))}
    for rid, e in kw_pool:
        b = bucket_of(e["repo"]["stars"])
        if b is not None:
            by_bucket[b].append((rid, e))
    picked = {}
    deficit = 0
    for b in range(len(STAR_BUCKETS)):
        got = round_robin(by_bucket[b], per_bucket, f"varied{b}")
        picked[b] = got
        deficit += per_bucket - len(got)
    # 모자란 구간의 몫은 남는 구간에서 채운다 (작은 구간부터)
    for b in range(len(STAR_BUCKETS)):
        if deficit <= 0:
            break
        taken = set(picked[b])
        rest = [(rid, e) for rid, e in by_bucket[b] if rid not in taken]
        extra = round_robin(rest, deficit, f"varied-extra{b}")
        picked[b] += extra
        deficit -= len(extra)
    for b, rids in picked.items():
        for rid in rids:
            chosen[rid] = "varied"

    small = [
        (rid, e) for rid, e in kw_pool
        if rid not in chosen and e["repo"]["stars"] is not None and e["repo"]["stars"] <= SMALL_MAX_STARS
    ]
    for rid in round_robin(small, TARGET["small"], "small"):
        chosen[rid] = "small"
    return chosen


def fetch_manifest(pkg):
    """deps.dev에서 선언된 dependencies / peerDependencies를 가져온다. devDependencies는 쓰지 않는다."""
    base = f"{DEPSDEV}/systems/npm/packages/{urllib.parse.quote(pkg['name'], safe='')}"
    version = pkg.get("version")
    data = None
    if version:
        data, _ = fetch(f"{base}/versions/{urllib.parse.quote(version, safe='')}:requirements", min_remaining=0)
    if not isinstance(data, dict):
        info, _ = fetch(base, min_remaining=0)
        default = next((v["versionKey"]["version"] for v in (info or {}).get("versions") or [] if v.get("isDefault")), None)
        if default and default != version:
            data, _ = fetch(f"{base}/versions/{urllib.parse.quote(default, safe='')}:requirements", min_remaining=0)
    deps = ((data or {}).get("npm") or {}).get("dependencies")
    if not isinstance(deps, dict):
        return None
    return {
        "deps": sorted({d["name"] for d in deps.get("dependencies") or []}),
        "peers": sorted({d["name"] for d in deps.get("peerDependencies") or []}),
    }


def fetch_deps(pool, rids, manifests):
    """repo마다 다운로드 상위 패키지 몇 개의 manifest를 가져온다."""
    todo = {}
    for rid in rids:
        pkgs = sorted(pool.repos[rid]["packages"].values(), key=lambda p: (-(p["downloads"] or 0), p["name"]))
        for p in pkgs[:PKGS_PER_REPO]:
            if p["name"] not in manifests:
                todo[p["name"]] = p
    names = sorted(todo)
    for name, m in zip(names, pmap(lambda n: fetch_manifest(todo[n]), names, workers=8)):
        manifests[name] = m


def resolve_names(pool, names):
    """모르는 패키지 이름을 bulk lookup으로 repo에 연결한다."""
    todo = sorted(n for n in set(names) if n not in pool.pkg2repo)
    chunks = [todo[i:i + 100] for i in range(0, len(todo), 100)]
    results = pmap(
        lambda c: fetch(f"{ECO}/packages/bulk_lookup", body={"names": c, "ecosystem": "npm"}),
        chunks,
    )
    for data, _ in results:
        for p in data or []:
            pool.add_package(p, "lookup")
    return len(todo)


def repo_deps(pool, rid, manifests, extra_manifest=None):
    """repo → [(dep 패키지 이름, kind, via 패키지)]"""
    out = []
    ms = []
    if extra_manifest:
        ms.append(("package.json", extra_manifest))
    for name in pool.repos[rid]["packages"]:
        if manifests.get(name):
            ms.append((name, manifests[name]))
    for via, m in ms:
        for d in m["deps"]:
            out.append((d, "runtime", via))
        for d in m["peers"]:
            out.append((d, "peer", via))
    return out


def collect_includes(pool):
    """data/include.txt: user:NAME 또는 owner/repo"""
    if not INCLUDE.exists():
        return {}, {}
    rids, pkgjson = {}, {}
    for line in INCLUDE.read_text().splitlines():
        line = line.split("#")[0].strip()
        if not line:
            continue
        if line.startswith("user:"):
            user = line[5:]
            data, at = fetch(f"{GH}/users/{user}/repos?per_page=100&type=owner&sort=pushed", min_remaining=0)
            repos = [r for r in (data or []) if not r.get("fork")]
            print(f"  include user:{user} → fork 제외 {len(repos)}개")
        else:
            data, at = fetch(f"{GH}/repos/{line}", min_remaining=0)
            repos = [data] if data else []
            if not repos:
                print(f"  include {line} → 찾지 못함", file=sys.stderr)
        for r in repos:
            rid = pool.add_github_repo(r, at)
            rids[rid] = "include"
    for rid in list(rids):
        r = pool.repos[rid]["repo"]
        branch = r.get("default_branch") or "main"
        data, _ = fetch(f"{RAW}/{r['name']}/{branch}/package.json", min_remaining=0)
        if isinstance(data, dict):
            pkgjson[rid] = {
                "deps": sorted((data.get("dependencies") or {}).keys()),
                "peers": sorted((data.get("peerDependencies") or {}).keys()),
            }
    return rids, pkgjson


def main():
    BUILD.mkdir(parents=True, exist_ok=True)
    pool = Pool()
    t0 = time.time()

    print("1/6 landmark 후보")
    collect_landmark_pool(pool)
    print(f"    repo {len(pool.repos)}")

    print("2/6 키워드 후보")
    collect_keyword_pool(pool)
    print(f"    repo {len(pool.repos)}")

    print("3/6 표본 선택")
    chosen = select_core(pool)
    include_rids, include_pkgjson = collect_includes(pool)
    for rid in include_rids:
        chosen[rid] = "include" if rid not in chosen else chosen[rid]

    print("4/6 dependency manifest")
    manifests = {}
    fetch_deps(pool, list(chosen), manifests)
    dep_names = [d for rid in chosen for d, _, _ in repo_deps(pool, rid, manifests, include_pkgjson.get(rid))]
    n = resolve_names(pool, dep_names)
    print(f"    manifest {len(manifests)}, 새로 조회한 패키지 이름 {n}")

    print("5/6 이웃 (많이 쓰이는 dependency의 repo)")
    indeg = {}
    for rid in chosen:
        seen = set()
        for d, _, _ in repo_deps(pool, rid, manifests, include_pkgjson.get(rid)):
            t = pool.pkg2repo.get(d)
            if t and t != rid and t not in chosen and t not in seen:
                seen.add(t)
                indeg[t] = indeg.get(t, 0) + 1
    cands = [t for t in indeg if eligible(pool.repos[t])]
    cands.sort(key=lambda t: (-indeg[t], hkey("neighbor", t)))
    for t in cands[: TARGET["neighbor"]]:
        chosen[t] = "neighbor"
    neighbors = [t for t, s in chosen.items() if s == "neighbor"]
    fetch_deps(pool, neighbors, manifests)
    resolve_names(pool, [d for rid in neighbors for d, _, _ in repo_deps(pool, rid, manifests)])

    print("6/6 항로와 출력")
    edges = {}
    records = []
    for rid, stratum in sorted(chosen.items(), key=lambda x: x[0]):
        e = pool.repos[rid]
        deps = repo_deps(pool, rid, manifests, include_pkgjson.get(rid))
        dep_tokens = set()
        for d, kind, via in deps:
            t = pool.pkg2repo.get(d)
            dep_tokens.add(f"r:{t}" if t else f"p:{d}")
            if t and t != rid and t in chosen:
                key = (rid, t)
                if key not in edges or (edges[key]["k"] == "peer" and kind == "runtime"):
                    edges[key] = {"s": rid, "t": t, "k": kind, "via": f"{via} → {d}"}
        pkgs = sorted(e["packages"].values(), key=lambda p: (-(p["downloads"] or 0), p["name"]))
        kw = []
        kw_count = {}
        for p in pkgs:
            for k in set(p["keywords"]):
                kw_count[k] = kw_count.get(k, 0) + 1
            for k in p["keywords"]:
                if k not in kw:
                    kw.append(k)
        rec = dict(e["repo"])
        rec.pop("default_branch", None)
        rec.update({
            "stratum": stratum,
            "tags": sorted(t[3:] for t in e["tags"] if t.startswith("kw:")),
            "keywords": kw[:24],
            # 모노레포에서 패키지 하나의 키워드가 repo 전체를 대표하지 않도록, 키워드를 가진 패키지 수를 남긴다
            "keyword_share": {k: round(kw_count[k] / max(1, len(pkgs)), 3) for k in kw[:24]},
            "packages": [{"name": p["name"], "desc": p["desc"], "downloads": p["downloads"]} for p in pkgs[:5]],
            "package_count": len(pkgs),
            "dep_tokens": sorted(dep_tokens),
            "has_manifest": any(manifests.get(p["name"]) for p in pkgs[:PKGS_PER_REPO]) or rid in include_pkgjson,
        })
        records.append(rec)

    by_stratum = {}
    for r in records:
        by_stratum[r["stratum"]] = by_stratum.get(r["stratum"], 0) + 1
    by_kind = {}
    for e in edges.values():
        by_kind[e["k"]] = by_kind.get(e["k"], 0) + 1
    out = {
        "generated_at": now_iso(),
        "sources": [
            {"name": "ecosyste.ms packages API", "url": "https://packages.ecosyste.ms", "license": "CC BY-SA 4.0"},
            {"name": "deps.dev", "url": "https://deps.dev", "use": "npm dependencies / peerDependencies"},
            {"name": "GitHub REST API", "url": "https://api.github.com", "use": "include 목록"},
        ],
        "stats": {
            "pool_repos": len(pool.repos),
            "spam_in_pool": sum(1 for e in pool.repos.values() if is_spam(e)),
            "chosen": len(records),
            "by_stratum": by_stratum,
            "edges": len(edges),
            "edges_by_kind": by_kind,
            "with_manifest": sum(1 for r in records if r["has_manifest"]),
            "http": dict(_stats),
            "seconds": round(time.time() - t0, 1),
        },
        "repos": records,
        "edges": sorted(edges.values(), key=lambda e: (e["s"], e["t"])),
    }
    (BUILD / "collected.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print(json.dumps(out["stats"], ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
