// 행성 셰이더. 이웃 행성(저해상도)과 선택 행성(고해상도)이 같은 셰이더를 쓴다.
// 멀리서 본 실루엣과 가까이서 본 지형이 같아야 한다 (docs/PROTOTYPE_SPEC.md §7).
//
// 높이 = 랜드마크 원형 하나 + 약한 노이즈 → 층으로 양자화 (종이를 겹겹이 깎은 단면)
// 인스턴스 속성: iCenter(xyz, 반지름) iShape(원형, 팔레트, 층 수, 페이드) iAxis(xyz, 무늬) iParams iGrain iNoise
//               iRot iStar iStyle(무늬 축, 무늬 값) iSecond(부차 분화구 방향, 크기)
// iRot   행성의 방향(쿼터니언). 지형은 그대로 두고 랜드마크를 별빛 쪽으로 돌린다 (world/arrival.ts)
// iStar  행성계 중심별의 위치. w=1이면 그 별빛을 받고, 0이면 카메라 기준 주광(uLight)
import * as THREE from 'three'
import { PALETTES } from '../seed'

export const AMP = 0.075 // 반지름 대비 높이 진폭
/** 카메라 기준 주광 방향: 좌상단 옆. 명암 경계가 화면 오른쪽에 생긴다 */
export const VIEW_LIGHT: [number, number, number] = [-0.72, 0.48, 0.32]

const NOISE = /* glsl */ `
// Simplex 3D noise — Ian McEwan, Stefan Gustavson (MIT)
vec4 permute(vec4 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + 2.0 * C.xxx;
  vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;
  i = mod(i, 289.0);
  vec4 p = permute(permute(permute(
    i.z + vec4(0.0, i1.z, i2.z, 1.0)) +
    i.y + vec4(0.0, i1.y, i2.y, 1.0)) +
    i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 1.0 / 7.0;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
float fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * snoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
`

