# Prototype Spec — v0.1

> 상위 문서: [DIRECTION.md](DIRECTION.md)(결정) → [PLAN.md](PLAN.md)(원본 기획).
> 이 문서는 Prototype 단계에서 **무엇을 만들고, 무엇으로 통과를 판단하는지**만 정합니다.

## 1. 목적

> 작은 프로젝트의 주인이 은하 속에서 자기 행성을 알아보고, 안내 없이 두 번째 행성으로 떠나는가.

이것 하나를 검증합니다. 나머지는 이 질문에 답하기 위한 수단입니다.

## 2. 통과 기준 (Prototype → MVP)

관찰 테스트 참가자 **5명**, 그중 **3명 이상은 0–10 star repo 소유자**.

| # | 기준 | 목표 | 측정 |
|---|---|---|---|
| P1 | 자기 행성 인식 | 5명 중 4명이 도착 직후 "내 것"이라고 말하거나 그렇게 설명 | 관찰 + 사후 질문 |
| P2 | 두 번째 이동 | 5명 중 3명이 **검색 없이** 다른 행성으로 이동 | 이동 로그 |
| P3 | 관계 이해 | 이동한 사람의 과반이 두 행성이 왜 연결됐는지 맞게 설명 | 사후 질문 |
| P4 | 초라함 없음 | 0-star 소유자 누구도 자기 행성이 "초라하다/덜 만들어졌다"고 말하지 않음 | 사후 질문 |
| P5 | 지형 기억 (선택) | 다음날 자기 행성 지형을 한 문장으로 묘사 | 후속 메시지 |

P1–P4를 모두 통과하면 MVP로 넘어갑니다. 하나라도 실패하면 해당 실험(E2–E4)으로 돌아갑니다.

## 3. 범위

**포함**
- npm 생태계 repo **약 3,000개**로 시작(E1), 문제없으면 **최대 10,000개** — E1에서 약 8,000개로 늘림
- 테스트 참가자 repo (include 목록, 생태계 무관)
- 좌표 장부 `data/ledger.json` → 배치 v4부터 `data/universe.db`
- 입력: `username`, `owner/repo`, GitHub URL, npm 패키지 이름
- `username` → 개인 별자리 → 행성 선택
- 항해: Survey → Resolve → Departure → Transit → Approach → Orbit
- Orbit: 행성 1개 고해상도, 랜드마크 원형, 명판, 이웃 행성, 항로
- 항로를 따라 다음 행성으로 출발
- URL로 같은 장소 열기: `?p={repo-id}`, `?r=owner/repo`, `?u=username`

**제외** (DIRECTION D2, D5)
- 착륙·표면 탐험, 큐, 로그인
- ~~서버·DB, lazy ingestion~~ → 사용자 결정으로 범위에 들어옴 (DIRECTION D18): 검색한 계정을 서버가 그 자리에서 들인다
- 공유 카드 이미지·영상 (URL만)
- tile·floating origin·sector 분할, Leiden·관계 가중치
- 실시간 갱신, 활동 애니메이션 (E4에서 최소한만 검토)
- 모바일 최적화 (동작만 확인)

## 4. 실험 순서

| 실험 | 질문 | 산출물 | 통과 기준 |
|---|---|---|---|
| **E1 은하 지도** | 관계 기반 배치가 납득되는가? 검색→도착이 끊기지 않는가? | 수집·배치 파이프라인, 은하 렌더링, 선택→항해→궤도, 기초 행성 셰이더 | 이웃 일관성이 무작위의 **3배 이상**, landmark 이웃 육안 검토 통과, 데스크톱 60fps |
| **E2 행성 원형** | seed만으로 기억에 남는 행성이 나오는가? | 랜드마크 원형 8–12개, 갤러리 뷰, 오트밀 테스트 페이지(`?view=oatmeal`) | **오트밀 테스트** 정답률 75% 이상 (6개를 5초씩 보고, 65° 돌린 4개 중 고르기) |
| **E3 항해 카메라** | 항해가 기대감을 주고, 반복해도 지치지 않는가? | 카메라 상태 기계 완성, 건너뛰기, reduced motion | 첫 항해 7–10초, 같은 지역 2–4초, 멀미 호소 없음 |
| **E4 하늘의 다음 목적지** | 궤도에서 다음 목적지가 눈에 들어오는가? | 항로·이웃 신호, 화면 밖 목적지 방향 표시 | 내부 테스트에서 패널 없이 다음 행성 선택 가능 |
| **E5 관찰 테스트** | §2 통과 기준 | 테스트 노트 | P1–P4 |

