"""계층 배치: 은하 → 지역 → 행성계 → 행성 (DIRECTION D12)

  지역(region)  관계망의 큰 생태계 (Leiden). 지역 사이는 빈 공간으로 뚜렷이 나눈다.
  행성계(system) 지역 안에서 더 가깝게 묶이는 5–36개. 중심별 둘레의 궤도에 놓는다.
                중심별은 repo가 아니다 — 그 세계들이 공유하는 주제다 ("repo 하나 = 행성 하나").
  궤도          행성계의 공통 주제에 가까운 repo일수록 안쪽 궤도.

지역·행성계의 상대 위치는 UMAP 배치에서 가져온다. 관계가 가까운 지역은 여전히 가깝다.
"""
import math
import re
from collections import Counter, defaultdict

import igraph as ig
import leidenalg as la
import numpy as np

REGION_RESOLUTION = 0.5
SYSTEM_RESOLUTION = 2.0
SYSTEM_MAX = 36
SYSTEM_MIN = 4
REGION_MIN = 40

RING0 = 6.0       # 첫 궤도 반지름
RING_GAP = 4.5    # 궤도 사이
SPACING = 7.0     # 같은 궤도 위 행성 사이
SYSTEM_GAP = 16.0  # 행성계 사이 빈 공간
MAX_TILT = math.radians(24)

# 나선 은하 (DIRECTION D14): 핵 = 모두가 딛고 선 기반 지역, 바깥으로 갈수록 응용
N_ARMS = 3
PITCH = math.radians(19)      # 나선팔의 기울기
ARM_GAP = 110.0               # 같은 팔 위 지역 사이 빈 공간
ARM_WIDTH = 210.0             # 팔의 기본 폭 (지역이 크면 넓어진다)
ARM_THICK = 18.0              # 팔 두께 (세로)
CORE_MAX = 1100               # 핵에 들어갈 행성 수 상한
CORE_MARGIN = 150.0           # 핵 가장자리와 팔이 시작하는 곳 사이
SEED = 42


def hfloat(*parts):
    import hashlib

    h = hashlib.sha1(":".join(str(p) for p in parts).encode()).digest()
    return int.from_bytes(h[:8], "big") / 2 ** 64


# ---------------------------------------------------------------- 묶음 찾기

def build_graph(prep, edges, members, k=12):
    """특징 공간의 이웃(코사인) + 확인된 항로. members 밖의 repo는 넣지 않는다."""
    from sklearn.neighbors import NearestNeighbors

    members = np.asarray(members)
    local = {int(g): l for l, g in enumerate(members)}
    Zm = prep.Z[members]
    nb = NearestNeighbors(n_neighbors=min(k + 1, len(members)), metric="cosine", algorithm="brute").fit(Zm).kneighbors(Zm)[1]
    w = {}
    for a in range(len(members)):
        for b in nb[a][1:]:
            s = float(Zm[a] @ Zm[b])
            if s > 0:
                key = (min(a, b), max(a, b))
                w[key] = max(w.get(key, 0.0), s)
    for e in edges:
        a, b = local.get(prep.idx[e["s"]]), local.get(prep.idx[e["t"]])
        if a is None or b is None or a == b:
            continue
        key = (min(a, b), max(a, b))
        w[key] = w.get(key, 0.0) + (0.5 if e["k"] == "runtime" else 0.3)
    g = ig.Graph(n=len(members), edges=list(w))
    g.es["weight"] = list(w.values())
    return g


def leiden(g, resolution):
    p = la.find_partition(g, la.RBConfigurationVertexPartition, weights="weight",
                          resolution_parameter=resolution, seed=SEED)
    return [list(c) for c in p]


def merge_small(g, groups, min_size):
    """작은 묶음은 가장 강하게 이어진 이웃 묶음에 합친다. 이웃이 없으면 그대로 둔다."""
    groups = [list(c) for c in groups if c]
    while True:
        label = {}
        for gi, c in enumerate(groups):
            for v in c:
                label[v] = gi
        small = [gi for gi, c in enumerate(groups) if len(c) < min_size]
        if not small:
            return groups
        moved = False
        for gi in sorted(small, key=lambda x: len(groups[x])):
            if not groups[gi] or len(groups[gi]) >= min_size:
                continue
            link = Counter()
            for v in groups[gi]:
                for e in g.incident(v):
                    u = g.es[e].target if g.es[e].source == v else g.es[e].source
                    if label.get(u, gi) != gi:
                        link[label[u]] += g.es[e]["weight"]
            if not link:
                continue
            target = link.most_common(1)[0][0]
            groups[target] += groups[gi]
            for v in groups[gi]:
                label[v] = target
            groups[gi] = []
            moved = True
        groups = [c for c in groups if c]
        if not moved:
            return groups


