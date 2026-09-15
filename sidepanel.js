import { HandLandmarker, FilesetResolver } from './vendor/vision_bundle.mjs';

/* ---------------------------------------------------------------
   CONFIG
--------------------------------------------------------------- */
const CFG = {
  PINCH_ON: 0.30, PINCH_OFF: 0.5,
  FIST_ON: 1.28, OPEN_ON: 1.55,
  TWO_FINGER_ON: 1.5, OTHERS_OFF: 1.28,
  THUMB_ON: 1.35, THUMB_UPDOWN_MARGIN: 0.03,
  PINKY_ON: 1.32,
  POINT_INDEX_ON: 1.55,
  CURSOR_SEND_MS: 45,
  CURSOR_MARGIN: 0.24,          // fraction of frame trimmed off each edge before mapping to full screen — higher = more sensitive
  EMA: 0.45,
  TRACK_GRACE_MS: 250,

  TAB_SWITCH_HOLD_MS: 800,
  SHAKA_HOLD_MS: 800,
  VOICE_TIMEOUT_MS: 6000,

  SCROLL_SENSITIVITY: 14,      // multiplies raw hand-movement px into scroll px — high on purpose
  SCROLL_SEND_MS: 60,          // throttle for scroll messages

  SWIPE_SPEED_MIN: 38,         // px per 100ms
  SWIPE_COOLDOWN_MS: 700,

  ZOOM_MIN: 0.25, ZOOM_MAX: 5,
  ZOOM_SEND_MS: 80
};

const GESTURE_COLOR = {
  open:'#dfe4ea', fist:'rgba(243,240,255,0.4)', peace:'#8fa6ff',
  pinch:'#8fa6ff', thumbsDown:'#dfe4ea', thumbsUp:'#7be6c4', shaka:'#ff8b7b', point:'#ffd37b',
  neutral:'rgba(243,240,255,0.4)'
};
const GESTURE_LABEL = {
  open:'SWIPE', fist:'IDLE', peace:'CLICK (after ☝️)', pinch:'SCROLL (2-hand = ZOOM)',
  thumbsDown:'HOLD → PREV TAB', thumbsUp:'HOLD → NEXT TAB',
  shaka:'HOLD → VOICE', point:'CURSOR', neutral:'IDLE'
};

/* ---------------------------------------------------------------
   DOM
--------------------------------------------------------------- */
const video = document.getElementById('cam');
const startScreen = document.getElementById('startScreen');
const startBtn = document.getElementById('startBtn');
const previewToggle = document.getElementById('previewToggle');
const statusEl = document.getElementById('status');
const chipLeft = document.getElementById('chipLeft');
const chipRight = document.getElementById('chipRight');
const zoomInfo = document.getElementById('zoomInfo');
const fpsInfo = document.getElementById('fpsInfo');
const micIndicator = document.getElementById('micIndicator');
const toastEl = document.getElementById('toast');
const svgHandLeft = document.getElementById('handLeft');
const svgHandRight = document.getElementById('handRight');

function showToast(msg){
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(()=> toastEl.classList.remove('show'), 1400);
}

/* ---------------------------------------------------------------
   BROWSER ACTIONS (messages to the background service worker)
--------------------------------------------------------------- */
function send(msg){
  return chrome.runtime.sendMessage(msg).catch(()=>({ ok:false }));
}

let lastKnownZoom = 1;
async function refreshZoomDisplay(){
  const r = await send({ type:'getZoom' });
  if(r && r.ok){ lastKnownZoom = r.zoom; zoomInfo.textContent = 'ZOOM ' + Math.round(r.zoom*100) + '%'; }
}
refreshZoomDisplay();

/* ---------------------------------------------------------------
   HAND TRACKING
--------------------------------------------------------------- */
let handLandmarker;
let running = false;
let lastVideoTime = -1;

function freshHandState(){
  return {
    present:false, landmarks:null, palm:{x:0.5,y:0.5}, pinch:{x:0.5,y:0.5},
    pinchRatioEMA:1, extIndexEMA:1, extMiddleEMA:1, extRingEMA:1, extPinkyEMA:1, extThumbEMA:1,
    gesture:'neutral', lastSeenAt:0,
    panDX:0, panDY:0,
    posHistory:[],           // for open-palm swipe detection
    lastSwipeAt:0,
    modeHoldGesture:null, modeHoldStart:0, modeArmed:true,
    cursorActive:false, lastCursorSendAt:0, clickArmed:false
  };
}
const hands = { Left: freshHandState(), Right: freshHandState() };