실험마다 `docs/experiments/E{n}-*.md`에 가설·방법·결과를 남깁니다.

## 5. 데이터

### 소스 (DIRECTION D4)
| 소스 | 쓰는 곳 | 비고 |
|---|---|---|
| ecosyste.ms packages API | 패키지 목록, 패키지→GitHub repo, repo 정보 | CC BY-SA 4.0, 익명 시간당 5,000회 |
| deps.dev requirements API | 패키지 최신 버전의 `dependencies`, `peerDependencies` | npm registry는 동시 요청에 429 |
| GitHub REST (비인증) | include 목록의 username/repo 조회 | 시간당 60회. 몇 번만 호출 |
| raw.githubusercontent.com | include repo의 `package.json` | API 한도와 별개 |

모든 응답은 `data/raw/cache/`에 캐시합니다. 다시 돌려도 API를 다시 부르지 않습니다.

### 표본 구성 (K9)
repo 단위(중복 제거 후) 목표 3,000개.

| 층 | 비율 | 뽑는 방법 |
|---|---|---|
| landmark | 20% | 다운로드·의존 패키지 수 상위 목록 → repo 중복 제거 → stars 상위 |
| varied | 40% | 분야 키워드 약 60개의 패키지 → star 구간(0–9 / 10–99 / 100–999 / 1k–9.9k / 10k+)과 키워드를 번갈아 균등 추출 |
| small | 25% | 같은 키워드 풀에서 stars < 20 |
| neighbor | 15% | 위 repo들이 의존하는 패키지의 repo 중 표본 안에서 많이 쓰이는 것 |
| include | 별도 | 테스트 참가자 (`data/include.txt`) |

**필터**: GitHub repo, fork 아님(include 제외), repo ID 있음, 설명·topics·키워드 중 하나 이상 있음, 패키지 상태가 removed 아님, 템플릿 그대로의 설명·tea.xyz 스팸 아님 (E1b).

### 관계
- repo A → repo B: A의 패키지가 B의 패키지를 `dependencies`(runtime) 또는 `peerDependencies`(peer)로 가짐.
- 모노레포는 repo 하나 = 행성 하나. 패키지 목록은 행성에 붙인다.
- 해석 못 한 패키지는 항로로 만들지 않는다. 유사도 계산용 토큰으로만 쓴다.
- devDependencies는 쓰지 않는다.

### 행성 레코드 (`web/public/data/galaxy.json`)
```
id        GitHub repo ID (문자열)          영구 정체성, seed의 입력
name      owner/repo (현재 이름)
desc      설명 (최대 160자)                 없으면 null
topics    repo topics + npm keywords (최대 8)
lang      주 언어                            없으면 null
stars     stargazers                         미수집이면 null (0과 구분)
created   생성일, pushed: 마지막 push
archived, license
packages  이 repo가 제공하는 npm 패키지 (최대 5)
stratum   landmark | varied | small | neighbor | include
placement mapped | uncharted
pos       [x, y, z]                          ledger에서 옴
observed  ecosyste.ms가 repo 정보를 갱신한 시각
```
edges: `[from, to, kind]`, kind 0 = runtime, 1 = peer.

## 6. 배치 (DIRECTION D6, D8, D12)

> E1b에서 배치 v2로 바뀌었다: 아래 1–4로 만든 UMAP 좌표는 이제 **지역·행성계의 상대 위치**로만 쓴다.
> 관계망에 Leiden을 두 번(지역 → 행성계) 돌리고, 행성계 안은 궤도로 놓는다. 자세한 값은 [experiments/E1b-structure.md](experiments/E1b-structure.md).
> E1c에서 배치 v3: 기반 지역은 핵에, 나머지 지역은 나선팔 3개 위에 기반 → 응용 순서로 ([experiments/E1c-spiral.md](experiments/E1c-spiral.md)).
> E1d에서 배치 v4: 행성계 = 계정, 은하·지역 = 계정 그래프의 Leiden 공동체, 모양 = 계정 벡터의 UMAP. 나선은 강제하지 않는다 ([experiments/E1d-accounts.md](experiments/E1d-accounts.md), D16–D18).

