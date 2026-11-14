# Growth Factory website

Static product website, separate from the Mac backend. Plain HTML, CSS and JavaScript; no runtime npm dependency or build step.

## Pages

- `/` — the growth-department overview, production team and illustrative app tour.
- `/product.html` — how Factory, Library, Results and Brand profile connect the daily work.
- `/learning.html` — quality evidence, observations, creative experiments, Style rules and factory-builder upgrades.
- `/download.html` — honest Mac availability, prerequisites and source setup. No public release file is currently linked.

The logo, orange/white palette, Manrope headings and shared navigation are consistent across pages. The Mac app uses the same color family while retaining its native system typography. Illustrative photos and sample metrics are labeled; no website animation is presented as a live agent run or measured audience growth. Loop rehearsal happens inside the app, not a separate promoted web demo.

## Preview and checks

```sh
npm run dev
# http://127.0.0.1:4174/
npm run check
npm test
```

Checks cover local route/asset/anchor resolution, tabs, navigation and release-link honesty. Browser checks cover actual page navigation, mobile menu/Escape, scroll header, overflow and console errors. The download CTA is a direct link to the Mac availability/setup page, rather than an invented download or an empty button.

## Publication

Current public site: https://growth-factory-landing.vercel.app/ . Local changes are preview-only until explicitly published. Keep the existing Vercel project/team configuration; do not create or transfer a deployment from this task. Static deployment includes all four HTML pages, shared CSS/JS, metadata and assets. `vercel.json` supports clean URLs on the hosted site; explicit `.html` links also work in the simple local server.

No Developer ID/notarized release, clean-Mac certification or downloadable artifact is established by this website. A local ad-hoc app build is separate from a public release. Do not add a release URL until the exact reviewed artifact exists and publication is authorized.

Asset provenance and font licenses: [ASSETS.md](ASSETS.md).