function dist(a,b){ return Math.hypot(a.x-b.x, a.y-b.y); }
function mirrorX(x){ return 1-x; }
function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }
// maps the central (1 - 2*margin) portion of the frame to the full 0-1 range, so you
// don't have to physically sweep your hand to the very edges of the camera view
function amplify(v, margin){ return clamp((v - margin) / (1 - margin*2), 0, 1); }

async function initModel(){
  const vision = await FilesetResolver.forVisionTasks('./vendor/wasm');
  const opts = {
    baseOptions:{ modelAssetPath:"https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task" },
    runningMode:"VIDEO", numHands:2,
    minHandDetectionConfidence:0.5, minHandPresenceConfidence:0.5, minTrackingConfidence:0.5
  };
  try{ opts.baseOptions.delegate="GPU"; handLandmarker = await HandLandmarker.createFromOptions(vision, opts); }
  catch(e){ opts.baseOptions.delegate="CPU"; handLandmarker = await HandLandmarker.createFromOptions(vision, opts); }
}
async function initCamera(){
  const stream = await navigator.mediaDevices.getUserMedia({
    video:{ facingMode:"user", width:{ideal:480}, height:{ideal:360} }, audio:false
  });
  video.srcObject = stream;
  await new Promise(res => { video.onloadedmetadata = () => { video.play(); res(); }; });
}

function updateHandFromLandmarks(side, lm){
  const h = hands[side];
  h.present = true; h.landmarks = lm;

  const wrist=lm[0], indexMcp=lm[5], middleMcp=lm[9], ringMcp=lm[13], pinkyMcp=lm[17];
  const palmRef = Math.max(0.02, dist(wrist, middleMcp));
  const pinchRatio = dist(lm[4], lm[8]) / palmRef;

  function ext(tipI,mcpI){ return dist(lm[tipI],wrist) / Math.max(0.01, dist(lm[mcpI],wrist)); }
  const extIndex=ext(8,5), extMiddle=ext(12,9), extRing=ext(16,13), extPinky=ext(20,17), extThumb=ext(4,2);

  h.pinchRatioEMA += (pinchRatio - h.pinchRatioEMA) * CFG.EMA;
  h.extIndexEMA += (extIndex - h.extIndexEMA) * CFG.EMA;
  h.extMiddleEMA += (extMiddle - h.extMiddleEMA) * CFG.EMA;
  h.extRingEMA += (extRing - h.extRingEMA) * CFG.EMA;
  h.extPinkyEMA += (extPinky - h.extPinkyEMA) * CFG.EMA;
  h.extThumbEMA += (extThumb - h.extThumbEMA) * CFG.EMA;
  const avgExt = (h.extIndexEMA + h.extMiddleEMA + h.extRingEMA + h.extPinkyEMA) / 4;

  const wasPinching = h.gesture === 'pinch';
  const pinchThreshold = wasPinching ? CFG.PINCH_OFF : CFG.PINCH_ON;

  if(h.pinchRatioEMA < pinchThreshold){
    h.gesture = 'pinch';
  } else if(h.extIndexEMA > CFG.TWO_FINGER_ON && h.extMiddleEMA > CFG.TWO_FINGER_ON &&
            h.extRingEMA < CFG.OTHERS_OFF && h.extPinkyEMA < CFG.OTHERS_OFF){
    h.gesture = 'peace';
  } else if(h.extThumbEMA > CFG.THUMB_ON && h.extPinkyEMA > CFG.PINKY_ON &&
            h.extIndexEMA < CFG.OTHERS_OFF && h.extMiddleEMA < CFG.OTHERS_OFF && h.extRingEMA < CFG.OTHERS_OFF){
    h.gesture = 'shaka';
  } else if(h.extIndexEMA > CFG.POINT_INDEX_ON && h.extMiddleEMA < CFG.OTHERS_OFF &&
            h.extRingEMA < CFG.OTHERS_OFF && h.extPinkyEMA < CFG.OTHERS_OFF){
    h.gesture = 'point';
  } else if(avgExt < CFG.FIST_ON && h.extThumbEMA > CFG.THUMB_ON && lm[4].y > wrist.y + CFG.THUMB_UPDOWN_MARGIN){
    h.gesture = 'thumbsDown';
  } else if(avgExt < CFG.FIST_ON && h.extThumbEMA > CFG.THUMB_ON && lm[4].y < wrist.y - CFG.THUMB_UPDOWN_MARGIN){
    h.gesture = 'thumbsUp';
  } else if(avgExt < CFG.FIST_ON){
    h.gesture = 'fist';
  } else if(avgExt > CFG.OPEN_ON){
    h.gesture = 'open';
  } else {
    h.gesture = 'neutral';
  }

  const pts=[wrist,indexMcp,middleMcp,ringMcp,pinkyMcp];
  const cx=pts.reduce((a,p)=>a+p.x,0)/pts.length, cy=pts.reduce((a,p)=>a+p.y,0)/pts.length;
  const newPalm = { x: mirrorX(cx), y: cy };
  // use the camera's actual resolution, not the preview element's on-screen size —
  // the preview can be hidden or resized without changing how gestures are measured
  const w = video.videoWidth || 640, hh = video.videoHeight || 480;
  h.panDX = (newPalm.x - h.palm.x) * w;
  h.panDY = (newPalm.y - h.palm.y) * hh;
  h.palm = newPalm;
  h.pinch = { x: mirrorX((lm[4].x+lm[8].x)/2), y: (lm[4].y+lm[8].y)/2 };
}

