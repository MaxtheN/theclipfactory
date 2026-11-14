document.documentElement.classList.add("js");

/* Enhance readable HTML into keyboard-operated tabs. Nothing auto-advances. */
function setupTabs(tabs, onSelect) {
  function select(index, moveFocus = false) {
    tabs.forEach((tab, i) => {
      const selected = i === index;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      document.getElementById(tab.getAttribute("aria-controls")).hidden = !selected;
    });
    if (moveFocus) tabs[index].focus();
    if (onSelect) onSelect(index);
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => select(index));
    tab.addEventListener("keydown", (event) => {
      const keys = {
        ArrowRight: (index + 1) % tabs.length,
        ArrowLeft: (index + tabs.length - 1) % tabs.length,
        Home: 0,
        End: tabs.length - 1,
      };
      if (event.key in keys) {
        event.preventDefault();
        select(keys[event.key], true);
      }
    });
  });
  if (tabs.length) select(0);
  return select;
}

/* Mobile navigation closes on selection, Escape, outside interaction, or resize. */
const menuButton = document.querySelector(".menu-btn");
const mobileNav = document.querySelector("#mobile-nav");
const desktop = window.matchMedia("(min-width: 761px)");
if (menuButton && mobileNav) {
  const setMenu = (open) => {
    menuButton.setAttribute("aria-expanded", String(open));
    menuButton.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    mobileNav.hidden = !open;
  };
  menuButton.addEventListener("click", () => setMenu(mobileNav.hidden));
  mobileNav.addEventListener("click", (event) => {
    const link = event.target.closest("a");
    if (!link) return;
    setMenu(false);
    // Do not strand keyboard focus in the collapsed navigation.
    const target = document.querySelector(link.getAttribute("href"));
    if (target) {
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !mobileNav.hidden) {
      setMenu(false);
      menuButton.focus();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!mobileNav.hidden && !event.target.closest(".site-header")) setMenu(false);
  });
  document.addEventListener("focusin", (event) => {
    if (!event.target.closest(".site-header")) setMenu(false);
  });
  desktop.addEventListener("change", (event) => {
    // Use the delivered transition, not a newer viewport state.
    if (event.matches) setMenu(false);
  });
}

/* Pause all decorative motion. OS preferences always win; storage is optional. */
const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
const motionButtons = [...document.querySelectorAll(".motion-toggle")];
let manuallyPaused = false;
try {
  manuallyPaused = localStorage.getItem("growth-factory-motion") === "paused";
} catch { /* Private/embedded contexts can deny storage. */ }
function updateMotion() {
  const paused = manuallyPaused || motionPreference.matches;
  document.documentElement.classList.toggle("motion-paused", paused);
  motionButtons.forEach((button) => {
    button.hidden = false;
    button.setAttribute("aria-pressed", String(paused));
    button.textContent = motionPreference.matches ? "Motion reduced" : paused ? "Resume motion" : "Pause motion";
    button.disabled = motionPreference.matches;
  });
}
motionButtons.forEach((button) => button.addEventListener("click", () => {
  manuallyPaused = !manuallyPaused;
  try {
    localStorage.setItem("growth-factory-motion", manuallyPaused ? "paused" : "playing");
  } catch { /* The control still works without persistence. */ }
  updateMotion();
}));
motionPreference.addEventListener("change", updateMotion);
updateMotion();

/* Decorative sample assets, deliberately deterministic. */
const wave = document.querySelector(".wave");
if (wave) {
  for (let i = 0; i < 48; i++) {
    const bar = document.createElement("span");
    bar.style.height = `${25 + Math.round(70 * Math.abs(Math.sin(i * 0.7) * Math.cos(i * 0.21)))}%`;
    bar.style.animationDelay = `${((i % 8) * 0.09).toFixed(2)}s`;
    if ((i > 8 && i < 18) || (i > 28 && i < 36)) bar.classList.add("hot");
    wave.append(bar);
  }
}
const filmstrip = document.querySelector(".filmstrip");
if (filmstrip) {
  for (let i = 0; i < 12; i++) {
    const frame = document.createElement("span");
    frame.style.backgroundPositionX = `${Math.round((i / 11) * 100)}%`;
    filmstrip.append(frame);
  }
}

const agentTabs = [...document.querySelectorAll(".agent")];
const railFill = document.querySelector(".rail-fill");
setupTabs(agentTabs, (index) => {
  agentTabs.forEach((tab, i) => tab.classList.toggle("is-done", i < index));
  if (railFill) railFill.style.width = `${(index / Math.max(1, agentTabs.length - 1)) * 100}%`;
});
const appTabs = [...document.querySelectorAll(".app-tabs [role=tab]")];
const selectApp = setupTabs(appTabs);
document.querySelectorAll("[data-app-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    const index = appTabs.findIndex((tab) => tab.id === `app-tab-${button.dataset.appTab}`);
    if (index >= 0) selectApp(index, true);
  });
});
