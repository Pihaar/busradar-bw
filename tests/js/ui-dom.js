// Shared DOM fixtures + event helpers for the ui-*.test.js suite. Not a test
// file itself — mirrors the detail-panel markup from static/index.html so the
// real ui.js element lookups resolve, and provides a pointer-event dispatcher
// that carries the clientX/clientY/isPrimary/pointerId fields the gesture
// handlers read (happy-dom's PointerEvent constructor drops them otherwise).

// Build the full detail-panel DOM the ui module queries by id. Returns nothing;
// callers read elements via document.getElementById as ui.js does.
export function buildPanelDom() {
  document.body.innerHTML = `
    <input id="search-input" />
    <div id="search-results" hidden></div>
    <section id="detail-panel" aria-expanded="false" inert>
      <div class="detail-handle"><span class="detail-handle-bar"></span></div>
      <div class="detail-header">
        <button id="detail-back">back</button>
        <div id="detail-line"></div>
        <div id="detail-direction"></div>
        <div id="detail-delay"></div>
        <button id="detail-share">share</button>
      </div>
      <nav>
        <button id="tab-stops"></button>
        <button id="tab-departures"></button>
        <button id="tab-arrivals"></button>
      </nav>
      <div id="line-filter" hidden></div>
      <div id="journey-actions" hidden>
        <button id="btn-follow" aria-pressed="false"></button>
        <button id="btn-fitroute"></button>
      </div>
      <div id="detail-content">
        <div id="tabpanel-stops"><ol id="stop-list"><div id="stop-progress"></div></ol></div>
        <div id="tabpanel-departures" hidden><ol id="departure-list"></ol></div>
        <div id="tabpanel-arrivals" hidden><ol id="arrival-list"></ol></div>
      </div>
    </section>
    <dialog id="about-dialog"></dialog>
    <div id="sse-state-indicator" data-state="connecting"></div>
  `;
}

// Point ui.* element references at the freshly-built fixture. ui.init() would
// do this, but most tests exercise a single method without running init.
export function wireUiRefs(ui) {
  ui.panel = document.getElementById('detail-panel');
  ui.detailLine = document.getElementById('detail-line');
  ui.detailDir = document.getElementById('detail-direction');
  ui.detailDelay = document.getElementById('detail-delay');
  ui.stopList = document.getElementById('stop-list');
  ui.departureList = document.getElementById('departure-list');
}

// Dispatch a pointer-family event carrying the fields the handlers read.
// currentTarget is set by dispatchEvent; target is the element dispatched on.
export function firePointer(el, type, props) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, Object.assign({ isPrimary: true, pointerId: 1 }, props));
  el.dispatchEvent(ev);
  return ev;
}

// Make setPointerCapture / releasePointerCapture no-throw on an element
// (happy-dom does not implement them; the gesture handlers call them unwrapped
// for pointerdown and inside try/catch for move/up).
export function stubPointerCapture(el) {
  el.setPointerCapture = () => {};
  el.releasePointerCapture = () => {};
}
