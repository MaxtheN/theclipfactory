document.documentElement.classList.add("js");

const demoSteps = [
  {
    eyebrow: "01 / SET THE BRIEF",
    heading: "Your footage.<br />A clear intention.",
    description: "Define the audience, goal, and boundaries. Give your agents a useful place to start.",
    label: "SAMPLE CAMPAIGN BRIEF",
    direction: "Turn a weekend hiking film into short stories for people who want more time outside.",
    tag: "Source footage · Audience · Creative boundaries",
    role: "You → the creative brief",
    note: "Set the context once. Refine it as you go.",
  },
  {
    eyebrow: "02 / CHOOSE THE DIRECTION",
    heading: "One source.<br />A new way in.",
    description: "Agents suggest moments and opening treatments. You choose the idea before production.",
    label: "SAMPLE OPENING TREATMENT",
    direction: "Start with the quiet moment on the ridge, then reveal the wider landscape.",
    tag: "Opening · Pacing · Source moments",
    role: "Strategist → your approval",
    note: "A suggestion, not an automatic decision.",
  },
  {
    eyebrow: "03 / REVIEW THE CUT",
    heading: "A first cut.<br />Your final say.",
    description: "Review the opening, pacing, and captions. Ask for a revision before you approve.",
    label: "YOUR CREATIVE DIRECTION",
    direction: "Open with the feeling of getting away. Let the landscape do the talking.",
    tag: "Warm. Unhurried. A little unexpected.",
    role: "Editor → your review",
    note: "Illustrative workflow. Not a rendered video.",
  },
];

const previewPanel = document.querySelector("#preview-panel");
const tabs = [...document.querySelectorAll("[data-step]")];
let panelAnimation;

function selectStep(index, moveFocus = false) {
  const step = demoSteps[index];
  tabs.forEach((tab, tabIndex) => {
    tab.setAttribute("aria-selected", String(tabIndex === index));
    tab.tabIndex = tabIndex === index ? 0 : -1;
  });
  previewPanel.setAttribute("aria-labelledby", tabs[index].id);
  document.querySelector("#preview-eyebrow").textContent = step.eyebrow;
  // These fragments are fixed site copy, never user input.
  document.querySelector("#preview-heading").innerHTML = step.heading;
  document.querySelector("#preview-description").innerHTML = step.description;
  document.querySelector("#direction-label").textContent = step.label;
  document.querySelector("#direction-text").textContent = step.direction;
  document.querySelector("#direction-tag").textContent = step.tag;
  document.querySelector("#preview-role").textContent = step.role;
  document.querySelector("#preview-role-note").textContent = step.note;
  previewPanel.classList.remove("is-changing");
  cancelAnimationFrame(panelAnimation);
  panelAnimation = requestAnimationFrame(() =>
    previewPanel.classList.add("is-changing"),
  );
  if (moveFocus) tabs[index].focus();
}

tabs.forEach((tab, index) => {
  tab.addEventListener("click", () => selectStep(index));
  tab.addEventListener("keydown", (event) => {
    const keys = {
      ArrowRight:
        (index + 1) % tabs.length,
      ArrowLeft:
        (index + tabs.length - 1) % tabs.length,
      Home: 0,
      End: tabs.length - 1,
    };
    if (event.key in keys) {
      event.preventDefault();
      selectStep(keys[event.key], true);
    }
  });
});

const menuToggle = document.querySelector(".menu-toggle");
const mobileNav = document.querySelector("#mobile-nav");
function closeMenu() {
  menuToggle.setAttribute("aria-expanded", "false");
  menuToggle.setAttribute("aria-label", "Open navigation");
  mobileNav.hidden = true;
  menuToggle.querySelector("use").setAttribute("href", "#i-menu");
}
menuToggle.addEventListener("click", () => {
  const expanded = menuToggle.getAttribute("aria-expanded") === "true";
  menuToggle.setAttribute("aria-expanded", String(!expanded));
  menuToggle.setAttribute(
    "aria-label",
    expanded ? "Open navigation" : "Close navigation",
  );
  menuToggle
    .querySelector("use")
    .setAttribute("href", expanded ? "#i-menu" : "#i-close");
  mobileNav.hidden = expanded;
});
mobileNav
  .querySelectorAll("a")
  .forEach((link) => link.addEventListener("click", closeMenu));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !mobileNav.hidden) {
    closeMenu();
    menuToggle.focus();
  }
});
document.addEventListener("click", (event) => {
  if (!mobileNav.hidden && !event.target.closest(".site-header")) closeMenu();
});
matchMedia("(min-width: 641px)").addEventListener("change", (event) => {
  if (event.matches) closeMenu();
});

const tour = document.querySelector("#workflow-tour");
const tourNext = document.querySelector("#tour-next");
const tourExplore = document.querySelector("#tour-explore");
const tourSteps = [
  {
    kicker: "01 / BRING FOOTAGE & A BRIEF",
    title: "Your source. Your intention.",
    description:
      "Add your footage and define the audience, the feeling, and the point of the campaign. Give your creative team something to work toward.",
    next: "Choose the direction",
  },
  {
    kicker: "02 / CHOOSE THE DIRECTION",
    title: "A new way into the story.",
    description:
      "Explore a creative direction: the opening, the pace, the moments that matter. Review the suggestion and approve the idea before production begins.",
    next: "Review the cut",
  },
  {
    kicker: "03 / REVIEW, REFINE, REPEAT",
    title: "Your taste. The finishing touch.",
    description:
      "Review the first cut, ask for a thoughtful revision, and approve the exact version you want. Bring real observations back into the next creative loop.",
    next: null,
  },
];
let tourIndex = 0;
let tourOpener;
function renderTour() {
  const step = tourSteps[tourIndex];
  document.querySelector("#tour-number").textContent = `0${tourIndex + 1} / 03`;
  document.querySelector("#tour-kicker").textContent = step.kicker;
  document.querySelector("#tour-title").textContent = step.title;
  document.querySelector("#tour-description").textContent = step.description;
  tourNext.hidden = !step.next;
  tourExplore.hidden = Boolean(step.next);
  if (step.next) tourNext.firstChild.textContent = `${step.next} `;
  document
    .querySelectorAll(".tour-dots span")
    .forEach((dot, index) =>
      dot.classList.toggle("active", index === tourIndex),
    );
  selectStep(tourIndex);
}
document.querySelectorAll("[data-open-tour]").forEach((button) =>
  button.addEventListener("click", () => {
    tourOpener = button;
    tourIndex = 0;
    renderTour();
    tour.showModal();
  }),
);
tourNext.addEventListener("click", () => {
  tourIndex = Math.min(tourIndex + 1, tourSteps.length - 1);
  renderTour();
  // When the Next button disappears, move focus to the final action.
  if (tourNext.hidden) tourExplore.focus();
});
document
  .querySelector(".dialog-close")
  .addEventListener("click", () => tour.close());
tour.addEventListener("click", (event) => {
  if (event.target !== tour) return;
  const bounds = tour.getBoundingClientRect();
  if (
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom
  )
    tour.close();
});
tour.addEventListener("close", () => tourOpener?.focus());

if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) =>
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      }),
    { threshold: 0.08 },
  );
  document
    .querySelectorAll(".reveal")
    .forEach((element) => observer.observe(element));
} else {
  document
    .querySelectorAll(".reveal")
    .forEach((element) => element.classList.add("is-visible"));
}
document.querySelector("#year").textContent = new Date().getFullYear();
