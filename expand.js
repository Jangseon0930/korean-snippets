/**
 * 단축어를 펼친다. 한글로도.
 *
 * 영어권 도구들이 한글에서 안 되는 이유는 하나다. 한글은 자판을 누른 순간
 * 글자가 되지 않는다 — ㅇ → 아 → 안 처럼 **조합 중**인 상태를 거치고, 그
 * 동안 입력 칸에는 아직 확정되지 않은 글자가 떠 있다. 키 입력만 지켜보는
 * 방식은 이 구간에서 아무것도 못 본다.
 *
 * 브라우저는 그 구간의 끝을 알려준다(`compositionend`). 데스크톱 앱은 이걸
 * 못 봐서 "단축어를 치고 핫키를 한 번 더 누르는" 방식을 쓴다. 우리는 브라우저
 * 안에 있으니 핫키 없이, 치는 대로 바꿀 수 있다. 이것이 이 확장이 존재하는
 * 이유 전부다.
 */
(() => {
  "use strict";

  /**
   * 커서 앞의 글자를 이만큼만 본다.
   *
   * 입력 칸 전체를 매번 훑으면 긴 글에서 비싸진다. 단축어는 짧으므로 끝부분만
   * 보면 충분하다.
   */
  const TAIL = 40;

  /** 조합이 끝난 직후인지. 그 순간에만 추가로 한 번 더 살핀다. */
  let justComposed = false;

  /**
   * 지금 우리가 바꾸는 중인지.
   *
   * 우리가 넣은 글자도 input 을 낸다. 막지 않으면 펼친 결과가 또 다른 단축어로
   * 걸릴 수 있다 — `ㅇㄴ` → `안녕하세요` 인데 `세요` 도 단축어라면 끝없이 간다.
   */
  let expanding = false;

  /* ── 무슨 일이 일어나는지 적어두기 ──────────────────────────────── */

  /*
   * 평소에는 꺼져 있다. 팝업에서 켜면 그때부터 이벤트와 판단을 남긴다.
   *
   * 이걸 만든 이유: 시험판에서는 스물한 가지가 통과하는데 진짜 확장에서는
   * 안 되는 일이 있었다. 그때 보지 않고 짐작으로 고치다가 멀쩡히 되던 것까지
   * 망가뜨렸다. 확장 안에서 무엇이 어디서 막히는지 보이면 그럴 일이 없다.
   */
  let debugOn = false;
  const trail = [];
  let flushing = null;

  const short = (text) => String(text ?? "").slice(-14);
  const valueOf = (el) => (isTextField(el) ? el.value : el.textContent);

  function note(what, el) {
    if (!debugOn) return;
    if (isSecret(el) || isSecret(document.activeElement)) return;
    trail.push(what);
    if (trail.length > 60) trail.shift();
    if (flushing) return;
    flushing = setTimeout(() => {
      flushing = null;
      try { chrome.storage?.local?.set({ trail }); } catch { /* 확장 밖 */ }
    }, 200);
  }

  let snippets = [];

  /* ── 지금 편집 중인 곳이 어디인가 ────────────────────────────────── */

  /**
   * 비밀번호 칸은 아예 상대하지 않는다.
   *
   * 2026-11-08 에 진짜로 사고가 났다. 진단을 켜 둔 채로 로그인을 하셨고,
   * 아이디와 비밀번호가 기록에 그대로 찍혀 나왔다. 전에 "비밀번호 칸에서는
   * 켜지 마십시오"라고 적어두긴 했는데, 지키라고 적어두는 것은 막는 것이
   * 아니다. 사람이 조심해서 될 일을 코드에 맡기지 않은 것이 잘못이다.
   *
   * 단축어를 비밀번호 칸에서 쓸 이유도 없다. 읽지도, 바꾸지도, 적지도 않는다.
   *
   * type=password 뿐 아니라 autocomplete 도 본다. "비밀번호 보기"를 켜면
   * type 이 text 로 바뀌는 사이트가 있어서, 그때도 걸러내려는 것이다.
   */
  const isSecret = (el) =>
    el instanceof HTMLInputElement &&
    (el.type === "password" || /password/i.test(el.autocomplete || ""));

  /**
   * 눈에 보이는 칸인가.
   *
   * 2026-11-08, 네이버 블로그 글쓰기에서 알았다. 단축어는 제대로 걸렸고
   * 글자도 들어갔는데 화면에는 아무것도 안 나타났다. 편집기가 한글 입력을
   * 받으려고 **숨겨둔 입력칸**을 두고, 보이는 글쓰기 영역은 따로 그리기
   * 때문이다. 우리는 그 숨은 칸에 쓴 것이고, 쓴 글은 아무도 못 봤다.
   *
   * 안 보이는 곳에 쓰는 것은 아무것도 안 하느니만 못하다. 사용자는 왜 안
   * 되는지 모르고, 그 칸에 남은 글자가 나중에 엉뚱하게 튀어나올 수도 있다.
   *
   * 보이는 칸만 상대한다. 그러면 이런 편집기에서는 조용히 아무 일도 일어나지
   * 않는다 — 고치지 못한 것은 맞지만, 적어도 모르는 데서 망가뜨리지는 않는다.
   */
  function isVisible(el) {
    const box = el.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return false;

    /*
     * 화면 밖으로 밀어둔 칸. 편집기들이 한글 입력을 받으려고 쓰는 수법이고,
     * `left: -9999px` 같은 식이라 크기는 멀쩡하다. 크기만 보면 못 거른다.
     */
    if (box.right <= 0 || box.bottom <= 0) return false;
    if (box.left >= innerWidth || box.top >= innerHeight) return false;

    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.opacity !== "0";
  }

  const isTextField = (el) =>
    !isSecret(el) &&
    isVisible(el) &&
    (el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLInputElement && /^(text|search|email|url|tel)$/.test(el.type)));

  const isEditable = (el) => el instanceof HTMLElement && el.isContentEditable && isVisible(el);

  /* ── 커서 앞의 글자 읽기 ─────────────────────────────────────────── */

  function tailOf(el) {
    if (isTextField(el)) {
      const caret = el.selectionStart ?? el.value.length;
      return el.value.slice(Math.max(0, caret - TAIL), caret);
    }

    const selection = getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return "";

    /*
     * 커서 앞의 글자를, 마디가 어떻게 생겼든 읽는다.
     *
     * 처음에는 커서가 글자 마디 안에 있다고 보고 그 마디만 읽었다. 그랬더니
     * contenteditable 에서 하나도 안 걸렸다 — 커서는 글자 마디가 아니라
     * 요소 사이에 놓일 때가 많고, 지메일이나 블로그 편집기처럼 마디가 잘게
     * 쪼개진 곳에서는 단축어가 두 마디에 걸쳐 있기도 하다.
     *
     * 편집 영역 처음부터 커서까지를 한 덩이로 받아 그 끝만 본다. 마디 구조를
     * 알 필요가 없어진다.
     */
    const upToCaret = document.createRange();
    upToCaret.selectNodeContents(el);
    try {
      const caret = selection.getRangeAt(0);
      upToCaret.setEnd(caret.startContainer, caret.startOffset);
    } catch {
      return "";
    }
    const text = upToCaret.toString();
    return text.slice(Math.max(0, text.length - TAIL));
  }

  /* ── 바꿔 넣기 ───────────────────────────────────────────────────── */

  /**
   * 단축어만큼 지우고 그 자리에 넣는다.
   *
   * `execCommand("insertText")` 를 쓰는 이유가 둘 있다. 되돌리기(⌘Z)가 한 번에
   * 되고, React 같은 틀이 값이 바뀐 것을 알아챈다. `value` 에 직접 넣으면
   * 화면만 바뀌고 틀은 모른 채로 있다가 다음 렌더에서 되돌려 버린다.
   */
  function replace(el, triggerLength, text) {
    if (isTextField(el)) {
      const caret = el.selectionStart ?? el.value.length;
      el.setSelectionRange(caret - triggerLength, caret);
    } else {
      /*
       * 커서에서 왼쪽으로 글자 수만큼 물러난다.
       *
       * 같은 마디 안에서 빼면 될 때가 많지만, 단축어가 마디 경계를 넘어가
       * 있으면 그걸로는 모자란다. Selection.modify 가 글자 단위로 정확히
       * 물러나 주고 마디 경계도 알아서 넘는다.
       */
      const selection = getSelection();
      for (let i = 0; i < triggerLength; i++) {
        selection.modify("extend", "backward", "character");
      }
    }

    const used = document.execCommand("insertText", false, text);
    if (!used) {
      // execCommand 를 막아둔 페이지에서는 직접 넣는다. 되돌리기는 포기한다.
      if (isTextField(el)) {
        const caret = el.selectionStart;
        el.value = el.value.slice(0, caret) + text + el.value.slice(el.selectionEnd);
        const end = caret + text.length;
        el.setSelectionRange(end, end);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return "직접넣음";
      }
      return "실패";
    }
    return "execCommand";
  }

  /* ── 펼칠 때인지 판단 ────────────────────────────────────────────── */

  /**
   * 커서 앞 글자가 어떤 단축어로 끝나는지 본다.
   *
   * 긴 것부터 보는 이유: `;ㅇ` 과 `;ㅇㅈ` 이 둘 다 있을 때 짧은 쪽이 먼저
   * 걸리면 긴 쪽은 영원히 못 쓴다.
   */
  function match(tail) {
    for (const snippet of snippets) {
      if (snippet.trigger && tail.endsWith(snippet.trigger)) return snippet;
    }
    return null;
  }

  function tryExpand(el, why = "") {
    if (expanding) return note({ why, 건너뜀: "바꾸는 중" }, el);
    if (snippets.length === 0) return note({ why, 건너뜀: "단축어 없음" }, el);

    const tail = tailOf(el);
    const found = match(tail);
    if (!found) return note({ why, 끝글자: short(tail), 걸림: null }, el);

    expanding = true;
    let how = "던짐";
    try {
      how = replace(el, found.trigger.length, found.text);
    } finally {
      // 우리가 낸 input 이 지나간 뒤에 푼다.
      setTimeout(() => { expanding = false; }, 0);
    }
    note({ why, 끝글자: short(tail), 걸림: found.trigger, 넣기: how, 결과: short(valueOf(el)) }, el);
  }

  /* ── 언제 살필 것인가 ────────────────────────────────────────────── */

  /*
   * 영어는 글자마다 input 이 오므로 거기서 잡힌다. 한글은 조합이 끝나야
   * 확정되므로 compositionend 뒤에 한 번 더 본다.
   *
   * compositionend 안에서 바로 바꾸면 브라우저가 아직 조합 결과를 넣는
   * 중이라 글자가 섞인다. 한 틱 뒤로 미룬다.
   */
  document.addEventListener("compositionend", (event) => {
    const el = event.target;
    if (!isTextField(el) && !isEditable(el)) return;
    note({ 이벤트: "조합끝", 글자: event.data, 칸: short(valueOf(el)) }, el);
    justComposed = true;
    setTimeout(() => {
      justComposed = false;
      tryExpand(el, "조합끝+1");
    }, 0);
  }, true);

  /*
   * 조합 중에도 본다. 이게 핵심이다.
   *
   * `ㅇㄴ` 은 즉시 펼쳐지는데 `;안녕` 은 한 박자 늦었다. 조합이 음절마다
   * 끝나지 않기 때문이다 — `녕` 은 ㄴ·녀·녕 세 단계를 거치고, 그동안
   * compositionend 는 앞 음절 `안` 에서 한 번 왔을 뿐이다. 그때 칸은 아직
   * ";안ㄴ" 이라 안 걸린다. 그리고 마지막 음절의 조합은 다음 키를 칠
   * 때까지 끝나지 않는다.
   *
   * 그런데 조합 중에도 칸에는 이미 글자가 들어가 있다(";안녕",
   * isComposing=true). 거기서 바로 바꾸면 기다릴 일이 없다. IME 가 뒤늦게
   * 글자를 다시 밀어 넣지 않을까 걱정해서 진짜 자판으로 재 봤고, textarea 와
   * contenteditable 둘 다 아무것도 더 들어오지 않았다(dev/spike-composing.html).
   *
   * 한 번 넣었다가 뺐던 적이 있다(11/02). 확장에서 아예 안 바뀐다는 보고를
   * 받고 되돌렸는데, 11/08 에 그 보고가 **크롬 새 탭 화면**에서 친 것이었음이
   * 드러났다. 거기는 어떤 확장도 못 들어간다. 즉 이 코드가 틀렸다는 증거는
   * 처음부터 없었다. 안 되는 자리에서 재고 코드를 탓한 셈이다.
   */
  document.addEventListener("input", (event) => {
    // 조합이 막 끝난 직후만 미룬다. 그 자리는 compositionend 쪽이 맡는다.
    if (justComposed && !event.isComposing) return;
    const el = event.target;
    if (!isTextField(el) && !isEditable(el)) return;
    note({
      이벤트: "input",
      조합중: !!event.isComposing,
      방금조합끝: justComposed,
      칸: short(valueOf(el)),
      종류: isTextField(el) ? "입력칸" : "편집기",
    }, el);
    tryExpand(el, "input");
  }, true);

  /* ── 단축어 목록 ─────────────────────────────────────────────────── */

  function load() {
    try {
      chrome.storage?.local?.get({ snippets: [], debug: false }, (stored) => {
        snippets = (stored?.snippets ?? [])
          .filter((s) => s?.trigger && s?.text)
          .sort((a, b) => b.trigger.length - a.trigger.length);
        debugOn = !!stored?.debug;
      });
    } catch {
      /* 확장 밖(시험 페이지)에서는 globalThis.NLSnippets 로 넣는다 */
    }
  }

  try {
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area !== "local") return;
      if ("snippets" in changes || "debug" in changes) load();
    });
  } catch {
    /* ignore */
  }

  load();

  // 시험용 입구. 확장 없이도 같은 코드를 돌려볼 수 있어야 한다.
  globalThis.NLSnippets = {
    set(list) {
      snippets = [...list].sort((a, b) => b.trigger.length - a.trigger.length);
    },
    get() { return snippets; },
  };
})();
