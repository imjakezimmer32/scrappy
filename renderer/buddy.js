(() => {
  const stage = document.getElementById('stage');
  const buddy = document.getElementById('buddy');
  const status = document.getElementById('status');
  const testBtn = document.getElementById('test');

  let alerting = false;
  let settling = false;
  let growTimer = null;
  let scale = 0.55;
  const calmScale = 0.55;
  const maxScale = 2.35;
  const growStep = 0.045;
  const growEveryMs = 420;

  function setScale(next) {
    scale = next;
    document.documentElement.style.setProperty('--buddy-scale', String(scale));
  }

  function setStatus(text) {
    status.textContent = text;
  }

  function stopGrowLoop() {
    if (growTimer) {
      clearInterval(growTimer);
      growTimer = null;
    }
  }

  function startGrowLoop() {
    stopGrowLoop();
    growTimer = setInterval(() => {
      if (!alerting) return;
      if (scale < maxScale) {
        setScale(Math.min(maxScale, scale + growStep));
        const pct = Math.round(((scale - calmScale) / (maxScale - calmScale)) * 100);
        setStatus(`Time to work again — ${Math.max(0, pct)}% noticed`);
      } else {
        setStatus('I’m huge now. Click me when you’re back!');
      }
    }, growEveryMs);
  }

  function beginAlert(payload = {}) {
    settling = false;
    alerting = true;
    stage.classList.add('is-alerting');
    setScale(Math.max(scale, 0.85));
    setStatus(payload.title ? `${payload.title} — click when back` : 'Agent finished — click when you’re back');
    startGrowLoop();
  }

  function dismiss() {
    if (settling) return;
    if (!alerting && scale <= calmScale + 0.01) return;
    settling = true;
    alerting = false;
    stopGrowLoop();
    stage.classList.remove('is-alerting');
    setStatus('Nice. Back to waiting…');
    const start = scale;
    const t0 = performance.now();
    const dur = 420;
    function tick(now) {
      const t = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      setScale(start + (calmScale - start) * eased);
      if (t < 1) requestAnimationFrame(tick);
      else settling = false;
    }
    requestAnimationFrame(tick);
    try {
      window.workbuddy.ack();
    } catch (_) {}
  }

  buddy.addEventListener('click', () => {
    dismiss();
  });

  testBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    try {
      if (window.workbuddy && typeof window.workbuddy.testGrow === 'function') {
        window.workbuddy.testGrow();
      } else {
        beginAlert({ title: 'Test grow' });
      }
    } catch (_) {
      beginAlert({ title: 'Test grow' });
    }
  });

  if (window.workbuddy) {
    window.workbuddy.onGrow((payload) => beginAlert(payload || {}));
    window.workbuddy.onAck(() => {
      // Main process may broadcast ack; only settle UI if still alerting.
      if (alerting) {
        settling = true;
        alerting = false;
        stopGrowLoop();
        stage.classList.remove('is-alerting');
        setStatus('Nice. Back to waiting…');
        const start = scale;
        const t0 = performance.now();
        const dur = 420;
        function tick(now) {
          const t = Math.min(1, (now - t0) / dur);
          const eased = 1 - Math.pow(1 - t, 3);
          setScale(start + (calmScale - start) * eased);
          if (t < 1) requestAnimationFrame(tick);
          else settling = false;
        }
        requestAnimationFrame(tick);
      }
    });
  }

  setScale(calmScale);
})();