const TERRAIN = /* glsl */ `
#define AMP ${AMP.toFixed(4)}

vec3 qrot(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }

// 랜드마크 원형. p: 단위 방향, a: 원형의 축, q: 원형 파라미터 0..1
// mask: 랜드마크 자리 (강조색), edge: 랜드마크 윤곽에 새기는 가는 선
float landmark(vec3 p, float arch, vec3 a, vec4 q, out float mask, out float edge) {
  float c = clamp(dot(p, a), -1.0, 1.0);
  float ang = acos(c);
  vec3 b1 = normalize(cross(a, abs(a.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 b2 = cross(a, b1);
  float az = atan(dot(p, b2), dot(p, b1));
  float h = 0.0;
  mask = 0.0;
  edge = 0.0;
  if (arch < 0.5) {
    // 0 거대 분지
    float R = mix(0.5, 0.9, q.x);
    float d = ang / R;
    float depth = mix(0.75, 1.05, q.y);
    h = -depth * (1.0 - smoothstep(0.0, 1.0, d * d));
    h += mix(0.3, 0.5, q.z) * exp(-pow((d - 1.0) / 0.16, 2.0));
    if (q.w > 0.5) h += 0.6 * depth * exp(-pow(d / 0.12, 2.0));
    mask = 1.0 - smoothstep(0.7, 1.0, d);
    edge = exp(-pow((d - 1.0) / 0.035, 2.0));
  } else if (arch < 1.5) {
    // 1 고리 협곡
    float A = mix(0.55, 1.15, q.x);
    float w = mix(0.07, 0.13, q.y);
    float t = abs(ang - A) / w;
    h = -1.0 * (1.0 - smoothstep(0.55, 1.0, t)) + 0.28 * exp(-pow((t - 1.25) / 0.4, 2.0));
    h += mix(0.2, 0.5, q.z) * (1.0 - smoothstep(A - 1.8 * w, A - w, ang));
    mask = 1.0 - smoothstep(0.6, 1.0, t);
    edge = exp(-pow((t - 1.0) / 0.09, 2.0));
  } else if (arch < 2.5) {
    // 2 첨탑
    float w = mix(0.28, 0.45, q.x);
    float d = ang / w;
    float H = mix(1.6, 2.2, q.y);
    float flute = 0.14 * cos(az * floor(mix(5.0, 9.0, q.z))) * smoothstep(0.1, 0.6, d) * max(0.0, 1.0 - d);
    h = H * pow(max(0.0, 1.0 - d), mix(1.5, 2.4, q.w)) + max(0.0, flute);
    h -= 0.3 * exp(-pow((d - 1.15) / 0.25, 2.0));
    mask = 1.0 - smoothstep(0.0, 0.5, d);
  } else if (arch < 3.5) {
    // 3 균열: 대원을 따라 반쯤 갈라진 틈, 한쪽이 솟는다
    float s = dot(p, b1);
    float ext = smoothstep(-0.55 + 0.3 * q.y, -0.1, c);
    float w = mix(0.06, 0.11, q.x) * (0.5 + 0.7 * smoothstep(-0.4, 0.9, c));
    float t = abs(s) / w;
    h = -1.1 * (1.0 - smoothstep(0.45, 1.0, t)) * ext;
    h += 0.3 * exp(-pow((t - 1.3) / 0.45, 2.0)) * ext;
    h += mix(0.15, 0.4, q.z) * smoothstep(-0.04, 0.04, s) * ext;
    mask = (1.0 - smoothstep(0.5, 1.0, t)) * ext;
    edge = exp(-pow((t - 1.0) / 0.1, 2.0)) * ext;
  } else if (arch < 4.5) {
    // 4 반구 절벽: 축을 지나는 대원을 따라 절벽이 서고 한쪽이 고원이 된다.
    // 축 반대편으로 갈수록 절벽이 낮아져 사라진다. (절벽선이 축을 지나야 도착 구도에서 보인다)
    float off = mix(-0.12, 0.12, q.x);
    float e = dot(p, b1) - off + 0.07 * snoise(p * 3.1 + q.yzw * 10.0);
    float reach = smoothstep(-0.8, -0.15, c);
    float up = smoothstep(-0.015, 0.015, e) * reach;
    h = mix(-0.3, 0.7, up);
    h += 0.2 * smoothstep(0.0, 0.5, e) * snoise(p * 5.0 + 3.0) * reach;
    mask = (1.0 - smoothstep(0.0, 0.05, abs(e))) * reach;
    edge = exp(-pow(e / 0.014, 2.0)) * reach;
  } else if (arch < 5.5) {
    // 5 계단 고원
    float R = mix(0.7, 1.1, q.x);
    float d = clamp(ang / R, 0.0, 1.0);
    float k = floor(mix(4.0, 6.99, q.y));
    float cone = 1.0 - d + 0.04 * snoise(p * 6.0);
    float level = floor(cone * k);
    float fl = fract(cone * k);
    h = 1.9 * level / k - 0.2;
    mask = step(k - 1.0, level);
    edge = (1.0 - smoothstep(0.0, 0.06, min(fl, 1.0 - fl))) * (1.0 - step(0.999, d));
  } else if (arch < 6.5) {
    // 6 쌍둥이 분지: 크기가 다른 분지 둘이 맞닿는다
    float R1 = mix(0.42, 0.58, q.x);
    float R2 = R1 * mix(0.45, 0.7, q.y);
    float sep = R1 + R2 * 0.8;
    vec3 a2 = normalize(a * cos(sep) + b1 * sin(sep));
    float d1 = ang / R1;
    float d2 = acos(clamp(dot(p, a2), -1.0, 1.0)) / R2;
    h = -0.95 * (1.0 - smoothstep(0.0, 1.0, d1 * d1)) + 0.4 * exp(-pow((d1 - 1.0) / 0.16, 2.0));
    h += -0.8 * (1.0 - smoothstep(0.0, 1.0, d2 * d2)) + 0.35 * exp(-pow((d2 - 1.0) / 0.18, 2.0));
    mask = max(1.0 - smoothstep(0.7, 1.0, d1), 1.0 - smoothstep(0.7, 1.0, d2));
    edge = max(exp(-pow((d1 - 1.0) / 0.035, 2.0)), exp(-pow((d2 - 1.0) / 0.045, 2.0)));
  } else if (arch < 7.5) {
    // 7 적도 산맥: 축을 지나는 대원을 따라 좁고 높은 산맥이 행성을 한 바퀴 두른다
    float s = dot(p, b1);
    float w = mix(0.035, 0.06, q.x);
    float jag = 1.0 + 0.35 * snoise(p * 9.0 + q.yzw * 7.0);
    h = mix(1.1, 1.6, q.y) * exp(-pow(s / w, 2.0)) * jag;
    h -= 0.15 * exp(-pow(s / (w * 4.0), 2.0));
    mask = exp(-pow(s / (w * 0.8), 2.0));
    edge = exp(-pow((abs(s) - w * 1.3) / (w * 0.25), 2.0));
  } else if (arch < 8.5) {
    // 8 나선 홈: 축에서 바깥으로 감겨 나가는 홈
    float pitch = mix(0.26, 0.36, q.x);
    float t = ang / pitch - (az + 3.14159265) / 6.2831853 * (q.y > 0.5 ? 1.0 : -1.0);
    float dist = min(fract(t), 1.0 - fract(t));
    float reach = 1.0 - smoothstep(1.0, 1.35, ang);
    float groove = 1.0 - smoothstep(0.05, 0.2, dist);
    h = -0.65 * groove * reach + 0.25 * (1.0 - smoothstep(0.0, 0.2, ang));
    mask = groove * reach * 0.5;
    edge = exp(-pow((dist - 0.2) / 0.025, 2.0)) * reach * 0.6;
  } else if (arch < 9.5) {
    // 9 탁상 군도: 낮은 평원 위에 꼭대기가 평평한 대지들이 모여 있다
    float R = mix(0.8, 1.2, q.x);
    float inside = 1.0 - smoothstep(R * 0.8, R, ang);
    float n = snoise(p * mix(3.0, 4.5, q.y) + q.zwx * 20.0);
    float top = smoothstep(0.18, 0.24, n) * inside;
    h = -0.25 * inside + top;
    mask = top;
    edge = (1.0 - smoothstep(0.0, 0.03, abs(n - 0.21))) * inside;
  } else if (arch < 10.5) {
    // 10 세 갈래 균열: 한 점에서 세 틈이 120°로 뻗는다
    float L = mix(0.9, 1.3, q.x);
    float w = mix(0.05, 0.08, q.y);
    float best = 10.0;
    for (int k = 0; k < 3; k++) {
      float phi = q.z * 6.2831853 + float(k) * 2.0943951;
      float dphi = abs(mod(az - phi + 3.14159265, 6.2831853) - 3.14159265);
      best = min(best, dphi * sin(ang));
    }
    float along = 1.0 - smoothstep(L * 0.7, L, ang);
    float t = best / w;
    h = -1.0 * (1.0 - smoothstep(0.45, 1.0, t)) * along;
    h += 0.25 * exp(-pow((t - 1.3) / 0.4, 2.0)) * along;
    h -= 0.5 * exp(-pow(ang / 0.12, 2.0));
    mask = (1.0 - smoothstep(0.5, 1.0, t)) * along;
    edge = exp(-pow((t - 1.0) / 0.1, 2.0)) * along;
  } else {
    // 11 왕관: 가운데 우묵한 곳을 봉우리 고리가 둘러싼다
    float A = mix(0.32, 0.48, q.x);
    float w = mix(0.07, 0.1, q.y);
    float nPeaks = floor(mix(6.0, 9.99, q.z));
    float ring = exp(-pow((ang - A) / w, 2.0));
    float peaks = pow(0.5 + 0.5 * cos(az * nPeaks + q.w * 6.28), 2.0);
    h = 1.9 * ring * (0.35 + 0.65 * peaks);
    h -= 0.55 * (1.0 - smoothstep(0.0, A * 0.85, ang));
    mask = ring * peaks;
    edge = exp(-pow((ang - A * 0.85) / 0.02, 2.0)) * 0.7;
  }
  return h;
}

float rawHeight(vec3 p, vec4 shape, vec4 axis, vec4 params, vec4 noise, vec4 second, out float mask, out float edge) {
  float h = landmark(p, shape.x, axis.xyz, params, mask, edge);
  // 부차 분화구: 다른 각도에서 봐도 이 행성이라는 단서
  if (second.w > 0.0) {
    float d = acos(clamp(dot(p, second.xyz), -1.0, 1.0)) / second.w;
    h += -0.6 * (1.0 - smoothstep(0.0, 1.0, d * d)) + 0.28 * exp(-pow((d - 1.0) / 0.2, 2.0));
    edge = max(edge, exp(-pow((d - 1.0) / 0.05, 2.0)) * 0.6);
  }
  // 노이즈는 랜드마크를 돋보이게 하는 질감이다. 세면 모든 행성이 같은 공이 된다 (E1 갤러리)
  h += fbm(p * 1.6 + noise.xyz) * 0.12 + snoise(p * 6.0 + noise.zyx) * 0.025;
  return h;
}

// 층으로 양자화. 층 사이는 좁고 가파른 경사로 잇는다.
float terrace(float h, float steps) {
  float x = h * steps * 0.5;
  float i = floor(x);
  return (i + smoothstep(0.8, 1.0, x - i)) / (steps * 0.5);
}
`