function trackFrame(){
  if(video.readyState<2 || video.currentTime===lastVideoTime) return;
  lastVideoTime = video.currentTime;
  const ts = performance.now();
  let result;
  try{ result = handLandmarker.detectForVideo(video, ts); }catch(e){ return; }

  const seenSides = new Set();
  if(result && result.landmarks){
    result.landmarks.forEach((lm,i) => {
      const raw = result.handedness?.[i]?.[0]?.categoryName || "Right";
      const side = raw==="Left" ? "Right" : "Left";
      seenSides.add(side);
      hands[side].lastSeenAt = ts;
      updateHandFromLandmarks(side, lm);
    });
  }
  for(const side of ['Left','Right']){
    if(!seenSides.has(side) && ts - hands[side].lastSeenAt > CFG.TRACK_GRACE_MS){
      hands[side].present = false;
    }
  }
}

/* ---------------------------------------------------------------
   GESTURE -> BROWSER ACTIONS
--------------------------------------------------------------- */
let lastScrollSendAt = 0;
let scrollAccum = 0;

let zoomState = { active:false, initialDist:0, initialZoom:1 };
let lastZoomSendAt = 0;

function handleModeHold(hd, gestureName, holdMs, nowMs, onTrigger){
  if(hd.gesture === gestureName){
    if(hd.modeHoldGesture !== gestureName){ hd.modeHoldGesture = gestureName; hd.modeHoldStart = nowMs; hd.modeArmed = true; }
    if(hd.modeArmed && nowMs - hd.modeHoldStart > holdMs){ hd.modeArmed = false; onTrigger(); }
  } else if(hd.modeHoldGesture === gestureName){
    hd.modeHoldGesture = null; hd.modeHoldStart = 0; hd.modeArmed = true;
  }
}

