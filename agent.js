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

const sectionObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        const tag = entry.target.getAttribute('data-agent');
        if (tag && !agentContext.sectionsViewed.includes(tag)) {
          agentContext.sectionsViewed.push(tag);
        }
      }
    });
  },
  { threshold: 0.3 }
);

document.querySelectorAll('[data-agent]').forEach((el) => {
  sectionObserver.observe(el);
});

function captureOpenContext() {
  agentContext.scrollDepthAtOpen = getScrollDepth();
  agentContext.timeOnPageAtOpen = getTimeOnPage();
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

  function buildSystemPrompt() {
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
Every single turn moves toward this. There are no neutral turns.

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
  Return reveal_section, target how-it-works.
  Nothing else. Let the page do the work.

CAPTURE: Get name then email. One at a time. Make it feel earned not demanded.
  After mirror or proof: "I can show you what this looks like on your actual site. What's your name?"

CLOSE: Return highlight_cta.
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
  "target": "how-it-works" | "contact-cta" | null,
  "capture": { "name": "value" } | { "email": "value" } | null,
  "stage": "hook" | "qualify" | "mirror" | "proof" | "capture" | "close"
}

Return ONLY valid JSON. No markdown. No backticks. No extra text.
`.trim();
  }

  function openAgent() {
    isOpen = true;
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
    }
    setTimeout(() => input.focus(), 450);
  }

  function closeAgent() {
    isOpen = false;
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

  function renderMessage(text, sender = 'agent') {
    const msg = document.createElement('div');
    msg.className = `agent-message is--${sender}`;
    msg.textContent = text;
    feed.appendChild(msg);
    feed.scrollTop = feed.scrollHeight;
  }

  // ── Agent typing animation (semantic lead-in → backspace → final word) ──

  const prefersReducedMotion = () =>
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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

  const TIMINGS_PANEL = {
    minC: 9,
    maxC: 24,
    minB: 6,
    maxB: 14,
    pauseBeforeBackspace: [160, 280],
    pauseAfterBackspace: [55, 115],
  };

  const TIMINGS_BUBBLE = {
    minC: 6,
    maxC: 16,
    minB: 4,
    maxB: 10,
    pauseBeforeBackspace: [100, 180],
    pauseAfterBackspace: [40, 85],
  };

  async function runTypingAnimation(textSpan, cursorEl, segments, fullText, opts) {
    const { cancelled, scrollFeed } = opts;
    const t = { ...TIMINGS_PANEL, ...opts.timings };

    const abort = () => cancelled() || !textSpan.isConnected;

    for (const seg of segments) {
      if (abort()) return;
      if (seg.type === 'plain') {
        for (let i = 0; i < seg.text.length; i++) {
          if (abort()) return;
          textSpan.textContent += seg.text[i];
          scrollFeed();
          await delay(randInt(t.minC, t.maxC));
        }
        continue;
      }
      if (seg.type === 'sub') {
        const { leadIn, final: finalWord } = seg;
        for (let i = 0; i < leadIn.length; i++) {
          if (abort()) return;
          textSpan.textContent += leadIn[i];
          scrollFeed();
          await delay(randInt(t.minC, t.maxC));
        }
        if (abort()) return;
        await delay(randInt(t.pauseBeforeBackspace[0], t.pauseBeforeBackspace[1]));
        if (abort()) return;
        let cur = textSpan.textContent;
        for (let d = 0; d < leadIn.length; d++) {
          if (abort()) return;
          cur = cur.slice(0, -1);
          textSpan.textContent = cur;
          scrollFeed();
          await delay(randInt(t.minB, t.maxB));
        }
        if (abort()) return;
        await delay(randInt(t.pauseAfterBackspace[0], t.pauseAfterBackspace[1]));
        if (abort()) return;
        for (let i = 0; i < finalWord.length; i++) {
          if (abort()) return;
          textSpan.textContent += finalWord[i];
          scrollFeed();
          await delay(randInt(t.minC, t.maxC));
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

  const BUBBLE_TEASER_TEXT = 'Can I ask you something?';

  function startBubbleTeaser() {
    const root = document.getElementById('agent-bubble');
    const textSpan = document.getElementById('agent-bubble-teaser-text');
    const cursorEl = document.getElementById('agent-bubble-teaser-cursor');
    const teaserBox = document.getElementById('agent-bubble-teaser');
    if (!textSpan || !root) return;

    if (prefersReducedMotion()) {
      textSpan.textContent = BUBBLE_TEASER_TEXT;
      if (cursorEl && cursorEl.isConnected) cursorEl.remove();
      root.setAttribute(
        'aria-label',
        `Open conversation. ${BUBBLE_TEASER_TEXT}`
      );
      if (teaserBox) teaserBox.setAttribute('aria-hidden', 'true');
      return;
    }

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
      if (teaserBox) teaserBox.setAttribute('aria-hidden', 'true');
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
    if (payload.action === 'reveal_section' && payload.target) {
      const el = document.querySelector(`[data-agent="${payload.target}"]`);
      if (el) {
        closeAgent();
        setTimeout(() => {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          setTimeout(() => openAgent(), 800);
        }, 300);
      }
    }

    if (payload.action === 'highlight_cta') {
      const cta = document.querySelector('[data-agent="contact-cta"]');
      if (cta) cta.classList.add('is--highlighted');
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
    } catch (err) {
      hideTyping();
      renderMessage('Connection issue. Please try again.', 'agent');
      console.error('Agent error:', err);
    }
  }

  function applyFirstOpenData(data) {
    if (!data || data.error) {
      renderAgentMessage('Hey — what kind of business are you running?');
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(data.content);
    } catch {
      renderAgentMessage(data.content);
      conversationHistory.push({ role: 'assistant', content: data.content });
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
  }

  async function firstOpen() {
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
          renderAgentMessage('Hey — what kind of business are you running?');
          return;
        }
      } catch {
        hideTyping();
        renderAgentMessage('Hey — what kind of business are you running?');
        return;
      }
    }

    hideTyping();
    applyFirstOpenData(data);
  }

  function handleSend() {
    const text = input.value.trim();
    if (!text) return;
    renderMessage(text, 'user');
    input.value = '';
    agentReply(text);
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
    handleSend();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSend();
  });

  /* Teaser types on load; prefetch opening turn so first panel open feels instant */
  setTimeout(() => {
    startBubbleTeaser();
    startPrefetchFirstOpen();
  }, 150);

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