def split_systems(g, vertices):
    """지역 하나를 행성계로 나눈다. 큰 묶음은 해상도를 올려 다시 나눈다."""
    sub = g.induced_subgraph(vertices)
    out = []
    stack = [(list(range(len(vertices))), SYSTEM_RESOLUTION)]
    while stack:
        vs, r = stack.pop()
        if len(vs) <= SYSTEM_MAX or r > 256:
            out.append(vs)
            continue
        parts = leiden(sub.induced_subgraph(vs), r)
        if len(parts) == 1:
            stack.append((vs, r * 2))
            continue
        for p in parts:
            stack.append(([vs[i] for i in p], r * 1.5))
    out = merge_small(sub, out, SYSTEM_MIN)
    # 합친 뒤 너무 커진 것은 반으로 (드문 경우)
    final = []
    for c in out:
        while len(c) > SYSTEM_MAX * 1.5:
            final.append(c[:SYSTEM_MAX])
            c = c[SYSTEM_MAX:]
        final.append(c)
    return [[vertices[i] for i in c] for c in final]


def detect(prep, edges, members):
    g = build_graph(prep, edges, members)
    regions = merge_small(g, leiden(g, REGION_RESOLUTION), REGION_MIN)
    systems = []  # (region index, [local vertices])
    for ri, rv in enumerate(regions):
        for sv in split_systems(g, rv):
            systems.append((ri, sv))
    members = np.asarray(members)
    region_of = {}
    system_of = {}
    for si, (ri, sv) in enumerate(systems):
        for v in sv:
            region_of[int(members[v])] = ri
            system_of[int(members[v])] = si
    return len(regions), [(ri, [int(members[v]) for v in sv]) for ri, sv in systems], region_of, system_of


# ---------------------------------------------------------------- 이름

def token_label(prep, token):
    """토큰을 사람이 읽는 이름으로. d:r:<id>는 그 repo의 이름 부분."""
    kind, _, rest = token.partition(":")
    if kind == "t":
        return rest
    if kind == "d":
        sub, _, val = rest.partition(":")
        if sub == "r":
            i = prep.idx.get(val)
            return prep.repos[i]["name"].split("/")[1].lower() if i is not None else None
        return re.sub(r"^@[^/]+/", "", val.split(":")[-1])  # p:npm:@scope/name → name
    if kind == "w":
        return rest
    return None


def name_group(prep, rows, n_labels=1):
    """묶음의 이름: 전체보다 이 묶음에서 두드러지는 topic·dependency (KL 기여도)"""
    N = len(prep.ids)
    sub = prep.X[rows]
    cnt = np.asarray((sub > 0).sum(axis=0)).ravel()
    fg = cnt / max(1, len(rows))
    f = prep.df / N
    # 행성계는 구성원 4분의 1 이상, 지역은 6% 이상이 가진 토큰만 이름 후보
    share = 0.25 if len(rows) <= 60 else 0.06
    score = np.where(cnt >= max(2, share * len(rows)), fg * np.log(np.maximum(fg, 1e-9) / np.maximum(f, 1e-9)), -1)
    order = np.argsort(-score)
    labels = []
    for c in order[:60]:
        if score[c] <= 0:
            break
        name = prep.names[c]
        if not (name.startswith("t:") or name.startswith("d:")):
            continue
        lab = token_label(prep, name)
        if not lab or len(lab) < 2 or any(lab in l or l in lab for l in labels):
            continue
        labels.append(lab)
        if len(labels) >= n_labels:
            break
    if not labels:
        # topic·dependency가 없으면 설명 단어
        for c in order[:60]:
            if score[c] > 0 and prep.names[c].startswith("w:"):
                labels.append(prep.names[c][2:])
                break
    return " · ".join(labels) or "—"


# ---------------------------------------------------------------- 기하

def ring_layout(n):
    """n개를 안쪽 궤도부터 채운다 → [(궤도 번호, 궤도 안 순번, 궤도 위 개수)]"""
    out, k, left = [], 0, n
    while left > 0:
        r = RING0 + k * RING_GAP
        cap = max(3, int(2 * math.pi * r / SPACING))
        m = min(cap, left)
        out += [(k, j, m) for j in range(m)]
        left -= m
        k += 1
    return out