const vertexShader = /* glsl */ `
attribute vec4 iCenter;
attribute vec4 iShape;
attribute vec4 iAxis;
attribute vec4 iParams;
attribute vec4 iGrain;
attribute vec4 iNoise;
attribute vec4 iRot;
attribute vec4 iStar;
attribute vec4 iStyle;
attribute vec4 iSecond;
flat varying vec4 vShape;
flat varying vec4 vAxis;
flat varying vec4 vParams;
flat varying vec4 vGrain;
flat varying vec4 vNoise;
flat varying vec4 vCenter;
flat varying vec4 vRot;
flat varying vec4 vStar;
flat varying vec4 vStyle;
flat varying vec4 vSecond;
varying vec3 vDir;
varying vec3 vWorld;
${NOISE}
${TERRAIN}
void main() {
  vShape = iShape; vAxis = iAxis; vParams = iParams; vGrain = iGrain; vNoise = iNoise; vCenter = iCenter; vRot = iRot; vStar = iStar;
  vStyle = iStyle; vSecond = iSecond;
  vec3 pw = normalize(position);
  vec3 p = qrot(vec4(-iRot.xyz, iRot.w), pw); // 행성 좌표계의 방향
  float m, ed;
  float h = terrace(rawHeight(p, iShape, iAxis, iParams, iNoise, iSecond, m, ed), iShape.z);
  vec3 world = iCenter.xyz + pw * iCenter.w * (1.0 + AMP * h);
  vDir = p;
  vWorld = world;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`

