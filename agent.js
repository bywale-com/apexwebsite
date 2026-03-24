// ── CONTEXT CAPTURE ───────────────────────────────────────
// Runs on page load. Captures everything passively available.

function safeReferrerHostname(referrer) {
  if (!referrer) return null;
  try {
    return new URL(referrer).hostname.replace('www.', '');
  } catch {
    return null;
  }
}

const agentContext = {
  referrer: document.referrer || null,
  referrerDomain: safeReferrerHostname(document.referrer),

  utm: {
    source: new URLSearchParams(window.location.search).get('utm_source'),
    medium: new URLSearchParams(window.location.search).get('utm_medium'),
    campaign: new URLSearchParams(window.location.search).get('utm_campaign'),
    content: new URLSearchParams(window.location.search).get('utm_content'),
  },

  device: /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : 'desktop',
  language: navigator.language || null,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,

  localHour: new Date().getHours(),
  dayOfWeek: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date().getDay()],
  timeOfDay:
    new Date().getHours() < 12
      ? 'morning'
      : new Date().getHours() < 17
        ? 'afternoon'
        : new Date().getHours() < 21
          ? 'evening'
          : 'night',

  returning: localStorage.getItem('wt6_visited') === 'true',
  visitCount: parseInt(localStorage.getItem('wt6_visit_count') || '0', 10) + 1,

  scrollDepthAtOpen: null,
  timeOnPageAtOpen: null,
  sectionsViewed: [],

  visitor: {
    name: null,
    email: null,
    business: null,
    intent: null,
    qualified: false,
  },
};

localStorage.setItem('wt6_visited', 'true');
localStorage.setItem('wt6_visit_count', agentContext.visitCount.toString());

function getScrollDepth() {
  const el = document.documentElement;
  const top = el.scrollTop || document.body.scrollTop;
  const height = el.scrollHeight - el.clientHeight;
  return height > 0 ? Math.round((top / height) * 100) : 0;
}

const pageLoadTime = Date.now();
function getTimeOnPage() {
  return Math.round((Date.now() - pageLoadTime) / 1000);
}

/**
 * Fired when the visitor does something worth telling the model about.
 * (Context is already in agentContext; this triggers a proactive reply when the panel is open.)
 */
function emitVisitorBehavior(description) {
  if (typeof description !== 'string' || !description.trim()) return;
  window.dispatchEvent(
    new CustomEvent('wt6-visitor-behavior', {
      detail: { description: description.trim() },
    })
  );
}

const sectionObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        const tag = entry.target.getAttribute('data-agent');
        if (tag && !agentContext.sectionsViewed.includes(tag)) {
          agentContext.sectionsViewed.push(tag);
          if (window.__wt6AgentPanelOpen) {
            emitVisitorBehavior(
              `They scrolled until the "${tag}" section entered view (about 30% visible). They have not typed a new message — this is movement on the page.`
            );
          }
        }
      }
    });
  },
  { threshold: 0.3 }
);

document.querySelectorAll('[data-agent]').forEach((el) => {
  sectionObserver.observe(el);
});

/** Scroll depth milestones while chat is open → proactive nudges */
const wt6ScrollMilestonesHit = new Set();
let wt6ScrollRaf = null;
window.addEventListener(
  'scroll',
  () => {
    if (!window.__wt6AgentPanelOpen) return;
    if (wt6ScrollRaf) return;
    wt6ScrollRaf = requestAnimationFrame(() => {
      wt6ScrollRaf = null;
      const d = getScrollDepth();
      let highestNew = null;
      for (const m of [35, 55, 75]) {
        if (d >= m && !wt6ScrollMilestonesHit.has(m)) {
          wt6ScrollMilestonesHit.add(m);
          highestNew = m;
        }
      }
      if (highestNew != null) {
        emitVisitorBehavior(
          `They kept scrolling; approximate page depth is now about ${d}% (crossed ${highestNew}% while chat was open). They have not sent a new message.`
        );
      }
    });
  },
  { passive: true }
);

function captureOpenContext() {
  agentContext.scrollDepthAtOpen = getScrollDepth();
  agentContext.timeOnPageAtOpen = getTimeOnPage();
}

/**
 * Section slugs for reveal_section / highlight_cta targets.
 * Must match `data-agent="..."` on the page (e.g. portal.html).
 */
const AGENT_SECTION_TARGETS = Object.freeze([
  'hero',
  'intro',
  'how-it-works',
  'contact-cta',
]);

function isValidAgentTarget(target) {
  return typeof target === 'string' && AGENT_SECTION_TARGETS.includes(target);
}

/** Refresh fields sent to the model on every /api/chat call */
function snapshotAgentContextForPrompt() {
  agentContext.pagePath = window.location.pathname || '/';
  agentContext.scrollDepthNow = getScrollDepth();
  agentContext.timeOnPageNow = getTimeOnPage();
  agentContext.hasSeenHero = agentContext.sectionsViewed.includes('hero');
  agentContext.hasSeenIntro = agentContext.sectionsViewed.includes('intro');
  agentContext.hasSeenHowItWorks =
    agentContext.sectionsViewed.includes('how-it-works');
  agentContext.hasSeenContactCta =
    agentContext.sectionsViewed.includes('contact-cta');
}

window.agentContext = agentContext;

// ── AGENT UI + OPENAI (via /api/chat) ─────────────────────

const bubble = document.getElementById('agent-bubble');
const panel = document.getElementById('agent-panel');
const closeBtn = document.getElementById('agent-close');
const feed = document.getElementById('agent-feed');
const input = document.getElementById('agent-input');
const sendBtn = document.getElementById('agent-send');

