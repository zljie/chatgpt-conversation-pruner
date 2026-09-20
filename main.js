// ==UserScript==
// @name         ChatGPT 长对话卡顿优化 + 计划任务循环
// @namespace    chatgpt-conversation-pruner
// @version      1.5
// @description  chatgpt长对话卡顿优化，同时支持按照计划自动继续聊天，并在响应结束后继续等待下一轮。
// @match        https://chatgpt.com/*
// @grant        none
// @run-at       document-start
// @license       MIT
// @downloadURL https://update.greasyfork.org/scripts/559208/ChatGPT%20%E9%95%BF%E5%AF%B9%E8%AF%9D%E5%8D%A1%E9%A1%BF%E4%BC%98%E5%8C%96.user.js
// @updateURL https://update.greasyfork.org/scripts/559208/ChatGPT%20%E9%95%BF%E5%AF%B9%E8%AF%9D%E5%8D%A1%E9%A1%BF%E4%BC%98%E5%8C%96.meta.js
// ==/UserScript==

(function () {
  'use strict';

  /************* 🔧 状态参数（可动态修改） *************/
  let KEEP_VISIBLE = 8;
  let HIDE_BEYOND = 10;
  let ENABLE_REMOVE = false;
  let ENABLE_LIVE_RENDER = true;
  let FREEZE_ACTIVE_REPLY = false;
  let PLAN_ENABLED = false;
  let PLAN_ROUNDS = 3;
  let PLAN_PROMPTS = [
    '请总结当前对话的核心要点。',
    '给出下一步最优执行方案。',
    '请输出一份简短、可执行的任务清单。'
  ];
  const BOOT_CHECK_INTERVAL = 500;
  const CHAT_COMPOSER_SELECTOR = '#prompt-textarea.ProseMirror[contenteditable="true"][role="textbox"]';

  const UI_STATE_KEY = 'cgpt_pruner_ui_minimized_v1';
  const PLAN_CONFIG_KEY = 'cgpt_pruner_plan_config_v1';
  /*****************************************************/

  const planState = {
    round: 0,
    promptIndex: 0,
    busy: false,
    runId: 0,
    timer: null,
    message: '未启动',
    tone: 'idle',
    failed: false,
    completed: false
  };

  const completionResponseState = {
    conversationRequestCount: 0,
    requestCount: 0,
    lastSuccessfulRequest: 0
  };

  let renderPlanState = () => {};

  function setPlanStatus(message, tone = 'idle') {
    planState.message = message;
    planState.tone = tone;
    renderPlanState();
    console.log(`[ChatGPT Pruner] ${message}`);
  }

  function clearPlanTimer() {
    if (planState.timer) {
      clearTimeout(planState.timer);
      planState.timer = null;
    }
  }

  function advancePlanPosition(round, promptIndex, promptCount) {
    const nextPromptIndex = promptIndex + 1;
    return nextPromptIndex >= promptCount
      ? { round: round + 1, promptIndex: 0 }
      : { round, promptIndex: nextPromptIndex };
  }

  function isSuccessfulCompletionPayload(payload) {
    return payload && payload.status === 'success';
  }

  console.assert(
    JSON.stringify([
      advancePlanPosition(0, 0, 2),
      advancePlanPosition(0, 1, 2)
    ]) === JSON.stringify([
      { round: 0, promptIndex: 1 },
      { round: 1, promptIndex: 0 }
    ]) &&
    isSuccessfulCompletionPayload({ status: 'success' }) &&
    !isSuccessfulCompletionPayload({ status: 'pending' }),
    '[ChatGPT Pruner] 计划状态机自检失败'
  );

  function installCompletionResponseObserver() {
    const originalFetch = window.fetch;
    if (typeof originalFetch !== 'function' || originalFetch.cgptCompletionObserver) return;

    const observedFetch = async function (...args) {
      const input = args[0];
      const rawUrl = typeof input === 'string' ? input : input && input.url;
      const method = String((args[1] && args[1].method) || (input && input.method) || 'GET').toUpperCase();
      let reportSequence = 0;

      try {
        const pathname = rawUrl && new URL(rawUrl, location.origin).pathname;
        if (method === 'POST' && /\/backend-api\/(?:f\/)?conversation$/.test(pathname)) {
          completionResponseState.conversationRequestCount += 1;
          console.log('[ChatGPT Pruner] 检测到 conversation 提交请求');
        }
        if (pathname === '/backend-api/lat/r') {
          reportSequence = ++completionResponseState.requestCount;
        }
      } catch (_) {}

      const response = await originalFetch.apply(this, args);
      if (reportSequence) {
        response.clone().json().then((payload) => {
          if (isSuccessfulCompletionPayload(payload)) {
            completionResponseState.lastSuccessfulRequest = reportSequence;
            console.log('[ChatGPT Pruner] 检测到 lat/r status=success');
          }
        }).catch(() => {});
      }
      return response;
    };

    Object.defineProperty(observedFetch, 'cgptCompletionObserver', { value: true });
    window.fetch = observedFetch;
  }

  function parsePlanPromptText(raw) {
    return String(raw || '')
      .split(/\r?\n|[;；]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function savePlanConfig() {
    try {
      localStorage.setItem(PLAN_CONFIG_KEY, JSON.stringify({
        enabled: PLAN_ENABLED,
        rounds: PLAN_ROUNDS,
        prompts: PLAN_PROMPTS,
        round: planState.round,
        promptIndex: planState.promptIndex
      }));
    } catch (_) {}
  }

  function loadPlanConfig() {
    try {
      const saved = localStorage.getItem(PLAN_CONFIG_KEY);
      if (!saved) return;
      const parsed = JSON.parse(saved);
      if (!parsed || !Array.isArray(parsed.prompts) || !parsed.prompts.length) return;
      PLAN_ENABLED = Boolean(parsed.enabled);
      PLAN_ROUNDS = Number(parsed.rounds) || PLAN_ROUNDS;
      PLAN_PROMPTS = parsed.prompts.filter(Boolean);
      planState.round = Math.max(0, Number(parsed.round) || 0);
      planState.promptIndex = Math.max(0, Number(parsed.promptIndex) || 0);
    } catch (_) {}
  }

  function getTurns() {
    const turns = Array.from(document.querySelectorAll('[data-testid^="conversation-turn"]'));
    return turns.length
      ? turns
      : Array.from(document.querySelectorAll('[data-message-author-role]'));
  }

  function prune() {
    const turns = getTurns();
    const total = turns.length;
    if (total <= HIDE_BEYOND) return;

    const removeBefore = ENABLE_REMOVE ? total - HIDE_BEYOND : -1;
    const hideBefore = total - KEEP_VISIBLE;

    for (let i = 0; i < total; i++) {
      const el = turns[i];

      if (ENABLE_REMOVE && i < removeBefore && el.dataset.cgptPlanAnchor !== '1') {
        el.remove();
      } else if (i < hideBefore) {
        el.style.display = 'none';
      }
    }
  }

  function findActiveReplyNode() {
    const turns = getTurns();
    if (!turns.length) return null;

    for (let i = turns.length - 1; i >= 0; i--) {
      const turn = turns[i];
      const text = (turn.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const containsStreaming = turn.querySelector('[data-testid*="stream"], [data-message-id], .markdown, .prose') ||
        turn.querySelector('div, p, pre, code');
      if (containsStreaming) return turn;
    }

    return turns[turns.length - 1];
  }

  function freezeActiveReply() {
    if (!FREEZE_ACTIVE_REPLY || !ENABLE_LIVE_RENDER) {
      restoreFrozenReply();
      return;
    }

    const target = findActiveReplyNode();
    if (!target) return;
    if (target.dataset.cgptFrozen === '1') return;

    const childNodes = Array.from(target.childNodes);
    const visibleParent = childNodes.find((node) => node.nodeType === 1 && node.style && node.style.display !== 'none');

    target.dataset.cgptFrozen = '1';
    target.dataset.cgptPrevDisplay = target.style.display || '';
    target.dataset.cgptParentDisplay = visibleParent ? (visibleParent.style.display || '') : '';
    target.style.opacity = '0.001';
    target.style.filter = 'blur(0.2px)';
    target.style.pointerEvents = 'none';
    if (visibleParent) {
      visibleParent.style.display = 'contents';
    }
  }

  function restoreFrozenReply() {
    const frozen = document.querySelectorAll('[data-cgpt-frozen="1"]');
    frozen.forEach((el) => {
      el.style.opacity = '';
      el.style.filter = '';
      el.style.pointerEvents = '';
      el.style.display = el.dataset.cgptPrevDisplay || '';
      delete el.dataset.cgptFrozen;
      delete el.dataset.cgptPrevDisplay;
      delete el.dataset.cgptParentDisplay;
    });
  }

  function monitorLiveRender() {
    if (!FREEZE_ACTIVE_REPLY || ENABLE_LIVE_RENDER) {
      restoreFrozenReply();
      return;
    }

    if (isBotGenerating()) {
      freezeActiveReply();
    } else {
      restoreFrozenReply();
    }
  }

  function startObserver() {
    const observer = new MutationObserver(() => {
      prune();
      monitorLiveRender();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    console.log('[ChatGPT Pruner] Observer started');
  }

  function waitForChat() {
    const timer = setInterval(() => {
      if (getComposer()) {
        clearInterval(timer);
        prune();
        startObserver();
        if (PLAN_ENABLED) {
          const runId = ++planState.runId;
          setPlanStatus(`已恢复计划 · 第 ${planState.round + 1}/${PLAN_ROUNDS} 轮`, 'running');
          planState.timer = setTimeout(() => startPlanLoop(runId), 800);
        }
      }
    }, BOOT_CHECK_INTERVAL);
  }

  function isBotGenerating() {
    if (document.querySelector(
      'button[data-testid="stop-button"], button[data-testid*="stop"], button[aria-label*="Stop streaming"], button[aria-label*="停止流式"], button[aria-label*="停止生成"]'
    )) {
      return true;
    }

    const text = Array.from(
      document.querySelectorAll('button, [role="button"], [data-testid], [aria-label]')
    )
      .map((el) => (el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())
      .join(' ');

    return /(stop generating|stop streaming|停止生成|停止流式|正在生成|生成中|cancel generation)/i.test(text);
  }

  function getTurnsAfter(anchor) {
    const turns = getTurns();
    if (!anchor) return turns;
    const index = turns.indexOf(anchor);
    return index >= 0 ? turns.slice(index + 1) : [];
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getComposer() {
    const composer = document.querySelector(CHAT_COMPOSER_SELECTOR);
    if (!composer || composer.getAttribute('aria-hidden') === 'true') return null;
    const style = window.getComputedStyle(composer);
    return style.display !== 'none' && style.visibility !== 'hidden' ? composer : null;
  }

  function getComposerText(composer) {
    if (!composer) return '';
    return String('value' in composer ? composer.value : composer.textContent || '').trim();
  }

  function fillComposer(composer, text) {
    const value = String(text || '').trim();
    if (!value || !composer || !composer.matches(CHAT_COMPOSER_SELECTOR)) return false;

    try {
      composer.focus();
      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(composer);
        selection.removeAllRanges();
        selection.addRange(range);
      }

      const inserted = document.execCommand('insertText', false, value);
      if (!inserted || getComposerText(composer) !== value) {
        const paragraph = document.createElement('p');
        paragraph.textContent = value;
        composer.replaceChildren(paragraph);
        composer.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          data: value,
          inputType: 'insertText'
        }));
      }
      composer.dispatchEvent(new Event('change', { bubbles: true }));
      return getComposerText(composer) === value;
    } catch (_) {
      return false;
    }
  }

  async function sendPromptText(rawText, runId, conversationRequestCountBeforeSend) {
    const composer = getComposer();
    if (!composer) {
      return { ok: false, reason: '没有找到聊天输入框' };
    }

    const text = String(rawText || '').trim();
    if (!text) return { ok: false, reason: '提示词为空' };

    const turns = getTurns();
    const anchor = turns.length ? turns[turns.length - 1] : null;
    if (anchor) anchor.dataset.cgptPlanAnchor = '1';

    const inputOk = fillComposer(composer, text);
    if (!inputOk) {
      if (anchor) delete anchor.dataset.cgptPlanAnchor;
      return { ok: false, reason: '无法填写聊天输入框' };
    }

    let sendButton = null;
    for (let i = 0; i < 10 && !sendButton; i++) {
      await wait(100);
      if (!PLAN_ENABLED || planState.runId !== runId) {
        if (anchor) delete anchor.dataset.cgptPlanAnchor;
        return { ok: false, reason: '计划已停止' };
      }
      sendButton = Array.from(document.querySelectorAll(
        'button[aria-label*="Send"], button[aria-label*="发送"], button[data-testid*="send"], button[title*="Send"], button[title*="发送"], [data-testid="send-button"], [data-testid="composer-submit-button"]'
      )).find((button) => !button.disabled && button.getAttribute('aria-disabled') !== 'true') || null;
    }

    if (sendButton) {
      sendButton.click();
    } else {
      composer.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true
      }));
      composer.dispatchEvent(new KeyboardEvent('keyup', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true
      }));
    }

    const startedAt = Date.now();
    while (PLAN_ENABLED && planState.runId === runId && Date.now() - startedAt < 12000) {
      if (completionResponseState.conversationRequestCount > conversationRequestCountBeforeSend) {
        return { ok: true, anchor, source: 'conversation 网络请求' };
      }
      if (getTurnsAfter(anchor).length > 0) {
        return { ok: true, anchor, source: '新消息界面' };
      }
      if (isBotGenerating()) {
        return { ok: true, anchor, source: '生成状态' };
      }
      if (!getComposerText(getComposer())) {
        return { ok: true, anchor, source: '输入框已清空' };
      }
      await wait(250);
    }

    if (anchor) delete anchor.dataset.cgptPlanAnchor;
    return { ok: false, reason: '未检测到提交成功信号' };
  }

  function waitForCurrentReplyToFinish(anchor, runId, completionRequestCountBeforeSend) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      let stableSince = 0;
      let lastText = '';

      const tick = () => {
        if (!PLAN_ENABLED || planState.runId !== runId) {
          resolve({ finished: false, source: '计划已停止' });
          return;
        }

        if (completionResponseState.lastSuccessfulRequest > completionRequestCountBeforeSend) {
          resolve({ finished: true, source: 'lat/r' });
          return;
        }

        const generating = isBotGenerating();
        const newTurns = getTurnsAfter(anchor);

        if (newTurns.length >= 2) {
          const latestText = (newTurns[newTurns.length - 1].textContent || '').replace(/\s+/g, ' ').trim();
          if (latestText && latestText !== lastText) {
            lastText = latestText;
            stableSince = Date.now();
          } else if (latestText && !generating && stableSince && Date.now() - stableSince > 2000) {
            resolve({ finished: true, source: 'DOM 稳定' });
            return;
          }
        }

        if (Date.now() - startedAt > 180000) {
          resolve({ finished: false, source: '等待回复超时' });
          return;
        }

        setTimeout(tick, 700);
      };

      tick();
    });
  }

  function failPlan(message) {
    clearPlanTimer();
    PLAN_ENABLED = false;
    planState.busy = false;
    planState.failed = true;
    planState.completed = false;
    savePlanConfig();
    setPlanStatus(`失败：${message}`, 'error');
  }

  function stopPlan() {
    clearPlanTimer();
    PLAN_ENABLED = false;
    planState.busy = false;
    planState.failed = false;
    planState.completed = false;
    planState.round = 0;
    planState.promptIndex = 0;
    planState.runId += 1;
    savePlanConfig();
    setPlanStatus('计划已停止', 'idle');
  }

  function completePlan(completionSource) {
    clearPlanTimer();
    PLAN_ENABLED = false;
    planState.busy = false;
    planState.failed = false;
    planState.completed = true;
    savePlanConfig();
    setPlanStatus(`计划完成 · 共 ${PLAN_ROUNDS} 轮 · ${completionSource}`, 'success');
  }

  function scheduleNextPlanRun(runId, promptCount, completionSource) {
    let remaining = 2;
    const showCountdown = () => {
      setPlanStatus(
        `本轮完成（${completionSource}）· ${remaining} 秒后提交 ${planState.promptIndex + 1}/${promptCount}`,
        'waiting'
      );
    };

    showCountdown();
    clearPlanTimer();
    planState.timer = setInterval(() => {
      if (!PLAN_ENABLED || planState.runId !== runId) {
        clearPlanTimer();
        return;
      }
      remaining -= 1;
      if (remaining <= 0) {
        clearPlanTimer();
        startPlanLoop(runId);
      } else {
        showCountdown();
      }
    }, 1000);
  }

  async function startPlanLoop(runId = planState.runId) {
    if (!PLAN_ENABLED || planState.runId !== runId || planState.busy) return;

    const prompts = parsePlanPromptText(PLAN_PROMPTS.join('\n'));
    if (!prompts.length) {
      failPlan('没有可执行的提示词');
      return;
    }

    if (isBotGenerating()) {
      setPlanStatus('等待当前回复结束后继续', 'waiting');
      clearPlanTimer();
      planState.timer = setTimeout(() => startPlanLoop(runId), 1000);
      return;
    }

    const currentPrompt = prompts[planState.promptIndex % prompts.length];
    if (!currentPrompt) {
      planState.promptIndex = 0;
      failPlan('无法读取当前提示词');
      return;
    }

    planState.busy = true;
    setPlanStatus(
      `第 ${planState.round + 1}/${PLAN_ROUNDS} 轮 · 正在提交 ${planState.promptIndex + 1}/${prompts.length}`,
      'running'
    );

    const conversationRequestCountBeforeSend = completionResponseState.conversationRequestCount;
    const completionRequestCountBeforeSend = completionResponseState.requestCount;
    const sent = await sendPromptText(
      currentPrompt,
      runId,
      conversationRequestCountBeforeSend
    );
    if (!PLAN_ENABLED || planState.runId !== runId) return;
    if (!sent.ok) {
      failPlan(`${sent.reason}，请点击重试计划`);
      return;
    }

    setPlanStatus(
      `第 ${planState.round + 1}/${PLAN_ROUNDS} 轮 · 提交已确认（${sent.source}），等待回复`,
      'running'
    );
    const completion = await waitForCurrentReplyToFinish(
      sent.anchor,
      runId,
      completionRequestCountBeforeSend
    );
    if (sent.anchor) delete sent.anchor.dataset.cgptPlanAnchor;
    if (!PLAN_ENABLED || planState.runId !== runId) return;

    planState.busy = false;
    if (!completion.finished) {
      failPlan(`${completion.source}，请点击重试计划`);
      return;
    }

    Object.assign(
      planState,
      advancePlanPosition(planState.round, planState.promptIndex, prompts.length)
    );
    savePlanConfig();

    if (planState.round >= PLAN_ROUNDS) {
      completePlan(completion.source);
      return;
    }

    scheduleNextPlanRun(runId, prompts.length, completion.source);
  }

  /************* 🪟 浮窗 UI（Shadow DOM + 最小化） *************/
  function createPanel() {
    const host = document.createElement('div');
    host.style.position = 'fixed';
    host.style.bottom = '20px';
    host.style.right = '20px';
    host.style.zIndex = '999999';
    document.body.appendChild(host);

    const shadow = host.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; }
        .panel, .mini {
          background: #111;
          color: #eee;
          border-radius: 10px;
          box-shadow: 0 6px 20px rgba(0,0,0,.4);
          border: 1px solid rgba(255,255,255,.08);
        }
        .panel {
          width: 260px;
          padding: 10px;
          font-size: 12px;
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 8px;
        }
        .title { font-weight: 600; font-size: 12px; opacity: .95; }
        .iconBtn {
          width: 26px; height: 22px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 6px;
          border: 1px solid rgba(255,255,255,.10);
          background: rgba(255,255,255,.06);
          color: #fff;
          cursor: pointer;
          user-select: none;
        }
        .iconBtn:hover { background: rgba(255,255,255,.12); }
        .row { margin-bottom: 8px; }
        label { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
        label.stack {
          display: flex;
          flex-direction: column;
          align-items: stretch;
          gap: 6px;
        }
        input[type="number"] {
          width: 70px;
          background: #1b1b1b;
          color: #fff;
          border: 1px solid rgba(255,255,255,.12);
          border-radius: 6px;
          padding: 4px 6px;
          outline: none;
        }
        textarea {
          width: 100%;
          min-height: 86px;
          resize: vertical;
          background: #1b1b1b;
          color: #fff;
          border: 1px solid rgba(255,255,255,.12);
          border-radius: 6px;
          padding: 6px 8px;
          outline: none;
        }
        input[type="checkbox"] { transform: scale(1.05); }
        button.apply {
          width: 100%;
          margin-top: 6px;
          padding: 6px;
          border-radius: 8px;
          border: 1px solid rgba(255,255,255,.12);
          cursor: pointer;
          background: rgba(255,255,255,.08);
          color: #fff;
        }
        button.apply:hover { background: rgba(255,255,255,.14); }
        button.apply[data-running="1"] { background: #7f1d1d; }
        button.apply[data-running="1"]:hover { background: #991b1b; }
        textarea:disabled, input:disabled { opacity: .55; cursor: not-allowed; }
        .planStatus {
          display: flex;
          align-items: flex-start;
          gap: 7px;
          min-height: 34px;
          margin-top: 8px;
          padding: 7px 8px;
          border-radius: 8px;
          background: rgba(255,255,255,.06);
          line-height: 1.35;
        }
        .statusDot {
          flex: 0 0 auto;
          width: 8px;
          height: 8px;
          margin-top: 4px;
          border-radius: 50%;
          background: #737373;
        }
        .planStatus[data-tone="running"] .statusDot { background: #22c55e; }
        .planStatus[data-tone="waiting"] .statusDot { background: #f59e0b; }
        .planStatus[data-tone="success"] .statusDot { background: #60a5fa; }
        .planStatus[data-tone="error"] .statusDot { background: #ef4444; }
        .hint { opacity: 0.7; font-size: 11px; margin-top: 6px; line-height: 1.3; }

        .mini {
          width: 44px;
          height: 44px;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          user-select: none;
        }
        .mini:hover { background: #171717; }
        .miniDot {
          width: 18px;
          height: 18px;
          border-radius: 6px;
          background: rgba(255,255,255,.14);
          border: 1px solid rgba(255,255,255,.14);
        }

        .hidden { display: none !important; }
      </style>

      <div class="panel" id="panel">
        <div class="header">
          <div class="title">Pruner</div>
          <div class="iconBtn" id="minBtn" title="最小化">—</div>
        </div>

        <div class="row">
          <label>
            <span>真卸载 DOM</span>
            <input type="checkbox" id="removeToggle">
          </label>
        </div>

        <div class="row">
          <label>
            <span>保留最近</span>
            <input type="number" id="keepVisible" min="1">
          </label>
        </div>

        <div class="row">
          <label>
            <span>超过开始处理</span>
            <input type="number" id="hideBeyond" min="1">
          </label>
        </div>

        <div class="row">
          <label>
            <span>实时流式渲染</span>
            <input type="checkbox" id="liveRenderToggle">
          </label>
        </div>

        <div class="row">
          <label>
            <span>冻结当前回复</span>
            <input type="checkbox" id="freezeActiveReplyToggle">
          </label>
        </div>

        <div class="row">
          <label>
            <span>循环轮数</span>
            <input type="number" id="planRounds" min="1">
          </label>
        </div>

        <div class="row">
          <label class="stack">
            <span>提示词列表（每行一条）</span>
            <textarea id="planPrompts" spellcheck="false"></textarea>
          </label>
        </div>

        <button class="apply" id="applyBtn">立即应用</button>
        <div class="planStatus" id="planStatus" data-tone="idle" role="status" aria-live="polite">
          <span class="statusDot"></span>
          <span id="planStatusText">未启动</span>
        </div>
        <button class="apply" id="planBtn">启动计划</button>
        <div class="hint">运行时会自动等待回复并继续下一条；刷新页面后会恢复未完成的计划。</div>
      </div>

      <div class="mini hidden" id="mini" title="展开设置">
        <div class="miniDot"></div>
      </div>
    `;

    const $ = (id) => shadow.getElementById(id);

    function setMinimized(minimized) {
      $('panel').classList.toggle('hidden', minimized);
      $('mini').classList.toggle('hidden', !minimized);
      try { localStorage.setItem(UI_STATE_KEY, minimized ? '1' : '0'); } catch (_) {}
    }

    $('removeToggle').checked = ENABLE_REMOVE;
    $('keepVisible').value = KEEP_VISIBLE;
    $('hideBeyond').value = HIDE_BEYOND;
    $('liveRenderToggle').checked = ENABLE_LIVE_RENDER;
    $('freezeActiveReplyToggle').checked = FREEZE_ACTIVE_REPLY;
    $('planRounds').value = PLAN_ROUNDS;
    $('planPrompts').value = PLAN_PROMPTS.join('\n');

    renderPlanState = () => {
      $('planStatusText').textContent = planState.message;
      $('planStatus').dataset.tone = planState.tone;
      $('planBtn').textContent = PLAN_ENABLED
        ? '停止计划'
        : planState.failed
          ? '重试计划'
          : planState.completed
            ? '重新运行'
            : '启动计划';
      $('planBtn').dataset.running = PLAN_ENABLED ? '1' : '0';
      $('planRounds').disabled = PLAN_ENABLED;
      $('planPrompts').disabled = PLAN_ENABLED;
    };
    renderPlanState();

    $('applyBtn').onclick = () => {
      ENABLE_REMOVE = $('removeToggle').checked;
      KEEP_VISIBLE = Number.parseInt($('keepVisible').value, 10) || KEEP_VISIBLE;
      HIDE_BEYOND = Number.parseInt($('hideBeyond').value, 10) || HIDE_BEYOND;
      ENABLE_LIVE_RENDER = $('liveRenderToggle').checked;
      FREEZE_ACTIVE_REPLY = $('freezeActiveReplyToggle').checked;
      if (ENABLE_LIVE_RENDER || !FREEZE_ACTIVE_REPLY) {
        restoreFrozenReply();
      }
      prune();
      monitorLiveRender();
    };

    $('planBtn').onclick = () => {
      if (PLAN_ENABLED) {
        stopPlan();
        return;
      }

      PLAN_ROUNDS = Number.parseInt($('planRounds').value, 10) || 1;
      PLAN_PROMPTS = parsePlanPromptText($('planPrompts').value);
      if (!PLAN_PROMPTS.length) {
        failPlan('请至少填写一条提示词');
        return;
      }

      if (!planState.failed) {
        planState.round = 0;
        planState.promptIndex = 0;
      }

      planState.busy = false;
      planState.failed = false;
      planState.completed = false;
      PLAN_ENABLED = true;
      const runId = ++planState.runId;
      savePlanConfig();
      setPlanStatus(`已启动 · 第 ${planState.round + 1}/${PLAN_ROUNDS} 轮`, 'running');
      clearPlanTimer();
      planState.timer = setTimeout(() => startPlanLoop(runId), 800);
    };

    $('minBtn').onclick = () => setMinimized(true);
    $('mini').onclick = () => setMinimized(false);

    let initMin = false;
    try { initMin = localStorage.getItem(UI_STATE_KEY) === '1'; } catch (_) {}
    setMinimized(initMin);
  }

  function initializeUi() {
    waitForChat();
    createPanel();
  }

  installCompletionResponseObserver();
  loadPlanConfig();
  if (document.body) {
    initializeUi();
  } else {
    document.addEventListener('DOMContentLoaded', initializeUi, { once: true });
  }
})();