const fragmentShader = /* glsl */ `
uniform vec3 uLight;
uniform float uExposure;
uniform vec3 uPalette[${PALETTES.length * 4}];
flat varying vec4 vShape;
flat varying vec4 vAxis;
flat varying vec4 vParams;
flat varying vec4 vGrain;
flat varying vec4 vNoise;
flat varying vec4 vCenter;
flat varying vec4 vRot;
flat varying vec4 vStar;
flat varying vec4 vStyle;
flat varying vec4 vSecond;
varying vec3 vDir;
varying vec3 vWorld;
${NOISE}
${TERRAIN}
void main() {
  // 점 ↔ 구체 교차 전환: 정렬이 필요 없는 screen-door 페이드
  float fade = vShape.w;
  if (fade < 0.999) {
    float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    if (n > fade) discard;
  }
  vec3 p = normalize(vDir);
  float steps = vShape.z;
  float mask, edge, m2, e2;
  float hr = rawHeight(p, vShape, vAxis, vParams, vNoise, vSecond, mask, edge);
  float h = terrace(hr, steps);

  // 픽셀마다 높이의 기울기로 법선을 구한다 (메시 해상도와 무관하게 같은 지형)
  vec3 t1 = normalize(cross(p, abs(p.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 t2 = cross(p, t1);
  float e = 0.0028;
  vec3 pa = normalize(p + t1 * e);
  vec3 pb = normalize(p + t2 * e);
  float ha = terrace(rawHeight(pa, vShape, vAxis, vParams, vNoise, vSecond, m2, e2), steps);
  float hb = terrace(rawHeight(pb, vShape, vAxis, vParams, vNoise, vSecond, m2, e2), steps);
  vec3 P0 = p * (1.0 + AMP * h);
  vec3 N = normalize(cross(pa * (1.0 + AMP * ha) - P0, pb * (1.0 + AMP * hb) - P0));
  if (dot(N, p) < 0.0) N = -N;
  N = qrot(vRot, N);
  vec3 pw = qrot(vRot, p);

  int pal = int(vShape.y + 0.5) * 4;
  vec3 cLow = uPalette[pal], cMid = uPalette[pal + 1], cHigh = uPalette[pal + 2], cAccent = uPalette[pal + 3];
  float hn = clamp(h * 0.34 + 0.46, 0.0, 1.0);
  vec3 col = mix(cLow, cMid, smoothstep(0.18, 0.5, hn));
  col = mix(col, cHigh, smoothstep(0.62, 0.92, hn));
  col = mix(col, cAccent, mask * 0.55);

  // 무늬 (seed): 어느 각도에서 봐도 보이는 큰 명암. 밝은 팔레트는 어둡게, 어두운 팔레트는 밝게 대비한다
  float style = vAxis.w;
  vec3 sAxis = vStyle.xyz;
  float sParam = vStyle.w;
  bool bright = dot(cMid, vec3(0.3, 0.59, 0.11)) > 0.15;
  vec3 alt = bright ? cLow * 0.6 : cHigh * 0.85;
  if (style > 0.5 && style < 1.5) {
    // 두 빛깔: 대원을 경계로 한쪽 반구가 다른 빛깔
    float side = dot(p, sAxis) + 0.07 * snoise(p * 2.6 + vNoise.xyz);
    col = mix(col, mix(col, alt, 0.72), smoothstep(-0.03, 0.03, side));
  } else if (style > 1.5 && style < 2.5) {
    // 띠
    float lat = asin(clamp(dot(p, sAxis), -1.0, 1.0));
    float b = smoothstep(-0.25, 0.25, sin(lat * sParam + snoise(p * 2.0 + vNoise.yzx) * 0.7));
    col = mix(col, mix(col, alt, 0.62), b);
  } else if (style > 2.5 && style < 3.5) {
    // 어두운 바다
    float m = fbm(p * 1.25 + vNoise.yzx * 0.37);
    col = mix(col, alt, smoothstep(sParam - 0.03, sParam + 0.03, m) * 0.78);
  } else if (style > 3.5) {
    // 극관
    float cz = dot(p, sAxis) + 0.03 * snoise(p * 5.0 + vNoise.xyz);
    float cap = smoothstep(1.0 - sParam - 0.02, 1.0 - sParam + 0.02, cz);
    float cap2 = smoothstep(1.0 - sParam * 0.5 - 0.02, 1.0 - sParam * 0.5 + 0.02, -cz);
    col = mix(col, vec3(0.9, 0.87, 0.8), max(cap, cap2) * 0.85);
  }

  // 언어 → 결 무늬 (색이 아니라 광물 결)
  if (vGrain.w > 0.0) {
    float g = sin(dot(p, vGrain.xyz) * vGrain.w + snoise(p * 4.0 + vNoise.xyz) * 1.6);
    col *= 1.0 + 0.05 * g;
  }

  // 층 경계(경사면)는 어둡게 → 등고선
  float f = fract(hr * steps * 0.5);
  float riser = smoothstep(0.78, 0.84, f) * (1.0 - smoothstep(0.97, 1.0, f));
  col *= mix(1.0, 0.72, riser);
  // 랜드마크 윤곽은 가는 선으로 새긴다 (정밀한 지도)
  col = mix(col, cLow * 0.55, edge * 0.55);

  vec3 L = vStar.w > 0.5 ? normalize(vStar.xyz - vCenter.xyz) : normalize(uLight);
  vec3 V = normalize(cameraPosition - vWorld);
  float ndl = dot(N, L);
  float diff = clamp((ndl + 0.18) / 1.18, 0.0, 1.0);
  diff = pow(diff, 1.25);
  vec3 lit = col * (diff * vec3(1.0, 0.955, 0.89) * 1.08 * uExposure + vec3(0.032, 0.046, 0.05));
  float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0);
  lit += rim * vec3(0.17, 0.26, 0.25) * smoothstep(-0.3, 0.4, dot(pw, L));

  gl_FragColor = vec4(lit, 1.0);
  #include <colorspace_fragment>
}
`

export const INSTANCE_ATTRIBUTES = [
  'iCenter',
  'iShape',
  'iAxis',
  'iParams',
  'iGrain',
  'iNoise',
  'iRot',
  'iStar',
  'iStyle',
  'iSecond',
] as const

export function createPlanetMaterial() {
  const palette = PALETTES.flat().map((hex) => new THREE.Color(hex))
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uLight: { value: new THREE.Vector3(...VIEW_LIGHT).normalize() },
      uExposure: { value: 1 },
      uPalette: { value: palette },
    },
  })
}

/** 인스턴스 속성을 가진 구 geometry */
export function createPlanetGeometry(widthSegments: number, heightSegments: number, capacity: number) {
  const sphere = new THREE.SphereGeometry(1, widthSegments, heightSegments)
  const geo = new THREE.InstancedBufferGeometry()
  geo.index = sphere.index
  geo.setAttribute('position', sphere.getAttribute('position'))
  for (const name of INSTANCE_ATTRIBUTES) {
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
    attr.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute(name, attr)
  }
  geo.instanceCount = 0
  sphere.dispose()
  return geo
}