def ring_radius(k):
    return RING0 + k * RING_GAP


def orbit_basis(key):
    """행성계 궤도면: 은하 원반(y축)에서 최대 24° 기울인다"""
    tilt = hfloat("tilt", key) * MAX_TILT
    az = hfloat("tilt-az", key) * 2 * math.pi
    n = np.array([math.sin(tilt) * math.cos(az), math.cos(tilt), math.sin(tilt) * math.sin(az)])
    u = np.cross(n, [0.0, 0.0, 1.0])
    if np.linalg.norm(u) < 1e-6:
        u = np.cross(n, [1.0, 0.0, 0.0])
    u /= np.linalg.norm(u)
    v = np.cross(n, u)
    return n, u, v


def orbit_point(center, basis, k, angle):
    _, u, v = basis
    r = ring_radius(k)
    return np.asarray(center) + r * (math.cos(angle) * u + math.sin(angle) * v)


def pack(anchors, radii, gap, iters=400, flatten=1.0):
    """구(반지름+gap/2)가 겹치지 않을 때까지 밀어낸다. flatten<1이면 세로 이동을 줄인다."""
    P = np.array(anchors, float)
    R = np.asarray(radii, float) + gap / 2
    n = len(P)
    if n < 2:
        return P
    for _ in range(iters):
        d = P[None, :, :] - P[:, None, :]
        dist = np.linalg.norm(d, axis=2) + np.eye(n)
        need = R[:, None] + R[None, :]
        over = np.clip(need - dist, 0, None)
        np.fill_diagonal(over, 0)
        if over.max() < 1e-3:
            break
        push = (d / dist[:, :, None]) * (over / 2)[:, :, None]
        move = -push.sum(axis=1)
        move[:, 1] *= flatten
        P += move * 0.9
    return P


def region_links(prep, edges, region_of, n):
    """지역 사이 항로 수(대칭)와, 다른 지역에서 들어오는 항로 수(= 남이 딛고 선 정도)"""
    L = np.zeros((n, n))
    inbound = np.zeros(n)
    for e in edges:
        a = region_of.get(prep.idx[e["s"]])
        b = region_of.get(prep.idx[e["t"]])
        if a is None or b is None or a == b:
            continue
        L[a, b] += 1
        L[b, a] += 1
        inbound[b] += 1
    return L, inbound


def assign_arms(sizes, foundation, L):
    """핵: 가장 기반인 지역들 (행성 CORE_MAX개까지). 팔: 기반 순서대로 안쪽부터 채우되,
    이미 그 팔에 있는 지역들과 가장 많이 이어진 팔로 간다 (팔 크기가 한쪽으로 쏠리지 않게 벌점)."""
    order = [int(r) for r in np.argsort(-foundation)]
    core, total = [], 0
    for r in order:
        if not core or (total + sizes[r] <= CORE_MAX and foundation[r] >= 0.85 * foundation[order[0]]):
            core.append(r)
            total += sizes[r]
        else:
            break
    rest = [r for r in order if r not in core]
    arms = [[] for _ in range(N_ARMS)]
    mass = np.zeros(N_ARMS)
    avg = sum(sizes[r] for r in rest) / N_ARMS
    for r in rest:
        empty = [a for a in range(N_ARMS) if not arms[a]]
        if empty:
            a = empty[0]
        else:
            # 합이 아니라 평균: 이미 큰 팔이 계속 끌어가지 않게
            aff = np.array([np.mean([L[r, x] / math.sqrt(sizes[r] * sizes[x]) for x in arms[a]]) for a in range(N_ARMS)])
            a = int(np.argmax((aff + 1e-6) / (1 + (mass / avg) ** 2)))
        arms[a].append(r)
        mass[a] += sizes[r]
    return core, arms


def spiral_frame(theta0, s, r0, b):
    """로그 나선 r = r0·e^(bφ) 위에서 호의 길이 s인 점, 접선, 바깥쪽 법선"""
    k = math.sqrt(1 + b * b) / b
    phi = math.log(1 + max(s, 0.0) / (r0 * k)) / b
    r = r0 * math.exp(b * phi)
    th = theta0 + phi
    p = np.array([r * math.cos(th), 0.0, r * math.sin(th)])
    t = np.array([b * math.cos(th) - math.sin(th), 0.0, b * math.sin(th) + math.cos(th)])
    t /= np.linalg.norm(t)
    n = np.array([t[2], 0.0, -t[0]])
    if n @ p < 0:
        n = -n
    return p, t, n


