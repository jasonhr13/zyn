// Device persona + human-behaviour simulation for the Shape harvester.
//
// WHY THIS EXISTS: Shape is a behavioural antibot. It runs a VM in the page that watches pointer
// paths, timing, typing rhythm and ~40 environment surfaces, and it decides how much of a signature
// to emit based on what it sees. A page that loads, sits perfectly still, and then teleports a
// click onto a button is the clearest possible bot signal — and the observed symptom of failing that
// check is not an error, it is a *short* signature (our harvests came back missing x-gyjwza5z-a0),
// a queue that never clears, or the "Something went wrong" interstitial.
//
// DELIBERATELY NOT A COPY. Two harvesters that move a mouse the same way are one fingerprint, so
// matching a known implementation step-for-step would make us MORE identifiable, not less. Instead:
//   • the pre-interaction routine is drawn from a pool and SHUFFLED per session, so no two harvests
//     perform the same actions in the same order;
//   • paths are cubic Bézier with per-session curvature and jitter, not a fixed easing;
//   • it includes idling, reading pauses, overshoot-and-correct, text selection, tab-visibility
//     changes and aimless hovers — signals a straight-line "move then click" driver never produces;
//   • every persona value is randomised but INTERNALLY CONSISTENT (a Windows UA never reports a Mac
//     platform, a desktop never reports touch points), because a contradictory environment is a
//     louder tell than a boring one.

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const randInt = (lo, hi) => Math.floor(rand(lo, hi + 1));