function applyGestures(nowMs){
  // two-hand pinch: zoom
  const bothPinch = hands.Left.present && hands.Right.present &&
    hands.Left.gesture==='pinch' && hands.Right.gesture==='pinch';
  if(bothPinch){
    const pL = { x:hands.Left.pinch.x, y:hands.Left.pinch.y };
    const pR = { x:hands.Right.pinch.x, y:hands.Right.pinch.y };
    const d = Math.hypot(pL.x-pR.x, pL.y-pR.y);
    if(!zoomState.active){
      zoomState = { active:true, initialDist:Math.max(d, 0.03), initialZoom:lastKnownZoom };
    } else if(nowMs - lastZoomSendAt > CFG.ZOOM_SEND_MS){
      lastZoomSendAt = nowMs;
      const factor = clamp(zoomState.initialZoom * (d/zoomState.initialDist), CFG.ZOOM_MIN, CFG.ZOOM_MAX);
      lastKnownZoom = factor;
      zoomInfo.textContent = 'ZOOM ' + Math.round(factor*100) + '%';
      send({ type:'zoom', absolute:true, factor });
    }
  } else {
    zoomState.active = false;
  }

  for(const side of ['Left','Right']){
    const hd = hands[side];
    if(!hd.present) continue;
    if(bothPinch) continue;

    // pinch (single hand): scroll
    if(hd.gesture === 'pinch'){
      scrollAccum += hd.panDY * CFG.SCROLL_SENSITIVITY;
      if(nowMs - lastScrollSendAt > CFG.SCROLL_SEND_MS && Math.abs(scrollAccum) > 0.3){
        lastScrollSendAt = nowMs;
        send({ type:'scroll', dy: scrollAccum });
        scrollAccum = 0;
      }
    }

    // index finger alone: move a visible cursor on the page, armed to register a click
    if(hd.gesture === 'point' && hd.landmarks){
      if(!hd.cursorActive){ hd.cursorActive = true; send({ type:'cursorInit' }); }
      hd.clickArmed = true;
      if(nowMs - hd.lastCursorSendAt > CFG.CURSOR_SEND_MS){
        hd.lastCursorSendAt = nowMs;
        const nx = amplify(mirrorX(hd.landmarks[8].x), CFG.CURSOR_MARGIN);
        const ny = amplify(hd.landmarks[8].y, CFG.CURSOR_MARGIN);
        send({ type:'cursorMove', nx, ny });
      }
    } else if(hd.gesture === 'peace' && hd.cursorActive){
      // peace sign right after pointing: click
      if(hd.clickArmed){
        hd.clickArmed = false;
        send({ type:'cursorClick' });
        showToast('🖱 Click');
      }
    } else if(hd.cursorActive){
      hd.cursorActive = false;
      hd.clickArmed = false;
      send({ type:'cursorRemove' });
    }

    // open palm, swiped fast left/right: back / forward
    if(hd.gesture === 'open'){
      hd.posHistory.push({ x: hd.palm.x, y: hd.palm.y, t: nowMs });
      while(hd.posHistory.length && nowMs - hd.posHistory[0].t > 130) hd.posHistory.shift();
      if(hd.posHistory.length >= 2 && nowMs - hd.lastSwipeAt > CFG.SWIPE_COOLDOWN_MS){
        const a = hd.posHistory[0], b = hd.posHistory[hd.posHistory.length-1];
        const dt = Math.max(16, b.t-a.t);
        const dx = (b.x-a.x) * (video.videoWidth||640);
        const speed = Math.abs(dx) / dt * 100;
        if(speed > CFG.SWIPE_SPEED_MIN){
          hd.lastSwipeAt = nowMs;
          if(dx < 0){ send({ type:'back' }); showToast('⬅ Back'); }
          else { send({ type:'forward' }); showToast('Forward ➡'); }
        }
      }
    } else {
      hd.posHistory = [];
    }

    // thumbs up / down, held: switch tabs
    handleModeHold(hd, 'thumbsUp', CFG.TAB_SWITCH_HOLD_MS, nowMs, () => {
      send({ type:'switchTab', dir:'next' }); showToast('Next tab');
    });
    handleModeHold(hd, 'thumbsDown', CFG.TAB_SWITCH_HOLD_MS, nowMs, () => {
      send({ type:'switchTab', dir:'prev' }); showToast('Previous tab');
    });

    // shaka, held: start voice listening
    handleModeHold(hd, 'shaka', CFG.SHAKA_HOLD_MS, nowMs, () => {
      startListening();
    });
  }
}

/* ---------------------------------------------------------------
   VOICE COMMANDS
--------------------------------------------------------------- */
let voiceState = { listening:false };
let recognition = null;