def strip_pack(rel3, radii, length, width, gap, iters=700):
    """행성계를 길이×폭 띠 안에 겹치지 않게 편다. 처음 자리는 UMAP 상대 위치의 주축 두 개.
    자리가 모자라면 띠를 늘린다. 반환: (띠 위 좌표, 실제 길이)"""
    n = len(rel3)
    R = np.asarray(radii, float) + gap / 2
    if n == 1:
        return np.zeros((1, 2)), length
    X = rel3 - rel3.mean(axis=0)
    _, _, vt = np.linalg.svd(X, full_matrices=False)
    P = X @ vt[:2].T
    P /= np.abs(P).max(axis=0) + 1e-9
    P *= [length / 2 * 0.8, width / 2 * 0.8]
    for attempt in range(8):
        for _ in range(iters):
            d = P[None, :, :] - P[:, None, :]
            dist = np.linalg.norm(d, axis=2) + np.eye(n)
            over = np.clip(R[:, None] + R[None, :] - dist, 0, None)
            np.fill_diagonal(over, 0)
            P -= ((d / dist[:, :, None]) * (over / 2)[:, :, None]).sum(axis=1) * 0.9
            lim = np.stack([np.maximum(length / 2 - R, 0), np.maximum(width / 2 - R, 0)], axis=1)
            P = np.clip(P, -lim, lim)
        d = np.linalg.norm(P[None] - P[:, None], axis=2) + np.eye(n) * 1e9
        if (d - (R[:, None] + R[None, :]) > -0.5).all():
            return P, length
        length *= 1.12  # 모자라면 띠를 늘린다
        P[:, 0] *= 1.12
    return P, length