1. 특징 토큰: 설명 단어, topics·keywords(×2), dependency 토큰(×1.5, **자기 자신 토큰 포함** — 그래서 react와 react를 쓰는 repo가 같은 토큰을 공유한다), 언어·조직(×0.3).
2. TF-IDF → SVD 64차원 → UMAP 3차원 (cosine, n_neighbors 15, 고정 random seed).
3. PCA로 가장 얇은 축을 세로(y)로 눕혀 원반을 만든다. 두께는 반지름의 약 12%.
4. 98번째 백분위 반지름을 **1000 단위**로 맞춘다.
5. 최소 간격 **4 단위**가 되도록 밀어낸다.
6. 토큰이 너무 적은 repo는 **관계 미확정 지역**(반지름 1150–1300의 바깥 고리)에 ID 해시로 놓는다.
7. `ledger.json`에 기록한다. **이미 기록된 repo는 다시 배치하지 않는다.** 새 repo는 SVD 공간에서 가장 가까운 기존 이웃 8개의 가중 중심 근처에서 ID 해시 순서로 빈자리를 찾는다.

**이웃 일관성 지표**: 각 repo의 공간상 가장 가까운 10개 중 "관련 있음"(직접 항로 / 흔하지 않은 topic 공유 / 흔하지 않은 dependency 2개 이상 공유)의 비율. 무작위 10개와 비교한다.

## 7. 행성 (DIRECTION D3)

- seed = `hash(repo ID + ":appearance:v1")`. 채널을 나눈다: 원형, 방향, 비율, 재질, 미세 노이즈.
- 반지름 0.6–0.9 단위 (seed). stars는 반지름에 쓰지 않는다 (K1, K2).
- 높이 = **랜드마크 원형 하나** + 약한 fbm 노이즈. 전체를 층(12–16단계)으로 양자화해 **종이를 겹겹이 깎은 듯한** 단면을 만든다. 층의 경계가 곧 등고선이다.
- E1 원형 6개: 거대 분지 / 고리 협곡 / 첨탑 / 균열 / 반구 절벽 / 계단 고원.
- E2(외형 v2) 원형 12개: + 쌍둥이 분지 / 적도 산맥 / 나선 홈 / 탁상 군도 / 세 갈래 균열 / 왕관. 무늬 5종, 부차 분화구, 팔레트 7개. `?look=1`로 v1 재현.
- 재질: PLAN.md K장 팔레트(`#D8CFBC` 뼈색, `#719C96` 청록, `#E6AC68` 온기, `#CA6D52` 강조)에서 파생한 5개 변주 중 seed로 하나. 언어는 색이 아니라 **결 무늬**(방향·주기)로 반영한다.
- 조명: 카메라 기준 좌상단 뒤쪽의 주광 하나 → 가장자리와 명암 경계가 항상 보인다. 무광, wrap lighting.
- 같은 셰이더를 이웃 행성(저해상도)과 선택 행성(고해상도)에 쓴다. 멀리서 본 실루엣과 가까이서 본 지형이 같아야 한다.

## 8. 화면과 스케일

| 배율 | 카메라 거리 | 보이는 것 |
|---|---|---|
| Galaxy | 1500–4500 | 지역 사이의 빈 공간, 광점, 집계 밀도(옅은 안개), 지역 이름 |
| Region | 300–900 | 중심별과 행성계 이름 |
| System | 20–300 | 궤도, 가까운 행성은 구체로, 이름 일부 |
| Orbit | 반지름의 1.6–40배 | 선택 행성 고해상도, 이웃 구체, 항로, 명판 |

- 광점과 구체는 **같은 위치에서** 교차 전환한다. 화면상 지름 6–12px 구간에서 섞는다.
- stars는 원경 광점의 밝기·크기에만 반영하고 **최대 2배**로 제한한다.
- 장식 먼지(배경의 아주 흐린 점)는 선택할 수 없고 개수에 세지 않는다 (K7).