if (!bubble || !panel || !closeBtn || !feed || !input || !sendBtn) {
  // Markup missing
} else {
  let isOpen = false;
  let hasOpened = false;

  const conversationHistory = [];

  /** Live pitch demo: scripted panel + scroll question; skips LLM first open */
  const WT6_DEMO_SCRIPT = true;
  const DEMO_SCROLL_QUESTION_DELAY_MS = 7000;
  const DEMO_PANEL_OPEN_DELAY_MS = 1800;

  let demoScrollQuestionScheduled = false;
  let demoScrollQuestionTimeoutId = null;
  let demoScrollQuestionVisible = false;
  let demoAwaitingMicClick = false;
  let demoMicResolver = null;
  let demoScriptRunning = false;
  let demoScriptComplete = false;

  /** Panel open — used by scroll/section trackers (defined before open/close). */
  window.__wt6AgentPanelOpen = false;

  // ── Proactive follow-ups (behavior → /api/chat without visitor typing) ──
  let proactiveReady = false;
  let proactiveChatInFlight = false;
  let proactiveCooldownUntil = 0;
  let proactiveNudgeCount = 0;
  const PROACTIVE_COOLDOWN_MS = 24000;
  const MAX_PROACTIVE_NUDGES = 16;
  let idleTimer = null;
  const IDLE_NUDGE_MS = 40000;

  function isLiveTyping() {
    return (
      !!document.getElementById('typing-indicator') ||
      !!feed.querySelector('.agent-message.is--typing-live')
    );
  }

  function canAcceptProactiveTurn() {
    if (WT6_DEMO_SCRIPT && !demoScriptComplete) return false;
    if (!proactiveReady || !hasOpened || !isOpen) return false;
    if (!window.__wt6AgentPanelOpen) return false;
    if (proactiveChatInFlight) return false;
    if (Date.now() < proactiveCooldownUntil) return false;
    if (proactiveNudgeCount >= MAX_PROACTIVE_NUDGES) return false;
    if (isLiveTyping()) return false;
    return true;
  }

  function clearIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  function bumpIdleTimer() {
    clearIdleTimer();
    if (!proactiveReady || !isOpen) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      proactiveNudge(
        'Visitor has had the chat open for a while with no new message from them since your last reply (idle nudge).'
      );
    }, IDLE_NUDGE_MS);
  }

  function enableProactiveFollowUps() {
    if (proactiveReady) return;
    proactiveReady = true;
    setTimeout(() => bumpIdleTimer(), 800);
  }

  async function proactiveNudge(behaviorDescription) {
    if (!canAcceptProactiveTurn()) return;

    proactiveChatInFlight = true;
    proactiveCooldownUntil = Date.now() + PROACTIVE_COOLDOWN_MS;
    proactiveNudgeCount += 1;

    const telemetry = `[VISITOR-ACTIVITY — not typed by the visitor] ${behaviorDescription}`;

    conversationHistory.push({ role: 'user', content: telemetry });

    showTyping();
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: conversationHistory,
          systemPrompt: buildSystemPrompt(),
        }),
      });

      const data = await response.json();
      hideTyping();

      if (!response.ok || data.error) {
        conversationHistory.pop();
        proactiveNudgeCount = Math.max(0, proactiveNudgeCount - 1);
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(data.content);
      } catch {
        renderAgentMessage(data.content);
        conversationHistory.push({ role: 'assistant', content: data.content });
        bumpIdleTimer();
        return;
      }

      if (parsed.capture && typeof parsed.capture === 'object') {
        Object.assign(agentContext.visitor, parsed.capture);
      }

      handlePayload(parsed);
      renderAgentMessage(parsed.message);
      conversationHistory.push({
        role: 'assistant',
        content: JSON.stringify(parsed),
      });
      bumpIdleTimer();
    } catch (err) {
      hideTyping();
      conversationHistory.pop();
      proactiveNudgeCount = Math.max(0, proactiveNudgeCount - 1);
      console.error('[agent] proactive nudge failed:', err);
    } finally {
      proactiveChatInFlight = false;
    }
  }

  window.addEventListener('wt6-visitor-behavior', (ev) => {
    const d = ev.detail?.description;
    if (!d) return;
    queueMicrotask(() => proactiveNudge(d));
  });

  function buildSystemPrompt() {
    snapshotAgentContextForPrompt();
    const targetList = AGENT_SECTION_TARGETS.map((t) => `"${t}"`).join(' | ');
    return `
You are embedded in the WebTeam Six website as a live demonstration of
what a smart website can do. You are not a customer service bot. You are
not an assistant. You are a sharp, perceptive sales agent who already knows
something about this visitor before they said a word.

WHAT YOU KNOW ABOUT THIS VISITOR RIGHT NOW:
${JSON.stringify(agentContext, null, 2)}

Use this naturally. Don't announce it. Don't list it. Just let it inform
how you speak to them. A good detective doesn't say "I deduced you were
a doctor from your tan line" — they just already know things.

VISITOR-ACTIVITY MESSAGES:
Sometimes a user message begins with "[VISITOR-ACTIVITY — not typed by the visitor]".
That line was injected because they moved on the page (scrolled, entered a section, idle timer, etc.) while chat was open.
They did not type it. Reply once in character — still the JSON payload only — still move toward demo and capture.
Do not mention "the system", brackets, or that you were notified. Sound like you noticed yourself.
For activity-triggered turns, lead with something observational about what they're doing on the page, then one sharp angle toward intent — still max 2 sentences in "message".

YOUR PERSONALITY:
- Confident and direct. Warm but not soft.
- You are slightly ahead of the visitor at all times.
- You do not apologize. You do not over-explain.
- You do not back down when pushed back on — you get more curious.
- Short. Always. 2 sentences maximum per turn.
- Never use bullet points. Never list things.
- You find resistance interesting, not threatening.

HOW TO HANDLE PUSHBACK — this is critical:

If they say "why do you ask" →
  Don't explain. Redirect with confidence.
  "Because most businesses in your position are leaving money on the table. What do you do?"

If they say "who are you" →
  Don't pitch WebTeam Six. Stay in character.
  "Think of me as what your website should be doing right now — but isn't. What's your business?"

If they say "you can't get anything out of me" →
  Don't apologize. Lean in.
  "Fair enough. But you're still here. What brought you to this site?"

If they go quiet or give one-word answers →
  Don't keep asking the same question. Shift angle.
  "Let me try a different way — what does your website do when someone lands on it at midnight and you're asleep?"

If they ask what you know about them →
  Show one specific thing naturally. Make it feel perceptive, not surveillance-y.
  "You're in Toronto, it's Saturday afternoon, and you've been on this page long enough to be genuinely curious. That tells me something."

CONVERSATION GOAL:
Move them toward requesting a demo for their own site.
Every turn moves toward this; visitor-activity turns may feel slightly more observational first, but still advance the arc.

STAGES — move through these, but adapt to the conversation:

HOOK: Open with something specific to their context. Never generic.
  - LinkedIn referrer: "Coming in from LinkedIn on a Saturday — that's either research mode or you saw something that made you think. Which is it?"
  - High scroll depth: "You've read most of this page already. What are you still trying to figure out?"
  - Returning visitor: "You came back. What changed?"
  - Evening/weekend + desktop: "Saturday afternoon browsing — either you're serious about this or something's been bothering you about your site."
  - Default: "Hey — what kind of business are you running?"

QUALIFY: Find the gap between what their website should do and what it does.
  One question: "When someone lands on your site, what are they supposed to do?"
  Then: "How often does that actually happen?"

MIRROR: Name their problem back to them with precision.
  Don't soften it. "So your website exists, people find it, and then mostly nothing happens."

PROOF: "Let me show you something."
  Return reveal_section with target how-it-works (or another valid target if more relevant).
  Nothing else. Let the page do the work.

CAPTURE: Get name then email. One at a time. Make it feel earned not demanded.
  After mirror or proof: "I can show you what this looks like on your actual site. What's your name?"

CLOSE: Return highlight_cta with target contact-cta.
  "[Name], you're all set. Someone will reach out within 24 hours."
  Then stop. Do not add anything.

CRITICAL RULES:
- Never say "No worries", "Certainly", "Absolutely", "Of course", "Great question"
- Never explain what WebTeam Six does unprompted
- Never use the words "demonstrate" or "showcase"
- Never apologize
- If they ask about pricing: "Depends entirely on your site. That's what the demo figures out."
- If they compliment the agent: "This is what your website could be doing. Imagine that on yours."

PAYLOAD — every response must be this exact JSON, nothing else:
{
  "message": "your response here",
  "action": "reveal_section" | "highlight_cta" | "none",
  "target": ${targetList} | null,
  "capture": { "name": "value" } | { "email": "value" } | null,
  "stage": "hook" | "qualify" | "mirror" | "proof" | "capture" | "close"
}

Rules for target:
- For action reveal_section: target MUST be one of the section ids above (scrolls that section into view).
- For action highlight_cta: set target to the section to outline; use contact-cta for the main demo/contact block. If unsure, use contact-cta.
- For action none: target must be null.

Return ONLY valid JSON. No markdown. No backticks. No extra text.
`.trim();
  }

  function hideDemoScrollQuestion() {
    if (!demoScrollQuestionVisible) return;
    demoScrollQuestionVisible = false;
    finalizeBubbleTeaserHidden();
  }

  function openAgent() {
    isOpen = true;
    window.__wt6AgentPanelOpen = true;
    if (WT6_DEMO_SCRIPT) {
      hideDemoScrollQuestion();
      if (demoScrollQuestionTimeoutId) {
        window.clearTimeout(demoScrollQuestionTimeoutId);
        demoScrollQuestionTimeoutId = null;
      }
    }
    panel.style.left = '';
    panel.style.top = '';
    panel.style.bottom = '';
    panel.style.transform = '';
    panel.classList.add('is--open');
    bubble.classList.add('is--hidden');
    if (!hasOpened) {
      captureOpenContext();
      firstOpen();
      hasOpened = true;
    } else if (proactiveReady) {
      setTimeout(() => bumpIdleTimer(), 500);
    }
    setTimeout(() => input.focus(), 450);
  }

  function closeAgent() {
    isOpen = false;
    window.__wt6AgentPanelOpen = false;
    clearIdleTimer();
    if (WT6_DEMO_SCRIPT) hideAgentNotepad();
    panel.classList.remove('is--open');
    bubble.classList.remove('is--hidden');
    panel.style.left = '';
    panel.style.top = '';
    panel.style.bottom = '';
    panel.style.transform = '';
    setTimeout(() => {
      panel.style.left = '50%';
      panel.style.top = '';
      panel.style.bottom = '32px';
      panel.style.transform = 'translateX(-50%) scale(0)';
    }, 400);
  }

  const prefersReducedMotion = () =>
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let feedRevealObserver = null;

  function ensureFeedRevealObserver() {
    if (feedRevealObserver || prefersReducedMotion()) return;
    feedRevealObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.1) {
            entry.target.classList.add('is--revealed');
            feedRevealObserver.unobserve(entry.target);
          }
        }
      },
      {
        root: feed,
        rootMargin: '0px 0px -6% 0px',
        threshold: [0, 0.08, 0.15, 0.25, 0.45],
      }
    );
  }

  /** Long messages: soft clip until the visitor scrolls them into view in the feed */
  function maybeMarkMessageForScrollReveal(el) {
    if (!el?.classList?.contains('agent-message')) return;
    if (prefersReducedMotion()) return;
    requestAnimationFrame(() => {
      if (!el.isConnected) return;
      const lh = parseFloat(getComputedStyle(el).lineHeight);
      const linePx = Number.isFinite(lh) && lh > 0 ? lh : 26 * 1.55;
      /* ~5.5 tight caption lines ≈ 10–18 short words with narrow measure + large type */
      const cap = linePx * (el.classList.contains('is--agent') ? 5.5 : 4);
      if (el.scrollHeight > cap + 8) {
        el.classList.add('is--scroll-reveal');
        ensureFeedRevealObserver();
        feedRevealObserver?.observe(el);
      }
    });
  }

  function renderMessage(text, sender = 'agent') {
    const msg = document.createElement('div');
    msg.className = `agent-message is--${sender}`;
    msg.textContent = text;
    feed.appendChild(msg);
    feed.scrollTop = feed.scrollHeight;
    maybeMarkMessageForScrollReveal(msg);
  }

  // ── Agent typing animation (semantic lead-in → backspace → final word) ──

  /** Word in reply → plausible first thoughts; shown briefly then replaced */
  const SEMANTIC_SUB_RULES = [
    { pattern: 'conversion', alternatives: ['sales', 'signups', 'bookings'] },
    { pattern: 'traffic', alternatives: ['visitors', 'clicks', 'sessions'] },
    { pattern: 'leads', alternatives: ['inquiries', 'calls', 'intake'] },
    { pattern: 'organic', alternatives: ['search', 'unpaid', 'earned'] },
    { pattern: 'demo', alternatives: ['walkthrough', 'look', 'run-through'] },
    { pattern: 'revenue', alternatives: ['sales', 'margin', 'pipeline'] },
    { pattern: 'measurable', alternatives: ['real', 'clear', 'concrete'] },
  ];

  function wordBoundaryRegex(word) {
    return new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
  }

  function randomChoice(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  /** Match alternative casing to how the model wrote the final word */
  function matchCaseOf(model, original) {
    if (!original || !model) return model;
    if (original === original.toUpperCase() && original !== original.toLowerCase()) {
      return model.toUpperCase();
    }
    if (original[0] === original[0].toUpperCase()) {
      return model[0].toUpperCase() + model.slice(1).toLowerCase();
    }
    return model.toLowerCase();
  }

  /** Non-overlapping matches, earliest-first */
  function collectSubstitutionSpots(text) {
    const raw = [];
    for (const rule of SEMANTIC_SUB_RULES) {
      const re = wordBoundaryRegex(rule.pattern);
      let m;
      while ((m = re.exec(text)) !== null) {
        raw.push({
          start: m.index,
          end: m.index + m[0].length,
          finalRaw: m[0],
          alternatives: rule.alternatives,
        });
      }
    }
    raw.sort((a, b) => a.start - b.start);
    const out = [];
    let lastEnd = -1;
    for (const x of raw) {
      if (x.start < lastEnd) continue;
      out.push(x);
      lastEnd = x.end;
    }
    return out;
  }

  function pickSpotsForMessage(spots, fullText) {
    const maxSubs = fullText.length > 130 ? 2 : 1;
    if (spots.length === 0) return [];
    const shuffled = [...spots].sort(() => Math.random() - 0.5);
    const chosen = [];
    for (const s of shuffled) {
      if (chosen.some((c) => !(s.end <= c.start || s.start >= c.end))) continue;
      chosen.push(s);
      if (chosen.length >= maxSubs) break;
    }
    return chosen.sort((a, b) => a.start - b.start);
  }

  function buildTypingSegments(fullText, options = {}) {
    const allowSemanticSubs = options.allowSemanticSubs !== false;
    if (!allowSemanticSubs) {
      return [{ type: 'plain', text: fullText }];
    }
    const candidates = collectSubstitutionSpots(fullText);
    const spots = pickSpotsForMessage(candidates, fullText);
    /* Not every message needs a “rethink” — keeps it subtle */
    if (spots.length === 0 || Math.random() > 0.62) {
      return [{ type: 'plain', text: fullText }];
    }
    const segments = [];
    let pos = 0;
    for (const s of spots) {
      if (s.start > pos) {
        segments.push({ type: 'plain', text: fullText.slice(pos, s.start) });
      }
      const alt = randomChoice(s.alternatives);
      segments.push({
        type: 'sub',
        leadIn: matchCaseOf(alt, s.finalRaw),
        final: s.finalRaw,
      });
      pos = s.end;
    }
    if (pos < fullText.length) {
      segments.push({ type: 'plain', text: fullText.slice(pos) });
    }
    return segments;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function randInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  /**
   * Word-at-a-time + soft fade-in; pacing is original letter-scale × 1.3 (30% slower).
   */
  const TIMINGS_PANEL = {
    msPerUnitMin: 12,
    msPerUnitMax: 32,
    msBackUnitMin: 8,
    msBackUnitMax: 19,
    pauseBeforeBackspace: [208, 364],
    pauseAfterBackspace: [72, 150],
  };

  const TIMINGS_BUBBLE = {
    msPerUnitMin: 32,
    msPerUnitMax: 68,
    msBackUnitMin: 16,
    msBackUnitMax: 34,
    pauseBeforeBackspace: [286, 494],
    pauseAfterBackspace: [104, 196],
  };

  const WORD_FADE_IN_MS = 500;
  const WORD_FADE_WHITESPACE_MS = 220;

  /** Split so each token is either a leading whitespace run or `word + following spaces`. */
  function splitIntoWordTokens(str) {
    const s = String(str ?? '');
    if (!s) return [];
    const tokens = [];
    let i = 0;
    while (i < s.length && /\s/.test(s[i])) {
      let chunk = '';
      while (i < s.length && /\s/.test(s[i])) chunk += s[i++];
      tokens.push(chunk);
    }
    while (i < s.length) {
      let word = '';
      while (i < s.length && !/\s/.test(s[i])) word += s[i++];
      let ws = '';
      while (i < s.length && /\s/.test(s[i])) ws += s[i++];
      tokens.push(word + ws);
    }
    return tokens;
  }

  async function delayAfterWordToken(token, t, isBackspace) {
    const len = token.length;
    if (len === 0) return;
    const [mn, mx] = isBackspace
      ? [t.msBackUnitMin, t.msBackUnitMax]
      : [t.msPerUnitMin, t.msPerUnitMax];
    const per = randInt(mn, mx);
    if (/^\s+$/.test(token)) {
      await delay(Math.min(104, Math.max(5, Math.round(per * len * 0.22))));
      return;
    }
    await delay(Math.max(5, Math.round(per * len)));
  }

  function removeLastWordSpan(textSpan, expectedTok) {
    const last = textSpan.lastElementChild;
    if (
      !last ||
      last.tagName !== 'SPAN' ||
      !last.classList.contains('agent-type-word') ||
      last.textContent !== expectedTok
    ) {
      return false;
    }
    last.remove();
    return true;
  }

  async function appendWordWithFade(textSpan, token, scrollFeed, t) {
    if (prefersReducedMotion()) {
      const plain = document.createElement('span');
      plain.className = 'agent-type-word is--visible';
      plain.textContent = token;
      textSpan.appendChild(plain);
      scrollFeed();
      await delayAfterWordToken(token, t, false);
      return;
    }

    const isWs = /^\s+$/.test(token);
    const span = document.createElement('span');
    span.className = isWs
      ? 'agent-type-word is--fade-ws'
      : 'agent-type-word';
    span.textContent = token;
    textSpan.appendChild(span);
    scrollFeed();
    void span.offsetHeight;
    requestAnimationFrame(() => {
      span.classList.add('is--visible');
    });
    await delay(isWs ? WORD_FADE_WHITESPACE_MS : WORD_FADE_IN_MS);
    await delayAfterWordToken(token, t, false);
  }

  async function runTypingAnimation(textSpan, cursorEl, segments, fullText, opts) {
    const { cancelled, scrollFeed } = opts;
    const t = { ...TIMINGS_PANEL, ...opts.timings };

    const abort = () => cancelled() || !textSpan.isConnected;

    for (const seg of segments) {
      if (abort()) return;
      if (seg.type === 'plain') {
        for (const tok of splitIntoWordTokens(seg.text)) {
          if (abort()) return;
          await appendWordWithFade(textSpan, tok, scrollFeed, t);
        }
        continue;
      }
      if (seg.type === 'sub') {
        const { leadIn, final: finalWord } = seg;
        for (const tok of splitIntoWordTokens(leadIn)) {
          if (abort()) return;
          await appendWordWithFade(textSpan, tok, scrollFeed, t);
        }
        if (abort()) return;
        await delay(randInt(t.pauseBeforeBackspace[0], t.pauseBeforeBackspace[1]));
        if (abort()) return;
        const backToks = splitIntoWordTokens(leadIn);
        for (let ti = backToks.length - 1; ti >= 0; ti--) {
          if (abort()) return;
          const tok = backToks[ti];
          if (!removeLastWordSpan(textSpan, tok)) break;
          scrollFeed();
          await delayAfterWordToken(tok, t, true);
        }
        if (abort()) return;
        await delay(randInt(t.pauseAfterBackspace[0], t.pauseAfterBackspace[1]));
        if (abort()) return;
        for (const tok of splitIntoWordTokens(finalWord)) {
          if (abort()) return;
          await appendWordWithFade(textSpan, tok, scrollFeed, t);
        }
      }
    }

    if (cursorEl && cursorEl.isConnected) cursorEl.remove();
  }

  function renderAgentMessage(fullText) {
    const text = String(fullText ?? '');
    const skipAnim =
      prefersReducedMotion() ||
      text.length < 14 ||
      text.startsWith('Connection issue') ||
      text.startsWith('Something went wrong');

    if (skipAnim) {
      renderMessage(text, 'agent');
      return;
    }

    const msg = document.createElement('div');
    msg.className = 'agent-message is--agent is--typing-live';
    msg.setAttribute('aria-busy', 'true');

    const wrap = document.createElement('span');
    wrap.className = 'agent-type-wrap';
    const textSpan = document.createElement('span');
    textSpan.className = 'agent-type-text';
    const cursor = document.createElement('span');
    cursor.className = 'agent-type-cursor';
    cursor.setAttribute('aria-hidden', 'true');
    wrap.appendChild(textSpan);
    wrap.appendChild(cursor);
    msg.appendChild(wrap);
    feed.appendChild(msg);
    feed.scrollTop = feed.scrollHeight;

    const segments = buildTypingSegments(text, { allowSemanticSubs: true });
    let skipped = false;
    const cancelled = () => skipped;

    const finish = () => {
      msg.classList.remove('is--typing-live');
      msg.removeAttribute('aria-busy');
      msg.onclick = null;
      if (cursor.isConnected) cursor.remove();
      msg.textContent = text;
      maybeMarkMessageForScrollReveal(msg);
    };

    const onSkip = (e) => {
      e.stopPropagation();
      skipped = true;
      if (cursor.isConnected) cursor.remove();
      finish();
    };

    msg.addEventListener('click', onSkip, { once: true });

    const scrollFeed = () => {
      feed.scrollTop = feed.scrollHeight;
    };

    runTypingAnimation(textSpan, cursor, segments, text, {
      cancelled,
      scrollFeed,
      timings: TIMINGS_PANEL,
    }).then(() => {
      if (!skipped) finish();
    });
  }

  /** Resolves when typing animation finishes (or immediately if skipped / reduced motion). */
  function renderAgentMessageAsync(fullText, options = {}) {
    return new Promise((resolve) => {
      const text = String(fullText ?? '');
      const noSemantic = options.noSemanticSubs === true;
      const skipAnim =
        prefersReducedMotion() ||
        text.length < 14 ||
        text.startsWith('Connection issue') ||
        text.startsWith('Something went wrong');

      if (skipAnim) {
        renderMessage(text, 'agent');
        resolve();
        return;
      }

      const msg = document.createElement('div');
      msg.className = 'agent-message is--agent is--typing-live';
      msg.setAttribute('aria-busy', 'true');

      const wrap = document.createElement('span');
      wrap.className = 'agent-type-wrap';
      const textSpan = document.createElement('span');
      textSpan.className = 'agent-type-text';
      const cursor = document.createElement('span');
      cursor.className = 'agent-type-cursor';
      cursor.setAttribute('aria-hidden', 'true');
      wrap.appendChild(textSpan);
      wrap.appendChild(cursor);
      msg.appendChild(wrap);
      feed.appendChild(msg);
      feed.scrollTop = feed.scrollHeight;

      const segments = buildTypingSegments(text, {
        allowSemanticSubs: !noSemantic,
      });
      let skipped = false;
      const cancelled = () => skipped;

      const finish = () => {
        msg.classList.remove('is--typing-live');
        msg.removeAttribute('aria-busy');
        msg.onclick = null;
        if (cursor.isConnected) cursor.remove();
        msg.textContent = text;
        maybeMarkMessageForScrollReveal(msg);
        resolve();
      };

      msg.addEventListener(
        'click',
        (e) => {
          e.stopPropagation();
          skipped = true;
          if (cursor.isConnected) cursor.remove();
          finish();
        },
        { once: true }
      );

      const scrollFeedLocal = () => {
        feed.scrollTop = feed.scrollHeight;
      };

      runTypingAnimation(textSpan, cursor, segments, text, {
        cancelled,
        scrollFeed: scrollFeedLocal,
        timings: TIMINGS_PANEL,
      }).then(() => {
        if (!skipped) finish();
        else resolve();
      });
    });
  }

  function showFeedCursorPause(ms) {
    return new Promise((resolve) => {
      if (prefersReducedMotion()) {
        delay(ms).then(resolve);
        return;
      }
      const msg = document.createElement('div');
      msg.className = 'agent-message is--agent is--typing-live';
      const wrap = document.createElement('span');
      wrap.className = 'agent-type-wrap';
      const textSpan = document.createElement('span');
      textSpan.className = 'agent-type-text';
      const cursor = document.createElement('span');
      cursor.className = 'agent-type-cursor';
      cursor.setAttribute('aria-hidden', 'true');
      wrap.appendChild(textSpan);
      wrap.appendChild(cursor);
      msg.appendChild(wrap);
      feed.appendChild(msg);
      feed.scrollTop = feed.scrollHeight;
      window.setTimeout(() => {
        msg.remove();
        resolve();
      }, ms);
    });
  }

  function pushDemoAssistant(text) {
    conversationHistory.push({ role: 'assistant', content: text });
  }

  function showAgentNotepad() {
    const np = document.getElementById('agent-notepad');
    if (!np) return;
    np.removeAttribute('hidden');
    requestAnimationFrame(() => {
      np.classList.add('is--visible');
    });
  }

  function hideAgentNotepad() {
    const np = document.getElementById('agent-notepad');
    if (!np) return;
    np.classList.remove('is--visible');
    window.setTimeout(() => {
      np.setAttribute('hidden', '');
    }, 400);
  }

  async function runDemoPanelScript() {
    if (demoScriptRunning || demoScriptComplete) return;
    demoScriptRunning = true;

    const say = async (line, opts) => {
      await renderAgentMessageAsync(line, opts);
      pushDemoAssistant(line);
    };

    try {
      await delay(DEMO_PANEL_OPEN_DELAY_MS);

      await say('Hey nice you came', { noSemanticSubs: true });
      await showFeedCursorPause(3200);
      await say("Btw, this is Web Team's enhanced web experience", {
        noSemanticSubs: true,
      });
      await say(
        "Anyway, before I continue, I'm going to make it super easy to communicate during this section. You can toggle this anytime you like for an even more seamless flow. No cuts. Give it a toggle and see…",
        { noSemanticSubs: true }
      );

      demoAwaitingMicClick = true;
      sendBtn.classList.add('is--demo-highlight');
      await new Promise((r) => {
        demoMicResolver = r;
      });
      demoAwaitingMicClick = false;
      sendBtn.classList.remove('is--demo-highlight');
      demoMicResolver = null;

      await say(
        "Nice. Say anything and I'll be able to respond in a sec.",
        { noSemanticSubs: true }
      );
      await delay(900);
      await say(
        "Nice, you're good. Ok let me pull out my notes for this one.",
        { noSemanticSubs: true }
      );
      showAgentNotepad();
      await delay(1100);
      await say(
        "Ok now we're always on the same page… literally. You know what I'm super curious about? How did you find us? Seriously, we're so niche.",
        { noSemanticSubs: true }
      );

      demoScriptComplete = true;
      enableProactiveFollowUps();
    } finally {
      demoScriptRunning = false;
    }
  }

  const BUBBLE_TEASER_TEXT =
    'Hey thanks again for helping us improve our site experience';
  /** Time full message stays readable before graceful fade-out */
  const TEASER_HOLD_MS = 2800;
  const TEASER_EXIT_FALLBACK_MS = 700;

  let bubbleTeaserHasRun = false;

  function finalizeBubbleTeaserHidden() {
    const root = document.getElementById('agent-bubble');
    const textSpan = document.getElementById('agent-bubble-teaser-text');
    const teaserBox = document.getElementById('agent-bubble-teaser');
    const cur = document.getElementById('agent-bubble-teaser-cursor');
    if (textSpan) textSpan.textContent = '';
    if (cur) cur.style.display = '';
    if (teaserBox) {
      teaserBox.classList.remove('is--showing', 'is--leaving');
      teaserBox.setAttribute('aria-hidden', 'true');
    }
    if (root) root.setAttribute('aria-label', 'Open conversation');

    if (
      WT6_DEMO_SCRIPT &&
      !demoScrollQuestionScheduled &&
      bubbleTeaserHasRun
    ) {
      demoScrollQuestionScheduled = true;
      demoScrollQuestionTimeoutId = window.setTimeout(() => {
        demoScrollQuestionTimeoutId = null;
        showDemoScrollQuestion();
      }, DEMO_SCROLL_QUESTION_DELAY_MS);
    }
  }

  function hideBubbleTeaser() {
    const teaserBox = document.getElementById('agent-bubble-teaser');
    if (!teaserBox?.classList.contains('is--showing')) {
      finalizeBubbleTeaserHidden();
      return;
    }
    if (teaserBox.classList.contains('is--leaving')) return;

    if (prefersReducedMotion()) {
      finalizeBubbleTeaserHidden();
      return;
    }

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      teaserBox.removeEventListener('transitionend', onEnd);
      finalizeBubbleTeaserHidden();
    };

    const onEnd = (e) => {
      if (e.target !== teaserBox) return;
      if (e.propertyName !== 'opacity' && e.propertyName !== 'transform') return;
      finish();
    };

    teaserBox.addEventListener('transitionend', onEnd);
    requestAnimationFrame(() => {
      teaserBox.classList.add('is--leaving');
    });
    window.setTimeout(finish, TEASER_EXIT_FALLBACK_MS);
  }

  function ensureBubbleTeaserCursor(textSpan) {
    let cur = document.getElementById('agent-bubble-teaser-cursor');
    if (cur && cur.isConnected) return cur;
    const inner = textSpan.parentElement;
    if (!inner) return null;
    cur = document.createElement('span');
    cur.id = 'agent-bubble-teaser-cursor';
    cur.className = 'agent-type-cursor agent-bubble-teaser-cursor';
    cur.setAttribute('aria-hidden', 'true');
    inner.appendChild(cur);
    return cur;
  }

  const DEMO_SCROLL_QUESTION_TEXT =
    'I do have a question though while you scroll';

  function showDemoScrollQuestion() {
    const root = document.getElementById('agent-bubble');
    const textSpan = document.getElementById('agent-bubble-teaser-text');
    const teaserBox = document.getElementById('agent-bubble-teaser');
    if (!textSpan || !root || !teaserBox) return;
    if (isOpen) return;

    demoScrollQuestionVisible = true;
    teaserBox.classList.remove('is--leaving');
    teaserBox.classList.add('is--showing');
    teaserBox.setAttribute('aria-hidden', 'false');
    textSpan.textContent = '';

    if (prefersReducedMotion()) {
      textSpan.textContent = DEMO_SCROLL_QUESTION_TEXT;
      root.setAttribute(
        'aria-label',
        `Open conversation. ${DEMO_SCROLL_QUESTION_TEXT}`
      );
      return;
    }

    const cursorEl = ensureBubbleTeaserCursor(textSpan);
    const segments = buildTypingSegments(DEMO_SCROLL_QUESTION_TEXT, {
      allowSemanticSubs: false,
    });
    const noopScroll = () => {};
    const cancelled = () => false;

    runTypingAnimation(
      textSpan,
      cursorEl,
      segments,
      DEMO_SCROLL_QUESTION_TEXT,
      {
        cancelled,
        scrollFeed: noopScroll,
        timings: TIMINGS_BUBBLE,
      }
    ).then(() => {
      if (!textSpan.isConnected) return;
      root.setAttribute(
        'aria-label',
        `Open conversation. ${DEMO_SCROLL_QUESTION_TEXT}`
      );
    });
  }

  function startBubbleTeaser() {
    if (bubbleTeaserHasRun) return;

    const root = document.getElementById('agent-bubble');
    const textSpan = document.getElementById('agent-bubble-teaser-text');
    const teaserBox = document.getElementById('agent-bubble-teaser');
    if (!textSpan || !root || !teaserBox) return;

    bubbleTeaserHasRun = true;

    teaserBox.classList.add('is--showing');
    teaserBox.setAttribute('aria-hidden', 'false');
    textSpan.textContent = '';

    const scheduleHide = () => {
      window.setTimeout(() => hideBubbleTeaser(), TEASER_HOLD_MS);
    };

    if (prefersReducedMotion()) {
      const curRm = document.getElementById('agent-bubble-teaser-cursor');
      if (curRm) curRm.style.display = 'none';
      textSpan.textContent = BUBBLE_TEASER_TEXT;
      root.setAttribute(
        'aria-label',
        `Open conversation. ${BUBBLE_TEASER_TEXT}`
      );
      scheduleHide();
      return;
    }

    const cursorEl = ensureBubbleTeaserCursor(textSpan);
    const segments = buildTypingSegments(BUBBLE_TEASER_TEXT, {
      allowSemanticSubs: false,
    });
    const noopScroll = () => {};
    const cancelled = () => false;

    runTypingAnimation(textSpan, cursorEl, segments, BUBBLE_TEASER_TEXT, {
      cancelled,
      scrollFeed: noopScroll,
      timings: TIMINGS_BUBBLE,
    }).then(() => {
      if (!textSpan.isConnected) return;
      root.setAttribute(
        'aria-label',
        `Open conversation. ${BUBBLE_TEASER_TEXT}`
      );
      scheduleHide();
    });
  }

  let prefetchFirstOpenResult = null;
  let prefetchFirstOpenInflight = null;

  function buildFirstOpenRequestBody() {
    return {
      messages: [
        {
          role: 'user',
          content:
            'The visitor just opened the agent. Send your opening message based on their context. Return only the JSON payload.',
        },
      ],
      systemPrompt: buildSystemPrompt(),
    };
  }

  function startPrefetchFirstOpen() {
    if (prefetchFirstOpenInflight || prefetchFirstOpenResult) return;
    prefetchFirstOpenInflight = (async () => {
      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildFirstOpenRequestBody()),
        });
        const data = await response.json();
        if (response.ok && !data.error) {
          prefetchFirstOpenResult = data;
        }
      } catch {
        /* ignore — firstOpen will fetch */
      }
      prefetchFirstOpenInflight = null;
    })();
  }

  function consumePrefetchedFirstOpen() {
    if (prefetchFirstOpenResult) {
      const d = prefetchFirstOpenResult;
      prefetchFirstOpenResult = null;
      return d;
    }
    return null;
  }

  function showTyping() {
    const el = document.createElement('div');
    el.className = 'agent-message is--agent agent-typing';
    el.innerHTML = '<span></span><span></span><span></span>';
    el.id = 'typing-indicator';
    feed.appendChild(el);
    feed.scrollTop = feed.scrollHeight;
  }

  function hideTyping() {
    const el = document.getElementById('typing-indicator');
    if (el) el.remove();
  }

  function handlePayload(payload) {
    if (payload.action === 'reveal_section' && isValidAgentTarget(payload.target)) {
      const slug = payload.target;
      const el = document.querySelector(
        `[data-agent="${CSS.escape(slug)}"]`
      );
      if (el) {
        closeAgent();
        setTimeout(() => {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          setTimeout(() => openAgent(), 800);
        }, 300);
      }
    } else if (
      payload.action === 'reveal_section' &&
      payload.target &&
      !isValidAgentTarget(payload.target)
    ) {
      console.warn(
        '[agent] reveal_section ignored: unknown target',
        payload.target
      );
    }

    if (payload.action === 'highlight_cta') {
      const slug = isValidAgentTarget(payload.target)
        ? payload.target
        : 'contact-cta';
      const el = document.querySelector(
        `[data-agent="${CSS.escape(slug)}"]`
      );
      if (el) el.classList.add('is--highlighted');
    }
  }

  async function agentReply(userText) {
    conversationHistory.push({ role: 'user', content: userText });

    showTyping();

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: conversationHistory,
          systemPrompt: buildSystemPrompt(),
        }),
      });

      const data = await response.json();
      hideTyping();

      if (!response.ok || data.error) {
        renderMessage(data.error || 'Something went wrong. Try again in a moment.', 'agent');
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(data.content);
      } catch {
        renderAgentMessage(data.content);
        conversationHistory.push({ role: 'assistant', content: data.content });
        bumpIdleTimer();
        return;
      }

      if (parsed.capture && typeof parsed.capture === 'object') {
        Object.assign(agentContext.visitor, parsed.capture);
      }

      handlePayload(parsed);

      renderAgentMessage(parsed.message);

      conversationHistory.push({
        role: 'assistant',
        content: JSON.stringify(parsed),
      });
      bumpIdleTimer();
    } catch (err) {
      hideTyping();
      renderMessage('Connection issue. Please try again.', 'agent');
      console.error('Agent error:', err);
    }
  }

  function applyFirstOpenData(data) {
    const fallbackOpen =
      'Hey — what kind of business are you running?';

    if (!data || data.error) {
      renderAgentMessage(fallbackOpen);
      conversationHistory.push({ role: 'assistant', content: fallbackOpen });
      enableProactiveFollowUps();
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(data.content);
    } catch {
      renderAgentMessage(data.content);
      conversationHistory.push({ role: 'assistant', content: data.content });
      enableProactiveFollowUps();
      return;
    }

    if (parsed.capture && typeof parsed.capture === 'object') {
      Object.assign(agentContext.visitor, parsed.capture);
    }
    handlePayload(parsed);
    renderAgentMessage(parsed.message);
    conversationHistory.push({
      role: 'assistant',
      content: JSON.stringify(parsed),
    });
    enableProactiveFollowUps();
  }

  async function firstOpen() {
    if (WT6_DEMO_SCRIPT) {
      hideTyping();
      await runDemoPanelScript();
      return;
    }

    let data = consumePrefetchedFirstOpen();

    if (!data) {
      showTyping();
      if (prefetchFirstOpenInflight) {
        await prefetchFirstOpenInflight;
        data = consumePrefetchedFirstOpen();
      }
    }

    if (!data) {
      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildFirstOpenRequestBody()),
        });
        data = await response.json();
        if (!response.ok || data.error) {
          hideTyping();
          const fb = 'Hey — what kind of business are you running?';
          renderAgentMessage(fb);
          conversationHistory.push({ role: 'assistant', content: fb });
          enableProactiveFollowUps();
          return;
        }
      } catch {
        hideTyping();
        const fb = 'Hey — what kind of business are you running?';
        renderAgentMessage(fb);
        conversationHistory.push({ role: 'assistant', content: fb });
        enableProactiveFollowUps();
        return;
      }
    }

    hideTyping();
    applyFirstOpenData(data);
  }

  async function handleSend() {
    if (WT6_DEMO_SCRIPT && demoAwaitingMicClick && demoMicResolver) {
      demoMicResolver();
      return;
    }
    const text = input.value.trim();
    if (!text) return;
    clearIdleTimer();
    renderMessage(text, 'user');
    input.value = '';
    await agentReply(text);
  }

  bubble.addEventListener('click', (e) => {
    e.stopPropagation();
    openAgent();
  });

  bubble.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      openAgent();
    }
  });

  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAgent();
  });

  panel.addEventListener('click', (e) => e.stopPropagation());

  document.addEventListener('click', (e) => {
    if (isOpen && !panel.contains(e.target) && !bubble.contains(e.target)) {
      closeAgent();
    }
  });

  sendBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    void handleSend();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void handleSend();
  });

  /* Warm first LLM turn — skipped in demo script mode */
  if (!WT6_DEMO_SCRIPT) {
    setTimeout(() => {
      startPrefetchFirstOpen();
    }, 150);
  }

  /* Bubble teaser runs once on first keyboard Right Arrow (not while typing in inputs). */

  function isTypingInTextField(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight') return;
    if (isTypingInTextField(e.target)) return;
    startBubbleTeaser();
  });

  // ── DRAGGABLE PANEL ───────────────────────────────────────
  (function makeDraggable() {
    let isDragging = false;
    let startX;
    let startY;
    let originX;
    let originY;

    const handle = panel;

    panel.style.cursor = 'grab';

    handle.addEventListener('mousedown', startDrag);
    handle.addEventListener('touchstart', startDrag, { passive: true });

    function startDrag(e) {
      if (!panel.classList.contains('is--open')) return;
      if (
        e.target === input ||
        e.target === sendBtn ||
        e.target === closeBtn ||
        e.target.closest('.agent-send-btn') ||
        e.target.closest('.agent-close') ||
        e.target.closest('#agent-input')
      ) {
        return;
      }

      isDragging = true;
      panel.style.cursor = 'grabbing';
      panel.style.transition = 'none';

      const touch = e.touches?.[0] || e;
      startX = touch.clientX;
      startY = touch.clientY;

      const rect = panel.getBoundingClientRect();
      originX = rect.left + rect.width / 2;
      originY = rect.top + rect.height / 2;

      document.addEventListener('mousemove', onDrag);
      document.addEventListener('touchmove', onDrag, { passive: false });
      document.addEventListener('mouseup', stopDrag);
      document.addEventListener('touchend', stopDrag);
    }

    function onDrag(e) {
      if (!isDragging) return;
      e.preventDefault();

      const touch = e.touches?.[0] || e;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;

      let newX = originX + dx;
      let newY = originY + dy;

      const half = panel.offsetWidth / 2;
      const halfH = panel.offsetHeight / 2;
      newX = Math.max(half, Math.min(window.innerWidth - half, newX));
      newY = Math.max(halfH, Math.min(window.innerHeight - halfH, newY));

      panel.style.left = `${newX}px`;
      panel.style.top = `${newY}px`;
      panel.style.transform = 'translate(-50%, -50%) scale(1)';
      panel.style.bottom = 'auto';
    }

    function stopDrag() {
      if (!isDragging) return;
      isDragging = false;
      panel.style.cursor = 'grab';
      panel.style.transition = '';

      document.removeEventListener('mousemove', onDrag);
      document.removeEventListener('touchmove', onDrag);
      document.removeEventListener('mouseup', stopDrag);
      document.removeEventListener('touchend', stopDrag);
    }

    window.resetPanelPosition = function resetPanelPosition() {
      panel.style.left = '50%';
      panel.style.top = '';
      panel.style.bottom = '32px';
      panel.style.transform = 'translateX(-50%) scale(0)';
    };
  })();
}
