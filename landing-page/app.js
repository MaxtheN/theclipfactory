document.documentElement.classList.add("js");

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* Tabs with roving focus and arrow keys. onSelect runs after the switch. */
function setupTabs(tabs, onSelect) {
  function select(index, moveFocus) {
    tabs.forEach((tab, i) => {
      const on = i === index;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      document.getElementById(tab.getAttribute("aria-controls")).hidden = !on;
    });
    if (moveFocus) tabs[index].focus();
    if (onSelect) onSelect(index);
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => select(index, false));
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
  return select;
}

/* Mobile menu */
const menuButton = document.querySelector(".menu-btn");
const mobileNav = document.querySelector("#mobile-nav");
if (menuButton && mobileNav) {
  const setMenu = (open) => {
    menuButton.setAttribute("aria-expanded", String(open));
    menuButton.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    mobileNav.hidden = !open;
  };
  menuButton.addEventListener("click", () => setMenu(mobileNav.hidden));
  mobileNav.addEventListener("click", (event) => {
    if (event.target.closest("a")) setMenu(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !mobileNav.hidden) {
      setMenu(false);
      menuButton.focus();
    }
  });
}

/* Decorative waveform for the Listener */
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

/* Decorative filmstrip in the app window */
const filmstrip = document.querySelector(".filmstrip");
if (filmstrip) {
  for (let i = 0; i < 12; i++) {
    const frame = document.createElement("span");
    frame.style.backgroundPositionX = `${Math.round((i / 11) * 100)}%`;
    filmstrip.append(frame);
  }
}

/* Agents: steps through on its own until someone picks one */
const agentTabs = [...document.querySelectorAll(".agent")];
const railFill = document.querySelector(".rail-fill");
let agentIndex = 0;
let autoplay = null;
let userPicked = false;

const selectAgent = setupTabs(agentTabs, (index) => {
  agentIndex = index;
  agentTabs.forEach((tab, i) => tab.classList.toggle("is-done", i < index));
  if (railFill) railFill.style.width = `${(index / (agentTabs.length - 1)) * 100}%`;
});

function stopAutoplay() {
  clearInterval(autoplay);
  autoplay = null;
}

function startAutoplay() {
  if (reduceMotion || autoplay || agentTabs.length === 0) return;
  autoplay = setInterval(() => selectAgent((agentIndex + 1) % agentTabs.length, false), 3200);
}

if (agentTabs.length) {
  const list = agentTabs[0].closest("[role=tablist]");
  list.addEventListener("pointerdown", () => {
    userPicked = true;
    stopAutoplay();
  });
  list.addEventListener("keydown", () => {
    userPicked = true;
    stopAutoplay();
  });
}

const agentsSection = document.querySelector("#agents");
if (agentsSection && "IntersectionObserver" in window) {
  new IntersectionObserver(
    ([entry]) => {
      if (entry.isIntersecting && !userPicked) startAutoplay();
      else stopAutoplay();
    },
    { threshold: 0.25 },
  ).observe(agentsSection);
}

/* Download buttons: not wired up yet */
document.querySelectorAll("[data-download]").forEach((button) => {
  button.addEventListener("click", (event) => event.preventDefault());
});

/* App window tabs */
setupTabs([...document.querySelectorAll(".app-tabs [role=tab]")]);

/* Reveal fallback when CSS scroll timelines are unavailable */
const supportsScrollTimeline = window.CSS && CSS.supports && CSS.supports("animation-timeline: view()");
if (!supportsScrollTimeline && !reduceMotion && "IntersectionObserver" in window) {
  document.documentElement.classList.add("io");
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.2, rootMargin: "0px 0px -8% 0px" },
  );
  document.querySelectorAll(".rv, .win, .tilt, .grey").forEach((el) => observer.observe(el));
}
