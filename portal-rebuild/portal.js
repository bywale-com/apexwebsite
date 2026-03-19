/* portal.js — Portal Space Systems
   Dependencies loaded before this: Lenis CDN, GSAP, ScrollTrigger
*/

// ── LENIS — smooth scroll, cranked up ─────────────────────────────────────
const lenis = new Lenis({
  duration:        1.8,
  easing:          t => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
  smoothWheel:     true,
  wheelMultiplier: 0.85,
  touchMultiplier: 2.0,
  infinite:        false,
});
function raf(time) { lenis.raf(time); requestAnimationFrame(raf); }
requestAnimationFrame(raf);
window._lenis = lenis;

// ── GSAP + LENIS SYNC ─────────────────────────────────────────────────────
gsap.registerPlugin(ScrollTrigger);
lenis.on('scroll', ScrollTrigger.update);
gsap.ticker.add(t => lenis.raf(t * 1000));
gsap.ticker.lagSmoothing(0);

// ── NAVBAR ────────────────────────────────────────────────────────────────
const navbar     = document.querySelector('.navbar');
const burger     = document.querySelector('.nav-burger');
const mobileMenu = document.querySelector('.nav-mobile-menu');
let lastY = 0, acc = 0;

lenis.on('scroll', ({ scroll: y }) => {
  navbar.classList.toggle('is--scrolled', y > 20);
  if (mobileMenu.classList.contains('is--open')) { lastY = y; return; }
  const delta = y - lastY;
  if (y < 80) { navbar.classList.remove('is--hidden'); acc = 0; }
  else if (delta > 0) { acc += delta; if (acc > 10) navbar.classList.add('is--hidden'); }
  else { acc += delta; if (acc < -8) { navbar.classList.remove('is--hidden'); acc = 0; } }
  lastY = y;
});

if (burger && mobileMenu) {
  burger.addEventListener('click', () => {
    const open = mobileMenu.classList.contains('is--open');
    mobileMenu.classList.toggle('is--open', !open);
    burger.classList.toggle('is--open', !open);
    open ? lenis.start() : lenis.stop();
  });
  document.querySelectorAll('.nav-mobile-link').forEach(l =>
    l.addEventListener('click', () => {
      mobileMenu.classList.remove('is--open');
      burger.classList.remove('is--open');
      lenis.start();
    })
  );
  document.addEventListener('click', e => {
    if (mobileMenu.classList.contains('is--open') &&
        !mobileMenu.contains(e.target) && !burger.contains(e.target)) {
      mobileMenu.classList.remove('is--open');
      burger.classList.remove('is--open');
      lenis.start();
    }
  });
}

// ── LOGO ROTATION ON HOVER ────────────────────────────────────────────────
const logoSvg      = document.getElementById('portalLogo');
const rotatingPath = document.getElementById('rotatingPath');
if (logoSvg && rotatingPath) {
  const bb = rotatingPath.getBBox();
  const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
  let angle = 0, rotating = false, easing = false;
  let easeStart = 0, easeEnd = 0, easeT0 = 0;
  const SPEED = 0.04, DUR = 600;
  const easeOut = t => 1 - Math.pow(1 - t, 3);
  function tick() {
    if (rotating) {
      angle += SPEED;
      rotatingPath.setAttribute('transform', `rotate(${angle * 180 / Math.PI} ${cx} ${cy})`);
      requestAnimationFrame(tick);
    } else if (easing) {
      const t = Math.min(1, (performance.now() - easeT0) / DUR);
      const cur = easeStart + (easeEnd - easeStart) * easeOut(t);
      rotatingPath.setAttribute('transform', `rotate(${cur * 180 / Math.PI} ${cx} ${cy})`);
      if (t < 1) requestAnimationFrame(tick);
      else { angle = 0; rotatingPath.setAttribute('transform', ''); easing = false; }
    }
  }
  logoSvg.addEventListener('mouseenter', () => {
    if (!rotating && !easing) { rotating = true; requestAnimationFrame(tick); }
  });
  logoSvg.addEventListener('mouseleave', () => {
    if (rotating) {
      rotating = false; easing = true; easeStart = angle;
      easeEnd = Math.ceil(angle / (2 * Math.PI)) * 2 * Math.PI;
      easeT0 = performance.now(); requestAnimationFrame(tick);
    }
  });
}

// ── HERO ENTRANCE ─────────────────────────────────────────────────────────
gsap.from('.hero-headline',  { y: 50, opacity: 0, duration: 1.4, ease: 'power3.out', delay: 0.15 });
gsap.from('.hero-learn-more',{ y: 20, opacity: 0, duration: 1.0, ease: 'power3.out', delay: 0.40 });
gsap.from('.hero-news-card', { y: 40, opacity: 0, duration: 1.0, ease: 'power3.out', delay: 0.65 });

// ── SECTION 2 — WORD REVEAL ───────────────────────────────────────────────
const introSection  = document.querySelector('.intro-section');
const introWords    = document.querySelectorAll('.intro-words .word');
const overlayInner  = document.querySelector('.intro-overlay-inner');

if (introWords.length && introSection) {
  gsap.to(introWords, {
    color: 'rgba(5,5,5,1)',
    stagger: { each: 0.032, from: 'start' },
    ease: 'none',
    scrollTrigger: {
      trigger: introSection,
      start: 'top top',
      end: '52% top',
      scrub: 1.4,
    }
  });
}