## 9. 카메라

| 상태 | 동작 |
|---|---|
| Survey | 은하 전체. 첫 진입 시 천천히 회전 |
| Resolve | 입력을 목적지로 확정. 찾지 못하면 "아직 관측되지 않은 repo" 안내 (DIRECTION D7) |
| Departure | 뒤로 물러나며 떠오른다. 시선은 목적지 쪽으로 돈다 |
| Transit | 원반 위로 호를 그리며 이동 |
| Approach | 긴 감속. 이웃 이름이 드러난다 |
| Orbit | 도착 후 짧은 정적 → 명판. 드래그 회전, 휠 확대, 관성, roll 없음 |

- 항해 시간 = 2 + 2.6 · log10(1 + 거리/15)초, 2–9.5초로 제한. 재방문은 0.6배.
- 속도 곡선: 가속 30%, 감속 70%.
- 도착 구도: 행성이 화면 높이의 약 55%. 은하 중심 쪽을 등지게 서서, 행성 뒤로 은하가 보이게 한다.
- 클릭·Space·Esc로 언제든 건너뛰기. 항해 중 새 목적지를 고르면 현재 위치에서 다시 출발.
- `prefers-reduced-motion`: 0.8초 전환.
- 프레임이 떨어져도 경과 시간으로 진행해 정확히 도착한다.

## 10. 화면 구성

- **입력창**: 첫 화면 3초 뒤 등장. "이 안 어딘가에, 당신이 만든 것이 있습니다." 후보는 확실하지 않을 때만 최대 6개.
- **명판**(좌하단): `owner/` + `repo`, 설명 한 줄, 메타(★ · 언어 · 생성 연도 · 라이선스 · 관측일). 모르는 값은 `—`로 표시하고 0으로 쓰지 않는다 (K6).
- **항로 목록**(E1 임시): "딛고 선 곳"(dependencies) / "이 위에 선 곳"(dependents). 누르면 출발. E4에서 하늘로 옮긴다.
- **개인 별자리**: username의 행성을 최소 신장 트리로 잇는 가는 선, 전체가 들어오는 구도.
- **정보**: 관측 repo 수, 출처, 관측 시점, 데이터 라이선스.
- 글꼴: IBM Plex Mono(이름·숫자), IBM Plex Sans KR(문장). 박물관 명판처럼 작게.

## 11. 성능 목표 (데스크톱)

- 60fps (16.7ms), draw call 20 이하
- 초기 데이터 전송량 1MB 이하 (gzip). E1에서 "gzip 전 3MB"였던 기준을 바꿈 — PLAN.md 예산도 압축 후 전송량 기준이다
- 이웃 구체 최대 1,500개 동시

## 12. 코드 구조

```
docs/                    기획·결정·스펙·실험 기록
data/include.txt         테스트 참가자 (user:NAME 또는 owner/repo)
data/universe.db         좌표 장부 (v4: 계정 = 행성계). 서버가 새 계정을 여기에 더한다
data/model/              새 계정을 같은 공간에 놓는 고정 모델 (어휘·IDF·SVD)
data/raw/                API 캐시 (버전 관리 안 함)
data/build/              중간 산출물 (버전 관리 안 함)
pipeline/collect.py      npm 표본 → data/build/collected.json (계정 고르기의 출발점)
pipeline/accounts.py     계정과 그 repo·dependency → data/build/accounts.json
pipeline/universe.py     배치 v4 → data/universe.db, data/model/
server/app.py, ingest.py FastAPI: 우주·행성계 상세·검색·새 계정 들이기
web/                     Vite + React + React Three Fiber (/api는 서버로)
(배치 v1–v3의 layout.py·ledger.json·galaxy.json은 기록으로 남긴다)
```

## 13. 테스트 진행 (E5)

1. 참가자에게 URL만 준다. 설명하지 않는다.
2. 관찰자는 말을 걸지 않고, 멈춘 지점과 한 말을 적는다.
3. 5분 후 질문: "방금 도착한 곳은 뭐였나요?" / "두 번째로 간 곳과 첫 번째 곳은 어떤 관계였나요?" / "당신 행성을 한 문장으로 묘사해 주세요."
4. 다음날 메시지로 P5를 묻는다.
