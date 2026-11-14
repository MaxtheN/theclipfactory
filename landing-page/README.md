# Growth Factory landing page

Standalone public marketing site, separate from the desktop workspace and backend.
Plain HTML, CSS, and JavaScript; **no build step or runtime npm dependencies**.
Fonts and imagery are served locally. No analytics, trackers, or third-party embeds.

Production: https://growth-factory-landing.vercel.app
Vercel project: `growth-factory-landing`, team `nurislombeks-projects`.

## Preview and verify

```sh
npm run dev  # http://127.0.0.1:4174
npm run check
npm test

# Browser regression and accessibility checks
npm ci
npx playwright install --with-deps chromium firefox webkit
npm run test:browser
```

Browser coverage includes small mobile through wide desktop, both tab groups,
mobile navigation/focus, setup links, native FAQ disclosures, persistent motion
controls, live reduced-motion changes, denied storage, no-JavaScript readability,
local asset loading, and automated WCAG accessibility scans. A clean scan is not a
claim of complete accessibility conformance; manual review is still necessary.

## Honest product preview

The main CTA leads to the source setup instructions for Apple Silicon Macs. Do not
label it a binary download until a verified public release exists. The alpine
imagery and editing screens are illustrative; performance data is synthetic.
The page distinguishes local processing from optional cloud/publishing transfers.
See the repository README for current live-verification gates.

Agents advance only on user input. Both tab groups support Left/Right, Home/End,
and a single tab stop, followed by the panel. All panels are readable without JS.
The motion switch is available in the header, uses optional localStorage, and
always respects the OS reduced-motion setting. FAQ uses native `details`.

## Deploy

Deploy this folder as a static Vercel project with no framework, install command,
or build command. Keep this identity separate from `theclipfactory-frontend`.
`vercel.json` defines headers. Tests, source documentation, generated previews,
and npm development tooling are excluded by `.vercelignore`.

Asset provenance and font license are in `ASSETS.md` and
`assets/BricolageGrotesque-OFL.txt`.
