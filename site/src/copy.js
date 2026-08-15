// The copy buttons read out of the <pre> blocks in #fallback, which the build
// step filled from install-scrappy.md and voice-setup.md. So what you copy is
// what you'd get from the download — there is no second copy of the text to
// drift out of sync.

const SOURCES = {
  install: "prompt-install",
  voice: "prompt-voice",
};

// navigator.clipboard.writeText doesn't always reject when it can't deliver —
// on an unfocused document it can simply never settle, which would leave the
// button doing nothing at all, forever. Bound the wait and treat a hang as a
// failure so there's always a fallback.
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("clipboard timeout")), ms)),
  ]);
}

async function copyText(text) {
  try {
    await withTimeout(navigator.clipboard.writeText(text), 1200);
    return true;
  } catch {
    // The Clipboard API needs a secure context and a live user gesture. Fall
    // back to the old textarea trick, which asks less of both.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

// Last resort: put the text on the page and select it, so there is always some
// way to get at it. Opening the .md instead would navigate them off the site.
function reveal(pre) {
  const host = document.getElementById("fallback");
  for (const other of host.querySelectorAll("pre")) other.hidden = other !== pre;
  host.hidden = false;
  pre.scrollIntoView({ behavior: "smooth", block: "center" });
  const range = document.createRange();
  range.selectNodeContents(pre);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

for (const button of document.querySelectorAll("[data-copy]")) {
  const id = SOURCES[button.dataset.copy];
  if (!id) continue;

  button.addEventListener("click", async () => {
    const pre = document.getElementById(id);
    const original = button.textContent;
    const ok = await copyText(pre.textContent);
    button.textContent = ok ? "Copied" : "Copy it by hand";
    button.classList.toggle("is-copied", ok);
    if (!ok) reveal(pre);
    setTimeout(() => {
      button.textContent = original;
      button.classList.remove("is-copied");
    }, 1800);
  });
}