def layout(prep, edges, P_umap, members):
    """members(관계 미확정 제외)의 계층 좌표를 만든다.
    반환: pos {전역 index: xyz}, systems [dict], regions [dict], system_of, ring_of, galaxy(나선 정보)"""
    n_regions, systems, region_of, system_of = detect(prep, edges, members)
    P_umap = np.asarray(P_umap)
    upos = {int(g): P_umap[k] for k, g in enumerate(members)}

    # 행성계 안: 공통 주제에 가까운 순서로 안쪽 궤도부터
    sys_info = []
    for si, (ri, rows) in enumerate(systems):
        zc = prep.Z[rows].mean(axis=0)
        zc /= np.linalg.norm(zc) + 1e-9
        order = sorted(rows, key=lambda i: (-float(prep.Z[i] @ zc), prep.ids[i]))
        slots = ring_layout(len(order))
        radius = ring_radius(slots[-1][0]) + 3.0
        anchor = np.mean([upos[i] for i in rows], axis=0)
        sys_info.append({"region": ri, "order": order, "slots": slots, "radius": radius, "anchor": anchor})

    region_sizes = np.zeros(n_regions)
    for s_ in sys_info:
        region_sizes[s_["region"]] += len(s_["order"])
    links, inbound = region_links(prep, edges, region_of, n_regions)
    foundation = inbound / np.maximum(region_sizes, 1)
    core, arms = assign_arms(region_sizes, foundation, links)

    # 핵: 기반 지역들의 행성계를 가운데에 공처럼 모은다 (살짝 납작한 팽대부)
    core_sis = [si for si, s_ in enumerate(sys_info) if s_["region"] in core]
    core_centroid = np.mean([sys_info[si]["anchor"] for si in core_sis], axis=0)
    rel = np.array([sys_info[si]["anchor"] - core_centroid for si in core_sis]) * 0.3
    rel[:, 1] *= 0.6
    rel = pack(rel, [sys_info[si]["radius"] for si in core_sis], SYSTEM_GAP, flatten=0.7)
    rel -= rel.mean(axis=0)
    for si, p_ in zip(core_sis, rel):
        sys_info[si]["center"] = p_
    core_extent = max(np.linalg.norm(p_) + sys_info[si]["radius"] for si, p_ in zip(core_sis, rel))
    r_core = core_extent + CORE_MARGIN

    # 팔: 지역을 안쪽(기반)부터 바깥(응용)으로 놓는다. 지역 안의 행성계는 팔을 따라 휜 띠에 편다
    b = math.tan(PITCH)
    arm_meta = []
    for a, arm in enumerate(arms):
        theta0 = a * 2 * math.pi / N_ARMS + hfloat("arm-phase") * 2 * math.pi
        s_cursor = 0.0
        for ri in arm:
            sis = [si for si, s_ in enumerate(sys_info) if s_["region"] == ri]
            radii = np.array([sys_info[si]["radius"] for si in sis])
            area = float(np.sum(np.pi * (radii + SYSTEM_GAP / 2) ** 2))
            width = max(ARM_WIDTH, math.sqrt(area / 4.0))
            length = max(area * 1.35 / width, 2 * radii.max() + SYSTEM_GAP)
            anchors = np.array([sys_info[si]["anchor"] for si in sis])
            local, length = strip_pack(anchors - anchors.mean(axis=0), radii, length, width, SYSTEM_GAP)
            for si, (u, v) in zip(sis, local):
                sp, tangent, normal = spiral_frame(theta0, s_cursor + length / 2 + u, r_core, b)
                y = (hfloat("arm-y", sys_info[si]["order"][0]) - 0.5) * 2 * ARM_THICK
                sys_info[si]["center"] = sp + normal * v + np.array([0.0, y, 0.0])
            s_cursor += length + ARM_GAP
        arm_meta.append({"theta0": theta0, "length": s_cursor - ARM_GAP})

    regions = []
    for ri in range(n_regions):
        sis = [si for si, s_ in enumerate(sys_info) if s_["region"] == ri]
        centers = np.array([sys_info[si]["center"] for si in sis])
        center = centers.mean(axis=0)
        extent = max(np.linalg.norm(c - center) + sys_info[si]["radius"] for si, c in zip(sis, centers))
        arm = -1 if ri in core else next(a for a, arm in enumerate(arms) if ri in arm)
        regions.append({"systems": sis, "center": center, "radius": extent, "arm": arm,
                        "arm_pos": core.index(ri) if arm < 0 else arms[arm].index(ri),
                        "foundation": float(foundation[ri])})
    galaxy = {"arms": arm_meta, "pitch": PITCH, "r_core": r_core, "core_extent": core_extent,
              "width": ARM_WIDTH, "thickness": ARM_THICK}

    pos, ring_of, systems_out = {}, {}, []
    for si, s in enumerate(sys_info):
        key = f"s{si:04d}"
        center = s["center"]
        basis = orbit_basis(key)
        phase = {k: hfloat("phase", key, k) * 2 * math.pi for k in {k for k, _, _ in s["slots"]}}
        for i, (k, j, m) in zip(s["order"], s["slots"]):
            ang = phase[k] + 2 * math.pi * j / m
            pos[i] = orbit_point(center, basis, k, ang)
            ring_of[i] = k
        systems_out.append({
            "key": key,
            "region": s["region"],
            "center": center,
            "normal": basis[0],
            "rings": sorted({k for k, _, _ in s["slots"]}),
            "members": s["order"],
        })
    regions_out = [{"key": f"r{ri:02d}", "center": r["center"], "radius": r["radius"], "arm": r["arm"],
                    "arm_pos": r["arm_pos"], "foundation": r["foundation"],
                    "systems": [systems_out[si]["key"] for si in r["systems"]]} for ri, r in enumerate(regions)]
    return pos, systems_out, regions_out, {i: f"s{system_of[i]:04d}" for i in system_of}, ring_of, galaxy


def next_slot(system, taken_angles, key):
    """행성계에 새 행성을 들일 자리: 바깥 궤도의 빈 곳, 없으면 새 궤도"""
    rings = system["rings"]
    for k in rings[-1:]:
        r = ring_radius(k)
        cap = max(3, int(2 * math.pi * r / SPACING))
        angs = taken_angles.get(k, [])
        if len(angs) < cap:
            # 가장 넓은 틈의 가운데
            a = sorted(angs)
            if not a:
                return k, hfloat("phase", key, k) * 2 * math.pi
            gaps = [((a[(t + 1) % len(a)] - a[t]) % (2 * math.pi) or 2 * math.pi, a[t]) for t in range(len(a))]
            width, start = max(gaps)
            if width * r >= SPACING:
                return k, start + width / 2
    k = rings[-1] + 1
    return k, hfloat("phase", key, k) * 2 * math.pi
