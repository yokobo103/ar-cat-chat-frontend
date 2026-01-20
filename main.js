import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";


const API_BASE = "https://ar-cat-chat-api.vercel.app";

async function callLLM(message){
  const r = await fetch(`${API_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message })
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`API ${r.status}: ${t}`);
  }
  return await r.json(); // { answer, mood }
}



const video = document.getElementById("cam");
const canvas = document.getElementById("gl");
const bubble = document.getElementById("bubble");
const input = document.getElementById("q");
const sendBtn = document.getElementById("send");
const newChatBtn = document.getElementById("new-chat");
const BASE = { w: window.innerWidth, h: window.innerHeight };

function isKeyboardActive() {
  return document.body.classList.contains("kbd") || document.activeElement === input;
}

function isKeyboardResize(w, h) {
  const looksLikeKeyboard = (w === BASE.w) && (h < BASE.h);
  const hasViewportShrink = window.visualViewport
    ? window.visualViewport.height < BASE.h
    : false;
  return looksLikeKeyboard && (isKeyboardActive() || hasViewportShrink);
}


input.addEventListener("focus", () => {
  document.body.classList.add("kbd");
  document.documentElement.style.setProperty("--vvh", `${BASE.h}px`);
  updateKeyboardOffset();
});
input.addEventListener("blur", () => {
  document.body.classList.remove("kbd");
  updateVVH(true);
  updateKeyboardOffset();
});

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" } },
    audio: false
  });
  video.srcObject = stream;
  await video.play();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ===== Three.js =====
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.01, 50);
camera.position.set(0, 0, 1.5);

// light
scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.25));
const dir = new THREE.DirectionalLight(0xffffff, 0.85);
dir.position.set(1.2, 1.8, 1.0);
scene.add(dir);

let cat = null;
let mood = "neutral"; // neutral | happy | angry | sad | surprised
let moodUntil = 0;
let popUntil = 0;     // ぴょん演出の終了時刻
let catAnchor = new THREE.Vector3(-0.48, 0.02, -1.2); // 初期位置（カメラ前方）
let t0 = performance.now();

// 猫ロード
const loader = new GLTFLoader();
loader.load("./models/cat2.glb", (gltf) => {
  cat = gltf.scene;
  cat.position.copy(catAnchor);
  cat.scale.setScalar(0.6);
  scene.add(cat);

  // ちょい材質調整（真っ黒回避）
  cat.traverse((o) => {
    if (o.isMesh && o.material) {
      o.material.metalness = Math.min(0.2, o.material.metalness ?? 0.2);
      o.material.roughness = Math.max(0.6, o.material.roughness ?? 0.6);
    }
  });
}, undefined, (err) => {
  console.error(err);
  alert("cat2.glb の読み込みに失敗。パスとファイル名を確認してね。");
});

function resize(force = false) {
  const w = window.innerWidth;
  const h = window.innerHeight;

  // 入力中の「高さだけ変わる」リサイズは無視（猫を動かさない）
  if (!force && isKeyboardResize(w, h)) return;

  BASE.w = w;
  BASE.h = h;

  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", () => resize(false));
resize(true);


const logEl = document.getElementById("log");
const fxEl  = document.getElementById("fx");

function addLog(role, text){
  const row = document.createElement("div");
  row.className = "msg";
  row.innerHTML = `
    <div class="badge">${role === "user" ? "YOU" : "CAT"}</div>
    <div class="text"></div>
  `;
  row.querySelector(".text").textContent = text;
  logEl.appendChild(row);
  logEl.scrollTop = logEl.scrollHeight;
}

function setBubble(text){
  bubble.textContent = text;
  bubble.classList.remove("hidden");
  updateBubblePosition();
}

function showFx(emoji, ms=900){
  fxEl.textContent = emoji;
  fxEl.classList.remove("hidden");
  const until = performance.now() + ms;
  const tick = () => {
    if (performance.now() > until) { fxEl.classList.add("hidden"); return; }
    requestAnimationFrame(tick);
  };
  tick();
}



function updateBubblePosition() {
  if (!cat) return;
  if (isKeyboardActive()) return; // ←追加

  // 吹き出し
  if (!bubble.classList.contains("hidden")) {
    const p = cat.position.clone(); p.y += 0.45;
    p.project(camera);
    const x = (p.x * 0.5 + 0.5) * BASE.w;
    const y = (-p.y * 0.5 + 0.5) * BASE.h;
    bubble.style.left = `${x+40}px`;
    bubble.style.top  = `${y}px`;
  }

  // エフェクト（少し上）
  if (!fxEl.classList.contains("hidden")) {
    const p2 = cat.position.clone(); p2.y += 0.62;
    p2.project(camera);
    const x2 = (p2.x * 0.5 + 0.5) * BASE.w;
    const y2 = (-p2.y * 0.5 + 0.5) * BASE.h;
    fxEl.style.left = `${x2}px`;
    fxEl.style.top  = `${y2}px`;
  }
}


function setBubbleMood(m) {
  bubble.dataset.mood = m; // CSSで色を変える
}

function setMood(m, ms = 1800) {
  mood = m;
  moodUntil = performance.now() + ms;
  setBubbleMood(m);
}

function pop(ms = 300) {
  popUntil = performance.now() + ms;
}



// 猫の疑似アニメ（Blender不要）
function animateCat(time) {
  if (!cat) return;

  const now = performance.now();
  const t = (time - t0) / 1000;

  // moodの期限が切れたらneutralへ戻す
  if (mood !== "neutral" && now > moodUntil) {
    mood = "neutral";
    setBubbleMood("neutral");
  }

  // ベース（待機）
    const baseY    = catAnchor.y + Math.sin(t * 1.6) * 0.006; // 呼吸レベル
    const baseRotY = Math.sin(t * 0.4) * 0.04;               // わずかに揺れる
    const baseRotX = Math.sin(t * 0.7) * 0.015;              // 首の動き


  // デフォルト
  let y = baseY;
  let rx = baseRotX;
  let ry = baseRotY;
  let shakeX = 0;
  let shakeY = 0;
  let scale = 0.6;

  // ぴょん（pop）
  if (now < popUntil) {
    const u = 1 - (popUntil - now) / 300;
    const jump = Math.sin(u * Math.PI) * 0.06;
    y += jump;
    scale *= 1.08;
  }

  // 感情ごとの上書き
  if (mood === "happy") {
    y += Math.sin(t * 6.0) * 0.01;
    ry += Math.sin(t * 2.4) * 0.12;
    scale *= 1.06;
  } else if (mood === "angry") {
    // 小刻み震え + ちょい前のめり
    shakeX = (Math.random() - 0.5) * 0.01;
    shakeY = (Math.random() - 0.5) * 0.01;
    rx += 0.12;
    ry *= 0.4;
    scale *= 1.02;
  } else if (mood === "sad") {
    y -= 0.03;
    rx -= 0.10;
    ry *= 0.2;
    scale *= 0.98;
  } else if (mood === "surprised") {
    // びくっ（短時間向け）
    scale *= 1.10;
    rx -= 0.08;
    ry += 0.22;
  }

  // 反映
  cat.position.x = catAnchor.x + shakeX;
  cat.position.y = y + shakeY;
  cat.position.z = catAnchor.z;

  cat.rotation.x = rx;
  cat.rotation.y = ry;

  cat.scale.setScalar(scale);
}


// 返答中のうなずき演出
async function nodOnce() {
  if (!cat) return;
  const base = cat.rotation.x;
  const dur = 260;
  const start = performance.now();
  while (performance.now() - start < dur) {
    const u = (performance.now() - start) / dur;
    cat.rotation.x = base + Math.sin(u * Math.PI) * 0.22;
    await sleep(16);
  }
  cat.rotation.x = base;
}

// ====== Chat（Phase1: ダミー） ======
function dummyAnswer(q) {
  const s = q.toLowerCase();

  if (s.includes("ar")) {
    return "ARは“置けた感”が出ると一気に楽しくなるよ。まず疑似ARで体験を作ろう。";
  }
  if (s.includes("blender")) {
    return "BlenderはIdle1本だけ付けるのが最短。完璧を狙わないのがコツ。";
  }
  return "なるほど。もう少し詳しく聞かせて。";
}


function detectMoodFromText(text) {
  const t = text.toLowerCase();

  if (t.includes("ありがとう") || t.includes("すごい") || t.includes("助かる")) {
    return "happy";
  }
  if (t.includes("だめ") || t.includes("無理") || t.includes("怒")) {
    return "angry";
  }
  if (t.includes("つら") || t.includes("悲") || t.includes("しんど")) {
    return "sad";
  }
  if (t.includes("え") || t.includes("まじ") || t.includes("驚")) {
    return "surprised";
  }
  return "neutral";
}


async function onSend(){
  const q = input.value.trim();
  if(!q) return;
  input.value = "";

  addLog("user", q);

  setBubble("…考え中");
  setMood("neutral", 800);

  await nodOnce();
  await sleep(250);

  let answer = "";
  let m = "neutral";

  try {
    const data = await callLLM(q); // { answer, mood }
    answer = (data?.answer || "").trim() || "（うまく返せなかった…）";
    m = data?.mood || detectMoodFromText(answer);
  } catch (e) {
    console.error(e);
    answer = "（通信エラー。もう一回送ってみて）";
    m = "sad";
  }

  addLog("cat", answer);

  setMood(m, 2200);

  if (m === "happy") showFx("✨", 900);
  if (m === "angry") showFx("💢", 900);
  if (m === "sad") showFx("💧", 900);
  if (m === "surprised") showFx("❗️", 700);

  setBubble(answer);
  await nodOnce();
}




sendBtn.addEventListener("click", onSend);
newChatBtn.addEventListener("click", () => {
  logEl.innerHTML = "";
  setMood("neutral", 800);
  setBubble("新しいチャットを始めよう。");
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") onSend();
});

// render loop
function loop(time) {
  requestAnimationFrame(loop);
  animateCat(time);
  updateBubblePosition();
  renderer.render(scene, camera);
}

function updateVVH(force = false) {
  const w = window.innerWidth;
  const h = window.innerHeight;

  if (!force && isKeyboardResize(w, h)) return;

  BASE.w = w;
  BASE.h = h;
  document.documentElement.style.setProperty("--vvh", `${h}px`);
}

function updateKeyboardOffset() {
  if (!window.visualViewport) {
    document.documentElement.style.setProperty("--kbd", "0px");
    return;
  }

  const kbd = document.body.classList.contains("kbd");
  if (!kbd) {
    document.documentElement.style.setProperty("--kbd", "0px");
    return;
  }

  const vv = window.visualViewport;
  const offset = Math.max(0, BASE.h - vv.height - vv.offsetTop);
  document.documentElement.style.setProperty("--kbd", `${offset}px`);
}

updateVVH(true);
updateKeyboardOffset();
window.addEventListener("resize", () => {
  updateVVH(false);
  updateKeyboardOffset();
});
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", updateKeyboardOffset);
  window.visualViewport.addEventListener("scroll", updateKeyboardOffset);
}

(async function boot() {
  await startCamera();
  loop(performance.now());
  setBubble("やあ。質問してみて（例：ARで吹き出しってどうする？）");
})();