function getRecognition(){
  const Impl = window.SpeechRecognition || window.webkitSpeechRecognition;
  if(!Impl) return null;
  if(recognition) return recognition;
  recognition = new Impl();
  recognition.lang = 'en-US';
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.onresult = (e) => {
    const transcript = e.results[0][0].transcript.toLowerCase().trim();
    handleVoiceCommand(transcript);
  };
  recognition.onerror = (e) => {
    voiceState.listening = false;
    micIndicator.classList.remove('show');
    if(e.error !== 'no-speech' && e.error !== 'aborted') showToast('🎤 ' + e.error);
  };
  recognition.onend = () => { voiceState.listening = false; micIndicator.classList.remove('show'); };
  return recognition;
}

function startListening(){
  const rec = getRecognition();
  if(!rec){ showToast('🎤 Voice needs Chrome or Edge'); return; }
  if(voiceState.listening) return;
  voiceState.listening = true;
  micIndicator.classList.add('show');
  try{ rec.start(); } catch(e){ voiceState.listening = false; micIndicator.classList.remove('show'); }
  clearTimeout(startListening._t);
  startListening._t = setTimeout(() => { if(voiceState.listening) rec.stop(); }, CFG.VOICE_TIMEOUT_MS);
}

const SITE_SHORTCUTS = {
  google:'google.com', youtube:'youtube.com', gmail:'mail.google.com', amazon:'amazon.com',
  wikipedia:'wikipedia.org', github:'github.com', reddit:'reddit.com', twitter:'twitter.com',
  x:'x.com', facebook:'facebook.com', netflix:'netflix.com', instagram:'instagram.com'
};

