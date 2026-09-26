# Open-source Galaxy

내가 만든 것이 거대한 오픈소스 생태계 안에서 어떤 장소를 차지하는지 발견하는 우주.
**별 하나가 계정 하나**이고, 그 둘레를 도는 **행성이 그 계정의 repo**입니다 (안쪽 궤도일수록 먼저 만든 것).
비슷한 일을 하는 계정들이 모여 지역과 은하가 되고, 확인된 dependency가 행성 사이의 항로가 됩니다.

지금은 **Prototype** 단계입니다. npm·PyPI·Rust 생태계에서 고른 계정 표본으로 우주를 만들고,
아직 없는 계정을 검색하면 서버가 GitHub에서 가져와 그 자리에서 들입니다 (Git City처럼).

## 문서

| 문서 | 내용 |
|---|---|
| [docs/PLAN.md](docs/PLAN.md) | 원본 기획안 (원문 보존) |
| [docs/DIRECTION.md](docs/DIRECTION.md) | 검토 후 내린 결정. PLAN.md와 충돌하면 이쪽이 우선 |
| [docs/PROTOTYPE_SPEC.md](docs/PROTOTYPE_SPEC.md) | Prototype 범위, 실험 순서, 통과 기준 |
| [docs/experiments/](docs/experiments/) | 실험 기록 |

## 실행

```sh
# 1. 데이터 (Python 3.9+)
python3 -m venv .venv
.venv/bin/pip install numpy scipy scikit-learn umap-learn leidenalg igraph fastapi "uvicorn[standard]"
.venv/bin/python pipeline/collect.py      # npm 표본 → data/build/collected.json (계정 고르기의 출발점)
.venv/bin/python pipeline/accounts.py     # 계정과 그 repo·dependency → data/build/accounts.json
.venv/bin/python pipeline/universe.py     # 배치 → data/universe.db (장부), data/model/ (새 계정용 고정 모델)
                                          # API 응답은 모두 data/raw/cache에 캐시된다

# 2. 서버 (8787)
.venv/bin/uvicorn server.app:app --port 8787
# GITHUB_TOKEN=... 을 주면 새 계정 들이기가 시간당 30개 → 2,500개로 넉넉해진다

# 3. 클라이언트 (5173, /api는 서버로 넘어간다)
cd web && npm install && npm run dev
```

- `?u=username` 그 계정의 행성계 (없으면 들인다), `?r=owner/repo` 행성, `?p=repo-id` 영구 주소
- `?view=gallery&seed=3` 행성 12개 비교 (`&blind`로 이름 숨김, `&look=1`로 외형 v1)
- `?view=oatmeal` 사람 대상 오트밀 테스트 (E2). 진행 방법은 [docs/experiments/E2-planets.md](docs/experiments/E2-planets.md)
- `npm run check` 흐름 스모크 테스트 · `npm run shot -- shots/` 장면 캡처와 프레임 시간 · `node scripts/structure.mjs` 배율별 캡처

`data/include.txt`에 테스트 참가자를 적습니다 (`user:NAME`).

## 장부

`data/universe.db`(SQLite)가 좌표 장부입니다. 계정 → 행성계 중심·궤도면, repo → 궤도·각도·좌표.
한 번 놓인 행성계와 행성은 움직이지 않습니다. 새 계정은 서버가 고정 모델로 가장 비슷한 계정들 근처 빈자리에 놓고,
새 repo는 바깥 궤도로 들어갑니다. `universe.py`는 장부가 이미 있으면 멈추고, `--reset`을 명시해야 새로 만듭니다.

## 데이터 출처

- [ecosyste.ms](https://ecosyste.ms) — 패키지와 repo 정보. 데이터 CC BY-SA 4.0, 이 우주의 파생 데이터도 같은 라이선스를 따릅니다.
- [deps.dev](https://deps.dev) — npm · PyPI · Cargo dependencies
- GitHub REST API — include 목록과 새로 들이는 계정