// Full-vh clip-path reveal — sweeps from bottom all the way to top
if (overlayInner && introSection) {
  ScrollTrigger.create({
    trigger: introSection,
    start: '40% top',
    end: '80% top',
    scrub: 1.2,
    onUpdate(self) {
      const pct = Math.round((1 - self.progress) * 100);
      overlayInner.style.clipPath = `inset(${pct}% 0 0 0)`;
    }
  });
}

// ── SECTION 3 — MISSION WORD REVEAL ──────────────────────────────────────
const missionSection = document.querySelector('.mission-section');
const missionWords   = document.querySelectorAll('.mission-words .word');
if (missionWords.length && missionSection) {
  gsap.to(missionWords, {
    color: 'rgba(5,5,5,1)',
    stagger: { each: 0.06, from: 'start' },
    ease: 'none',
    scrollTrigger: {
      trigger: missionSection, start: 'top 70%', end: 'top 20%', scrub: 1.5,
    }
  });
  gsap.fromTo('.mission-left .p-m',
    { opacity: 0, y: 16 },
    { opacity: 1, y: 0,
      scrollTrigger: { trigger: missionSection, start: '15% 70%', end: '30% 50%', scrub: 1 }
    }
  );
}
document.querySelectorAll('.mission-card').forEach(card => {
  gsap.fromTo(card, { opacity: 0, y: 50 }, { opacity: 1, y: 0, duration: 0.8, ease: 'power2.out',
    scrollTrigger: { trigger: card, start: 'top 85%', toggleActions: 'play none none reverse' }
  });
});

// ── SECTION 4 — STP SCROLL-DRIVEN STICKY TABS ────────────────────────────
// Layout: section is 400vh. Inner sticky wrapper is 100vh.
// As user scrolls, progress (0→1) maps to 3 tabs.
// Left side: tab opens (max-height accordion).
// Right side: corresponding panel sweeps up via clip-path.
const stpSection = document.querySelector('.stp-section');
const stpTabs    = document.querySelectorAll('.stp-tab-item');
const stpPanels  = document.querySelectorAll('.stp-panel');

if (stpSection && stpTabs.length) {
  const N = stpTabs.length; // 3
  let currentIdx = 0;

  // Init first tab open
  stpTabs[0].classList.add('is--active');
  if (stpPanels[0]) stpPanels[0].style.clipPath = 'inset(0% 0 0 0)';

  function setTab(idx) {
    if (idx === currentIdx) return;
    stpTabs[currentIdx].classList.remove('is--active');
    stpTabs[idx].classList.add('is--active');
    currentIdx = idx;
  }

  ScrollTrigger.create({
    trigger: stpSection,
    start: 'top top',
    end: 'bottom bottom',
    scrub: 1.2,
    onUpdate(self) {
      const p = self.progress;

      // Which tab are we in?
      const rawIdx = Math.floor(p * N);
      setTab(Math.min(rawIdx, N - 1));

      // Animate each panel — sweep up from bottom, same feel as Supernova reveal
      stpPanels.forEach((panel, i) => {
        if (i === 0) {
          panel.style.clipPath = 'inset(0% 0 0 0)';
          return;
        }
        // Each panel starts revealing just before its tab switch point
        // and completes quickly (tight window = snappy feel)
        const switchPoint = i / N;          // 0.33, 0.66
        const revealStart = switchPoint - 0.04;
        const revealEnd   = switchPoint + 0.06;
        const local = (p - revealStart) / (revealEnd - revealStart);
        const clamped = Math.max(0, Math.min(1, local));
        const hiddenPct = Math.round((1 - clamped) * 100);
        panel.style.clipPath = `inset(${hiddenPct}% 0 0 0)`;
      });
    }
  });
}

// ── SECTION 5 — CAPABILITIES TABS (click) ─────────────────────────────────
const capTabs = document.querySelectorAll('.tab-item-white');
if (capTabs.length) {
  capTabs[0].classList.add('is--active');
  capTabs.forEach(tab => {
    tab.querySelector('.h4').addEventListener('click', () => {
      capTabs.forEach(t => t.classList.remove('is--active'));
      tab.classList.add('is--active');
    });
  });
}

// ── GENERAL FADE-UPS ──────────────────────────────────────────────────────
['.team-intro', '.facility-stat', '.stp-header'].forEach(sel => {
  const el = document.querySelector(sel);
  if (el) gsap.fromTo(el, { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 1, ease: 'power2.out',
    scrollTrigger: { trigger: el, start: 'top 80%', toggleActions: 'play none none reverse' }
  });
});
document.querySelectorAll('.roadmap-item').forEach((el, i) => {
  gsap.fromTo(el, { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.7, ease: 'power2.out', delay: i * 0.08,
    scrollTrigger: { trigger: el, start: 'top 85%', toggleActions: 'play none none reverse' }
  });
});
document.querySelectorAll('.news-card').forEach((el, i) => {
  gsap.fromTo(el, { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.7, ease: 'power2.out', delay: i * 0.1,
    scrollTrigger: { trigger: el, start: 'top 85%', toggleActions: 'play none none reverse' }
  });
});
document.querySelectorAll('.career-item').forEach((el, i) => {
  gsap.fromTo(el, { opacity: 0, x: -20 }, { opacity: 1, x: 0, duration: 0.6, ease: 'power2.out', delay: i * 0.08,
    scrollTrigger: { trigger: el, start: 'top 88%', toggleActions: 'play none none reverse' }
  });
});
document.querySelectorAll('.cta-inner .h1, .cta-inner .p-l').forEach((el, i) => {
  gsap.fromTo(el, { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 1, ease: 'power2.out', delay: i * 0.15,
    scrollTrigger: { trigger: el, start: 'top 80%', toggleActions: 'play none none reverse' }
  });
});