function toUrlOrSearch(rawText){
  // speech recognition often transcribes "dot"/"slash" literally when people spell out a URL
  const cleaned = rawText.replace(/\s+dot\s+/gi, '.').replace(/\s+slash\s+/gi, '/').trim();
  if(/^https?:\/\//i.test(cleaned)) return cleaned;

  const singleWord = cleaned.toLowerCase().replace(/[^a-z]/g, '');
  if(SITE_SHORTCUTS[singleWord]) return 'https://' + SITE_SHORTCUTS[singleWord];

  const noSpaces = cleaned.replace(/\s+/g, '');
  const looksLikeDomain = /^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#].*)?$/i.test(noSpaces);
  if(looksLikeDomain) return 'https://' + noSpaces;

  return 'https://www.google.com/search?q=' + encodeURIComponent(cleaned);
}

function handleVoiceCommand(t){
  let m;
  if(/\bback\b/.test(t)){ send({type:'back'}); showToast('🎤 Back'); }
  else if(/\bforward\b/.test(t)){ send({type:'forward'}); showToast('🎤 Forward'); }
  else if(/refresh|reload/.test(t)){ send({type:'refresh'}); showToast('🎤 Refresh'); }
  else if(/new tab/.test(t)){ send({type:'newTab'}); showToast('🎤 New tab'); }
  else if(/close tab/.test(t)){ send({type:'closeTab'}); showToast('🎤 Closed tab'); }
  else if(/next tab/.test(t)){ send({type:'switchTab', dir:'next'}); showToast('🎤 Next tab'); }
  else if(/previous tab|prev tab|last tab/.test(t)){ send({type:'switchTab', dir:'prev'}); showToast('🎤 Previous tab'); }
  else if(/reset zoom/.test(t)){ lastKnownZoom=1; send({type:'zoom', absolute:true, factor:1}); zoomInfo.textContent='ZOOM 100%'; showToast('🎤 Zoom reset'); }
  else if(/zoom in/.test(t)){ const f=clamp(lastKnownZoom*1.25,CFG.ZOOM_MIN,CFG.ZOOM_MAX); lastKnownZoom=f; send({type:'zoom',absolute:true,factor:f}); zoomInfo.textContent='ZOOM '+Math.round(f*100)+'%'; showToast('🎤 Zoom in'); }
  else if(/zoom out/.test(t)){ const f=clamp(lastKnownZoom*0.8,CFG.ZOOM_MIN,CFG.ZOOM_MAX); lastKnownZoom=f; send({type:'zoom',absolute:true,factor:f}); zoomInfo.textContent='ZOOM '+Math.round(f*100)+'%'; showToast('🎤 Zoom out'); }
  else if(/scroll up/.test(t)){ send({type:'scroll', dy:-500}); showToast('🎤 Scroll up'); }
  else if(/scroll down/.test(t)){ send({type:'scroll', dy:500}); showToast('🎤 Scroll down'); }
  else if(/\btop\b/.test(t)){ send({type:'scrollTo', pos:'top'}); showToast('🎤 Top'); }
  else if(/\bbottom\b/.test(t)){ send({type:'scrollTo', pos:'bottom'}); showToast('🎤 Bottom'); }
  else if(m = t.match(/^(?:go to|open|navigate to)\s+(.+)/)){
    const target = m[1].trim();
    const url = toUrlOrSearch(target);
    send({ type:'navigate', url });
    showToast('🎤 Opening ' + target);
  }
  else if(m = t.match(/^(?:search for|google|look up)\s+(.+)/)){
    const query = m[1].trim();
    send({ type:'navigate', url:'https://www.google.com/search?q=' + encodeURIComponent(query) });
    showToast('🎤 Searching "' + query + '"');
  }
  else { showToast('🎤 "' + t + '" — not a command I know'); }
}

/* ---------------------------------------------------------------
   RENDER
--------------------------------------------------------------- */
function updateHandSVG(){
  const w = video.clientWidth || 300, h = video.clientHeight || 225;
  for(const side of ['Left','Right']){
    const hd = hands[side];
    const group = side==='Left' ? svgHandLeft : svgHandRight;
    if(!hd.present || !hd.landmarks){ group.style.opacity=0; continue; }
    group.style.opacity=1;
    const color = GESTURE_COLOR[hd.gesture];
    group.style.setProperty('--hc', color);
    const pts = hd.landmarks.map(p=>({ x:mirrorX(p.x)*w, y:p.y*h }));
    const palmIdx=[0,1,5,9,13,17];
    group.querySelector('.palm').setAttribute('d','M'+palmIdx.map(i=>`${pts[i].x},${pts[i].y}`).join(' L ')+' Z');
    const fingers = { thumb:[0,1,2,3,4], index:[0,5,6,7,8], middle:[0,9,10,11,12], ring:[0,13,14,15,16], pinky:[0,17,18,19,20] };
    for(const [name,idxs] of Object.entries(fingers)){
      group.querySelector('.finger-'+name).setAttribute('d','M'+idxs.map(i=>`${pts[i].x},${pts[i].y}`).join(' L '));
    }
    const tips = group.querySelectorAll('.tip');
    [4,8,12,16,20].forEach((i,k)=>{ tips[k].setAttribute('cx',pts[i].x); tips[k].setAttribute('cy',pts[i].y); });
  }
}

function updateHUD(){
  for(const [side,chip] of [['Left',chipLeft],['Right',chipRight]]){
    const hd=hands[side];
    chip.classList.toggle('on',hd.present);
    if(hd.present){
      chip.querySelector('.dot').style.background = GESTURE_COLOR[hd.gesture];
      chip.querySelector('.dot').style.color = GESTURE_COLOR[hd.gesture];
      chip.querySelector('.g').textContent = GESTURE_LABEL[hd.gesture] || hd.gesture.toUpperCase();
    }
  }
}

let lastFrameTime = performance.now();
let fpsSmoothed = 0;
function loop(){
  const now = performance.now();
  const dt = Math.min(40, now-lastFrameTime);
  lastFrameTime = now;
  if(running){
    trackFrame();
    applyGestures(now);
    updateHandSVG();
    updateHUD();
    const fps = 1000/dt;
    fpsSmoothed = fpsSmoothed ? fpsSmoothed*0.9+fps*0.1 : fps;
    fpsInfo.textContent = 'FPS ' + Math.round(fpsSmoothed);
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

/* ---------------------------------------------------------------
   START
--------------------------------------------------------------- */
startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  statusEl.textContent = 'Loading camera & hand tracking…';
  try{ await initCamera(); await initModel(); }
  catch(e){
    statusEl.textContent = 'Could not start: ' + (e.message||e);
    startBtn.disabled = false;
    return;
  }
  startScreen.classList.add('hidden');
  previewToggle.classList.remove('hidden');
  running = true;
});

previewToggle.addEventListener('click', () => {
  const showing = video.classList.toggle('show');
  previewToggle.textContent = showing ? 'Hide preview' : 'Show preview';
});
