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

/* Orbit: clips fan out of a deck and swirl round the footage on a tilted ring */
const orbit = document.querySelector(".orbit");
if (orbit) {
  const stage = orbit.querySelector(".orbit-stage");
  const rings = orbit.querySelector(".orbit-rings");
  const cards = [...orbit.querySelectorAll(".orbit-card")];
  const count = cards.length;
  const tilt = (-22 * Math.PI) / 180;
  const cosT = Math.cos(tilt);
  const sinT = Math.sin(tilt);
  const smooth = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };

  function layout(progress) {
    // Follow the drawn ring exactly: its ellipse is rx 640 / ry 192 in a 1400-wide viewBox.
    const ringScale = rings ? rings.getBoundingClientRect().width / 1400 : stage.clientWidth / 1500;
    const rx = 640 * ringScale;
    const ry = 192 * ringScale;
    // Starts as a tight deck at the front of the ring, unfurls into a comet, then a full ring.
    const arc = (0.04 + 0.96 * smooth(0.04, 0.6, progress)) * Math.PI * 2 * ((count - 1) / count);
    const lead = Math.PI / 2 + progress * Math.PI * 2.4;
    const tail = 1 - smooth(0.55, 1, progress);
    cards.forEach((card, i) => {
      const t = i / (count - 1);
      const angle = lead - t * arc;
      const x = rx * Math.cos(angle);
      const y = ry * Math.sin(angle);
      const px = x * cosT - y * sinT;
      const py = x * sinT + y * cosT;
      const depth = Math.sin(angle);
      const near = (depth + 1) / 2;
      const comet = 1 - t * tail * 0.5;
      const scale = (0.5 + 0.5 * near) * comet;
      const heading = Math.atan2(ry * Math.cos(angle), -rx * Math.sin(angle)) + tilt;
      const rotate = Math.sin(heading) * 14 + (1 - progress) * (t - 0.5) * 24;
      card.style.transform = `translate(-50%, -50%) translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) rotate(${rotate.toFixed(1)}deg) scale(${scale.toFixed(3)})`;
      card.style.zIndex = String(Math.round(100 + depth * 100));
      card.style.opacity = (0.25 + 0.75 * comet * (0.45 + 0.55 * near)).toFixed(3);
    });
  }

  if (reduceMotion) {
    layout(0.62);
    window.addEventListener("resize", () => layout(0.62));
  } else {
    let queued = false;
    const update = () => {
      queued = false;
      const rect = orbit.getBoundingClientRect();
      const travel = orbit.offsetHeight - window.innerHeight;
      if (rect.bottom < -200 || rect.top > window.innerHeight + 200) return;
      layout(Math.min(1, Math.max(0, -rect.top / travel)));
    };
    const queue = () => {
      if (!queued) {
        queued = true;
        requestAnimationFrame(update);
      }
    };
    window.addEventListener("scroll", queue, { passive: true });
    window.addEventListener("resize", queue);
    layout(0);
    update();
  }
}

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
