# Plans and billing

Growth Factory is a desktop app with a subscription. Every plan runs the full factory on your computer.

| | Free | Pro | Business |
|---|---|---|---|
| Price | $0 | $24 a month, or $19 a month billed yearly | $200 a month, or $160 a month billed yearly |
| Brands | 1 | 3 | 15 |
| Clips a month | 20 | Unlimited | Unlimited |
| Posting and scheduling from the app | No (export and post yourself) | Yes | Yes |
| Connected accounts | 0 | 3 | 30 |
| Factory upgrades (builder) | No | No | Yes |

Cloud model and cloud speech costs are separate. You pay OpenRouter or Groq directly with your own key (see [Models and AI settings](models.md)).

## Upgrading

**Settings → Plan and billing** shows your plan, this month's usage and a plan comparison. Choose **Upgrade to Pro** or **Upgrade to Business** (monthly or yearly) to open Stripe Checkout in your browser. The app updates once payment is confirmed; you do not need to restart it. When you reach a limit, the app shows what you hit and offers the upgrade there.

**Manage billing** opens Stripe's billing portal, where you change plan, update your card, download invoices or cancel.

## Cancelling and downgrading

Cancelling takes effect at the end of the period you have paid for. Downgrading **never deletes anything**: every brand, clip and result stays available, and only creating more is blocked. If you have more connected accounts than the plan allows, they stay connected, but posting (including scheduled posts) is held until they fit. See [Missed schedules](posting.md#missed-schedules) for what happens to held times.

## Offline

The app checks your plan when it can. Offline, it keeps your plan for up to **7 days** from the last successful check, then works as Free until it can check again. Signed out, the app works as Free.

## Payment problems

If a payment fails, Stripe retries it and Plan and billing shows "Your last payment failed." with **Fix payment**, which opens the billing portal to update your card. If the subscription ends unpaid, the app works as Free; nothing is deleted.
