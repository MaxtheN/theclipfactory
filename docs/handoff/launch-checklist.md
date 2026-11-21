# Launch checklist (owner)

The steps only the owner can do, because they need accounts, money, certificates or legal judgement. Do them in this
order; each one unblocks the next. Agents: do not attempt these; prepare and verify around them.

Supabase project: `spdtisizhcepmsogjvnr`. Website: `https://growth-factory-landing.vercel.app` (until a custom
domain).

## 1. Decide the public details

- [ ] **Legal pages.** Read the draft privacy policy and terms in `landing-page/site/pages/privacy.html` and
      `terms.html`. In particular, check the refund wording ("not refundable except where required by law") and the
      30-day notice for price changes. Then run `npm run generate` in `landing-page/`.
- [ ] **Support email.** The site and app use `jamesbodebiyi@gmail.com` (`CONTACT` in `landing-page/site/layout.mjs`).
      Change it there if you want a dedicated address.
- [ ] **Domain.** If you move off `growth-factory-landing.vercel.app`, change these to the new origin:
  - `SITE` in `landing-page/site/layout.mjs`;
  - the `BILLING_RETURN_URL` secret;
  - the Stripe portal's privacy and terms links;
  - the guide's links to the site.

## 2. Stripe, in test mode first

Follow [billing.md § Set up Stripe](../billing.md#set-up-stripe-owner-once):

- [ ] **Products and prices:** Pro at $24 monthly and $228 yearly; Business at $200 monthly and $1,920 yearly. Copy
      the four price ids.
- [ ] **Customer portal:** allow cancelling at the end of the period, switching between the four prices, updating
      cards and viewing invoices. Set the privacy and terms links.
- [ ] **Smart Retries** and the failed-payment emails.
- [ ] **Webhook** to `https://spdtisizhcepmsogjvnr.supabase.co/functions/v1/billing/webhooks/stripe` with the eight
      events listed in billing.md. Copy the signing secret.

## 3. Cloud: migrate, set secrets, deploy

Follow [billing.md § Deploy](../billing.md#deploy). The order matters, because the new `posting` function reads the
billing tables.

- [ ] Apply `supabase/migrations/202611210001_billing.sql`, then run `supabase/tests/billing_rls.sql`. It must end with
      `Billing probes passed; synthetic rows rolled back.`
- [ ] Set the secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, the four `STRIPE_PRICE_*` ids, and
      `BILLING_RETURN_URL` (the website origin).
- [ ] Deploy `billing`, then redeploy `posting`.
- [ ] **Zernio:** move to a paid plan. The free tier allows two connected accounts, and the live smoke test already
      hit that limit. Confirm the webhook still answers `200` ([posting-server.md](../posting-server.md#deploy-and-configure)).

## 4. Website

- [ ] **Vercel project:**
  - root directory `landing-page`;
  - framework "Other";
  - **no build command** (the generated pages are committed);
  - output directory `.`.
- [ ] **After deploy, check:**
  - `/pricing`, `/guide/` and `/architecture`;
  - a made-up URL shows the 404 page;
  - `/billing/success.html` loads.

## 5. Smoke test, in test mode

- [ ] **Upgrade:** in the app, sign in, open Settings → Plan and billing, choose Pro, and pay with `4242 4242 4242 4242`.
      Pro shows within seconds of returning, with no restart.
- [ ] **Webhook:** send a test `customer.subscription.updated` from Stripe and confirm `200`.
- [ ] **Cancel:** in Manage billing, cancel, and confirm the app shows "Cancels on …".
- [ ] **Limits:** on Free, a second brand and posting are blocked, with an upgrade prompt.

## 6. Signing certificates (for WO-38)

- [ ] **Apple:** a Developer Program membership, a "Developer ID Application" certificate, and notarization
      credentials (an App Store Connect API key, or an Apple ID with an app-specific password and team id).
- [ ] **Windows:** Azure Trusted Signing (the practical choice for CI), or a code-signing certificate whose key can
      be exported to a `.pfx`. New certificates from certificate authorities keep the key on hardware, which CI cannot
      use.
- [ ] Add them as GitHub Actions secrets. [releasing.md](../releasing.md#secrets) explains how to get each one:
  - Mac: `MACOS_CERTIFICATE_P12`, `MACOS_CERTIFICATE_PASSWORD`, `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID` and
    `APPLE_API_ISSUER_ID`.
  - Windows, either `WINDOWS_CERTIFICATE_PFX` and `WINDOWS_CERTIFICATE_PASSWORD` (only for an exportable
    certificate), or the Azure Trusted Signing set: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`,
    `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT` and `AZURE_TRUSTED_SIGNING_PROFILE`.
  
  Unsigned builds keep working without them.

## 7. Release

- [ ] **Tag:** follow [releasing.md § Cut a release](../releasing.md#cut-a-release). Set the version, then tag (for
      example `v0.2.0`). `mac-app.yml` and `desktop-apps.yml` build, sign and attach to a draft release. Check that
      each job summary says signed.
- [ ] **Clean installs:** install on a clean Mac, Windows PC and Linux machine, and make one clip on each.
- [ ] **Download links:** add them to the website once the signed assets exist (an agent can do this). Mark
      `v0.1.0-preview` as superseded.

## 8. Go live

- [ ] Repeat §2 in Stripe live mode, then set the live `STRIPE_*` secrets. The webhook signing secret differs per
      mode.
- [ ] Make the first real post from the app on a paid plan, and watch it reach the platform.
- [ ] Buy your own Pro plan with a real card, then refund it from Stripe, to prove the live path.