// Fisher-Yates. Used to reorder the warm-up so the action sequence differs every session.
function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Real-world-ish desktop configurations. Grouped so the GPU string matches the vendor and the
// screen matches the class of machine — mixing a workstation GPU with a netbook screen is exactly
// the kind of inconsistency a fingerprinter scores against you.
const DEVICES = [
  {
    platform: 'Win32', chromeOn: 'Windows', uaPlatform: '"Windows"', uaPlatformVersion: '"15.0.0"',
    screens: [[1920, 1080], [2560, 1440], [1920, 1200], [3840, 2160]],
    gpus: [
      ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
      ['Google Inc. (Intel)', 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
      ['Google Inc. (AMD)', 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
    ],
    cores: [8, 12, 16, 24], memory: [8, 16, 32],
  },
  {
    platform: 'MacIntel', chromeOn: 'macOS', uaPlatform: '"macOS"', uaPlatformVersion: '"14.5.0"',
    screens: [[1728, 1117], [1512, 982], [2560, 1440], [1920, 1080]],
    gpus: [
      ['Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)'],
      ['Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)'],
    ],
    cores: [8, 10, 12], memory: [8, 16, 32],
  },
];

// One coherent machine. Held for the whole browser session — a persona that changes mid-session is
// itself a signal.
export function makePersona() {
  const d = pick(DEVICES);
  const [sw, sh] = pick(d.screens);
  const [glVendor, glRenderer] = pick(d.gpus);
  const major = pick([147, 148, 149]);
  const build = `${major}.0.${randInt(6000, 7900)}.${randInt(50, 190)}`;

  // Viewport is the screen minus real browser chrome, not a round number. Perfectly round viewports
  // that exactly equal the screen are a headless giveaway.
  const viewport = {
    width: Math.max(1024, sw - randInt(0, 120)),
    height: Math.max(700, sh - randInt(120, 220)),
  };

  return {
    platform: d.platform,
    uaPlatform: d.uaPlatform,
    uaPlatformVersion: d.uaPlatformVersion,
    userAgent: `Mozilla/5.0 (${d.platform === 'Win32' ? 'Windows NT 10.0; Win64; x64' : 'Macintosh; Intel Mac OS X 10_15_7'}) `
      + `AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${build} Safari/537.36`,
    uaFullVersion: build,
    majorVersion: major,
    screen: { width: sw, height: sh },
    viewport,
    cores: pick(d.cores),
    memory: pick(d.memory),
    glVendor,
    glRenderer,
    // Per-session, so canvas/audio readbacks are stable within a session and differ between them.
    // A canvas hash that changes on every read is as suspicious as one that matches a known bot.
    noiseSeed: Math.floor(Math.random() * 1e9),
    timezone: pick(['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles']),
    locale: 'en-US',
  };
}

// Runs before any page script. Everything here has to agree with the persona and with the real
// launch options (viewport, UA, timezone) — see makeContextOptions.
export function personaInitScript(p) {
  return `(function(){
  function def(o,n,v){try{Object.defineProperty(o,n,{get:function(){return v;},configurable:true});}catch(e){}}
  var nav=Object.getPrototypeOf(navigator)||Navigator.prototype;

  // webdriver — the single loudest automation tell.
  try{Object.defineProperty(Navigator.prototype,'webdriver',{get:function(){return undefined;},configurable:true});}catch(e){}
  try{delete navigator.__proto__.webdriver;}catch(e){}

  def(nav,'platform','${p.platform}');def(navigator,'platform','${p.platform}');
  def(nav,'hardwareConcurrency',${p.cores});def(navigator,'hardwareConcurrency',${p.cores});
  def(nav,'deviceMemory',${p.memory});def(navigator,'deviceMemory',${p.memory});
  def(navigator,'languages',['en-US','en']);
  // Desktop personas must report zero touch points. Reporting touch on a desktop UA is contradictory.
  def(nav,'maxTouchPoints',0);def(navigator,'maxTouchPoints',0);

  // Screen metrics must match the persona, and availHeight must be less than height (taskbar/dock).
  try{
    def(screen,'width',${p.screen.width});def(screen,'height',${p.screen.height});
    def(screen,'availWidth',${p.screen.width});def(screen,'availHeight',${p.screen.height - 40});
    def(screen,'colorDepth',24);def(screen,'pixelDepth',24);
  }catch(e){}

  // navigator.plugins / mimeTypes — empty lists are a headless signature.
  var pl=[{name:'PDF Viewer'},{name:'Chrome PDF Viewer'},{name:'Chromium PDF Viewer'},
          {name:'Microsoft Edge PDF Viewer'},{name:'WebKit built-in PDF'}];
  def(navigator,'plugins',pl);def(navigator,'mimeTypes',[{type:'application/pdf'},{type:'text/pdf'}]);

  if(!window.chrome){window.chrome={runtime:{},loadTimes:function(){},csi:function(){},app:{isInstalled:false}};}

  try{var q=navigator.permissions&&navigator.permissions.query;if(q){navigator.permissions.query=function(x){
    return x&&x.name==='notifications'?Promise.resolve({state:Notification.permission}):q.call(navigator.permissions,x);};}}catch(e){}

  // userAgentData must agree with the UA string we set on the context.
  try{
    var brands=[{brand:'Chromium',version:'${p.majorVersion}'},
                {brand:'Google Chrome',version:'${p.majorVersion}'},
                {brand:'Not)A;Brand',version:'24'}];
    def(navigator,'userAgentData',{
      brands:brands, mobile:false, platform:${p.uaPlatform},
      getHighEntropyValues:function(){return Promise.resolve({
        architecture:'x86', bitness:'64', brands:brands, mobile:false,
        model:'', platform:${p.uaPlatform}, platformVersion:${p.uaPlatformVersion},
        uaFullVersion:'${p.uaFullVersion}'});}
    });
  }catch(e){}

  try{var gp=WebGLRenderingContext.prototype.getParameter;
    function patchGL(proto){var g=proto.getParameter;proto.getParameter=function(pn){
      if(pn===37445)return '${p.glVendor}';
      if(pn===37446)return '${p.glRenderer}';
      return g.call(this,pn);};}
    patchGL(WebGLRenderingContext.prototype);
    if(window.WebGL2RenderingContext)patchGL(WebGL2RenderingContext.prototype);
  }catch(e){}

  // Canvas + audio: a DETERMINISTIC per-session perturbation. Not random per call — a readback that
  // differs every time is as detectable as one that matches a known bot. Seeded so this session
  // looks like one consistent machine and the next looks like a different one.
  // A FRESH generator seeded identically on every call — not one running stream. With a running
  // stream the same canvas hashes differently each time it is read, and a fingerprint that changes
  // between two reads in one session is a louder signal than any fixed value. Reseeding makes the
  // perturbation a pure function of (session, pixel index): stable within a session, different
  // between sessions.
  function mkRnd(s){return function(){s=(s*1664525+1013904223)>>>0;return s/4294967296;};}
  var SEED=${p.noiseSeed};
  try{
    var toDataURL=HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL=function(){
      try{var ctx=this.getContext('2d');
        if(ctx&&this.width>1&&this.height>1){
          var rnd=mkRnd(SEED);
          var d=ctx.getImageData(0,0,this.width,this.height);
          for(var i=0;i<d.data.length;i+=4){if(rnd()<0.002){d.data[i]=(d.data[i]+1)&255;}}
          ctx.putImageData(d,0,0);}
      }catch(e){}
      return toDataURL.apply(this,arguments);};
  }catch(e){}
  try{
    var gcd=AnalyserNode.prototype.getFloatFrequencyData;
    AnalyserNode.prototype.getFloatFrequencyData=function(arr){
      gcd.call(this,arr);
      var rnd=mkRnd(SEED);
      for(var i=0;i<arr.length;i++){arr[i]=arr[i]+(rnd()-0.5)*0.0002;}
      return arr;};
  }catch(e){}

  // mediaDevices — a bare headless/datacenter Chromium with no audio hardware returns an EMPTY
  // device list, which is a clear tell against a real desktop. Report a plausible mic+speaker set
  // with the correct kinds but EMPTY labels — real browsers only populate labels after a
  // getUserMedia permission grant, so populated labels here would be a louder signal than the empty
  // list we are fixing. deviceId/groupId are derived from the session SEED so the set is stable
  // within a session and differs between sessions, matching the canvas/audio perturbation model.
  // No videoinput is reported: most desktops have no webcam, and claiming one we can never open is
  // an inconsistency a sensor can probe via getUserMedia.
  try{
    var mkId=function(tag){var s=(SEED^tag)>>>0,o='';for(var i=0;i<16;i++){s=(s*1664525+1013904223)>>>0;o+=(s&15).toString(16);}return o;};
    var grp=mkId(0x9e37);
    var devs=[
      {deviceId:'default',       kind:'audioinput',  label:'', groupId:grp},
      {deviceId:mkId(1),         kind:'audioinput',  label:'', groupId:grp},
      {deviceId:'default',       kind:'audiooutput', label:'', groupId:grp},
      {deviceId:'communications',kind:'audiooutput', label:'', groupId:grp},
      {deviceId:mkId(2),         kind:'audiooutput', label:'', groupId:grp}
    ];
    if(navigator.mediaDevices){
      navigator.mediaDevices.enumerateDevices=function(){return Promise.resolve(devs.map(function(d){
        var proto=(typeof MediaDeviceInfo!=='undefined')?MediaDeviceInfo.prototype:Object.prototype;
        return Object.assign(Object.create(proto),d,{toJSON:function(){return d;}});
      }));};
      if(!navigator.mediaDevices.getSupportedConstraints){
        navigator.mediaDevices.getSupportedConstraints=function(){return {deviceId:true,groupId:true,echoCancellation:true,noiseSuppression:true,autoGainControl:true,sampleRate:true,sampleSize:true,channelCount:true,latency:true};};
      }
    }
  }catch(e){}

  try{def(navigator,'connection',{effectiveType:'4g',rtt:${randInt(40, 120)},downlink:${(rand(5, 15)).toFixed(1)},saveData:false});}catch(e){}
})();`;
}

// Context options that must agree with the persona. Setting the UA here (rather than only in the
// init script) keeps the HTTP header and the JS value identical — a mismatch between them is a
// trivial check for any antibot.
export function makeContextOptions(p) {
  return {
    userAgent: p.userAgent,
    viewport: p.viewport,
    screen: p.screen,
    locale: p.locale,
    timezoneId: p.timezone,
    deviceScaleFactor: 1,
    hasTouch: false,
    isMobile: false,
  };
}

// ── behaviour ────────────────────────────────────────────────────────────────────────
// Cubic Bézier between two points with per-call curvature. Real pointers arc; they do not
// interpolate linearly, and they do not arrive in a fixed number of equal steps.
function bezierPath(from, to, steps, curve) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  // Control points pushed perpendicular to the direction of travel, by a fraction of the distance.
  const nx = -dy / dist, ny = dx / dist;
  const c1 = { x: from.x + dx * 0.3 + nx * curve * dist, y: from.y + dy * 0.3 + ny * curve * dist };
  const c2 = { x: from.x + dx * 0.7 + nx * curve * dist * 0.6, y: from.y + dy * 0.7 + ny * curve * dist * 0.6 };
  const pts = [];
  for (let i = 1; i <= steps; i++) {
    // Ease-in-out: pointers accelerate away and decelerate onto a target.
    const t0 = i / steps;
    const t = t0 < 0.5 ? 2 * t0 * t0 : 1 - Math.pow(-2 * t0 + 2, 2) / 2;
    const u = 1 - t;
    pts.push({
      x: u * u * u * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * to.x,
      y: u * u * u * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * to.y,
    });
  }
  return pts;
}

export function createHuman(page, persona) {
  const vw = persona.viewport.width, vh = persona.viewport.height;
  let at = { x: rand(vw * 0.3, vw * 0.7), y: rand(vh * 0.3, vh * 0.7) };
  const wait = (ms) => page.waitForTimeout(Math.max(0, Math.round(ms)));

  // Move along a curve, occasionally overshooting and correcting the way a real hand does when it
  // is moving quickly toward a target.
  async function moveTo(x, y, { overshoot = Math.random() < 0.25 } = {}) {
    const dist = Math.hypot(x - at.x, y - at.y);
    const steps = Math.max(8, Math.min(60, Math.round(dist / rand(8, 22))));
    const curve = rand(-0.28, 0.28);
    let target = { x, y };
    if (overshoot && dist > 120) {
      const k = rand(1.03, 1.12);
      target = { x: at.x + (x - at.x) * k, y: at.y + (y - at.y) * k };
    }
    for (const pt of bezierPath(at, target, steps, curve)) {
      await page.mouse.move(pt.x, pt.y).catch(() => {});
      if (Math.random() < 0.12) await wait(rand(4, 18));   // micro-hesitation
    }
    at = target;
    if (overshoot && dist > 120) {
      await wait(rand(40, 120));                            // notice the overshoot…
      for (const pt of bezierPath(at, { x, y }, randInt(5, 12), rand(-0.1, 0.1))) {
        await page.mouse.move(pt.x, pt.y).catch(() => {});
      }
      at = { x, y };
    }
  }

  async function moveToElement(el) {
    // boundingBox() does NOT scroll, and returns viewport coordinates — a control below the fold gives
    // a y past the viewport, where the press lands on nothing at all.
    await el.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    const box = await el.boundingBox().catch(() => null);
    if (!box) return false;
    // Land somewhere inside the element, biased to the middle but never dead centre — pixel-perfect
    // centre hits are a driver signature.
    await moveTo(box.x + box.width * rand(0.3, 0.7), box.y + box.height * rand(0.3, 0.7));
    await wait(rand(60, 220));
    return true;
  }

  // Does the pointer's current position actually sit over `el` (or something inside it)?
  //
  // This is the difference between a human click and a coordinate press. Reading a box, tracing a
  // Bézier path to it and pausing takes the better part of a second, and a Target PDP re-lays itself
  // out the whole time — deferred_enrichment injects modules underneath the fold and everything below
  // shifts. By the time the button goes down, those coordinates can be over something else entirely,
  // and mouse.down/up never complains: it presses whatever is there now. Observed live as harvests
  // "clicking add-to-cart" and landing on the footer Terms & Conditions link and a marketplace seller
  // page. A real cursor cannot suffer this, because a real user aims at what they currently see.
  async function pointerIsOver(el) {
    try {
      return await el.evaluate((node, p) => {
        const hit = document.elementFromPoint(p.x, p.y);
        return !!hit && (hit === node || node.contains(hit) || hit.contains(node));
      }, { x: at.x, y: at.y });
    } catch { return false; }
  }

  // ── the action pool ───────────────────────────────────────────────────────────────
  // Drawn from and SHUFFLED per session, so the warm-up is never the same sequence twice.
  const actions = {
    async drift() {                        // aimless movement, no target
      for (let i = 0; i < randInt(2, 4); i++) {
        await moveTo(rand(vw * 0.1, vw * 0.9), rand(vh * 0.15, vh * 0.85), { overshoot: false });
        await wait(rand(80, 400));
      }
    },
    async readScroll() {                   // scroll down in uneven bursts, with reading pauses
      for (let i = 0; i < randInt(2, 5); i++) {
        await page.mouse.wheel(0, rand(180, 620)).catch(() => {});
        await wait(rand(250, 1100));
      }
    },
    async scrollBack() {                   // people overshoot and scroll back up
      await page.mouse.wheel(0, -rand(120, 420)).catch(() => {});
      await wait(rand(200, 700));
    },
    async hoverSomething() {               // hover a random visible element, as if considering it
      try {
        const els = await page.$$('a, button, img, [role="button"]');
        if (!els.length) return;
        await moveToElement(els[Math.floor(Math.random() * els.length)]);
        await wait(rand(150, 600));
      } catch {}
    },
    async selectText() {                   // double-click a heading — a very human, very idle act
      try {
        const el = await page.$('h1, h2, p');
        if (!el) return;
        if (!(await moveToElement(el))) return;
        await page.mouse.down().catch(() => {});
        await wait(rand(40, 110));
        await page.mouse.up().catch(() => {});
      } catch {}
    },
    async idle() {                         // simply stop for a moment
      await wait(rand(400, 1600));
    },
    async jitter() {                       // tiny corrections while "holding" the mouse still
      for (let i = 0; i < randInt(3, 7); i++) {
        await page.mouse.move(at.x + rand(-3, 3), at.y + rand(-3, 3)).catch(() => {});
        await wait(rand(30, 130));
      }
    },
    async tabAway() {                      // blur/focus — a real user glances at another window
      try {
        await page.evaluate(() => {
          document.dispatchEvent(new Event('visibilitychange'));
          window.dispatchEvent(new Event('blur'));
        });
        await wait(rand(300, 1200));
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      } catch {}
    },
  };

  return {
    moveTo,
    moveToElement,
    wait,
    // Run a randomly-ordered, randomly-sized subset. Never the same routine twice.
    async warmUp(count = randInt(3, 6)) {
      const order = shuffle(Object.keys(actions)).slice(0, count);
      for (const name of order) {
        await actions[name]();
      }
      return order;
    },
    // Approach and click properly: move onto the element, pause as if confirming, then press with a
    // realistic hold. Falls back to a plain click if the element has no box.
    async click(selector, { timeout = 4000 } = {}) {
      const el = await page.$(selector).catch(() => null);
      if (!el) return false;
      if (await moveToElement(el)) {
        await wait(rand(80, 300));
        // Confirm the pointer is still over the target before committing. If the layout moved under
        // us, re-aim once — a human whose button just shifted looks at where it went and follows it.
        if (!(await pointerIsOver(el))) {
          await moveToElement(el);
          await wait(rand(60, 180));
        }
        // Still not over it? Hand off to page.click(), which re-resolves the selector, waits for the
        // element to be stable and hit-testable, and throws instead of pressing the wrong thing.
        // Pressing here anyway is what navigated harvests to Terms & Conditions and reported success.
        if (await pointerIsOver(el)) {
          await page.mouse.down().catch(() => {});
          await wait(rand(45, 130));        // human click hold, not an instantaneous down/up
          await page.mouse.up().catch(() => {});
          return true;
        }
      }
      try { await page.click(selector, { timeout }); return true; } catch { return false; }
    },
    // Typing with variable rhythm, thinking pauses, and the occasional typo it then corrects.
    async type(selector, text) {
      const ok = await this.click(selector).catch(() => false);
      if (!ok) { try { await page.focus(selector); } catch { return false; } }
      for (const ch of String(text)) {
        if (Math.random() < 0.03) {         // typo, noticed, fixed
          await page.keyboard.type(pick('abcdefghijklmnopqrstuvwxyz'.split('')));
          await wait(rand(120, 320));
          await page.keyboard.press('Backspace');
          await wait(rand(90, 240));
        }
        await page.keyboard.type(ch);
        await wait(rand(45, 190));
        if (Math.random() < 0.06) await wait(rand(250, 900));   // thinking pause
      }
      return true;
    },
  };
}
