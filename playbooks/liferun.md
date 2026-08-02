# Liferun — Build Tasks (per department)

**Mid-engagement playbook · May–Jul 2026 (status) + Aug–Oct 2026 (build).** GHL build complete (July). Google + Meta both live and driving calls. IG connected.
**Measured on cost-per-activated-subscriber — not clicks, not leads.** Departments report to **Nacer (Ops)**; client POC is **Sohib (Account/Owner)**.
**⛔ = launch/scale blocker** (blocks scaling, breaks attribution, or leaks money — clear these first).

**Compliance — all ad + web copy:** no guaranteed-response or life-saving claims · no "best / #1 / medical-grade" without substantiation · disclaimers on testimonials · Meta personal-attributes/health policy — never imply the viewer's (or their parent's) condition ("Has your mom fallen?" trips it; phrase around it) · senior-targeted = plain language, large type, phone number prominent.

---

## CRM & Automation — GHL
**Lead:** Ahmed Memon + Ali Shaheer (post-handoff: Hashir/Digital Cordex → Munib/Khurram → Ahmed + Ali, July)

**▸ Done / inherited (May–Jul)**
- Device Fulfilment pipeline live: Order Placed → Activate → QA Check → Ready to Ship → Shipped → Active
- Two order-intake paths: WordPress/Stripe webhook via Zapier (full field mapping) + new GHL Products Payment - BWS (opportunity only)
- FreeUS activation via Vercel proxy; Becklar setup tasks; Shippo label Zaps; Replacement flow confirmed (Apr 22)
- Stripe payment products in GHL — QA'd, test payment passed, **Done July 20**
- Handoff Loom (Khurram) reviewed; HANDOFF item open — finish absorbing the June 22 Automation Guide

**▸ Gap closure — DONE (Aug)**
- GHL build complete: Becklar deactivation, Return automation, BWS field mapping, Shippo flow, QA reroute — built

**▸ Verify the money paths** · Aug–Sep (built ≠ verified — these two leak cash silently if wrong)
- ⛔ Becklar billing drop: run one dummy deactivation → confirm the device drops in the Becklar portal AND the next Becklar invoice reflects it
- ⛔ BWS duplicate check: one live order through each intake path → confirm exactly one opportunity per order, fully field-mapped
- One Shippo label end-to-end with zero manual input; lock the SOP for Sameera/Kenneth
- Define fallback for the label email when a customer has no email on file (open since Mar 31)

**▸ Phone-order payment build** · Aug–Sep
- Cards on file: CS (Cebu) saves card to contact → creates subscription from the Payments tab
- Price variants on the monitoring product for signup add-ons ("Monitoring + Fall Detection" combined price); subscription-modify flow reserved for mid-life upsells only (no proration — next cycle)
- Text-to-Pay for mid-call orders where the customer self-pays
- ⛔ CS permissions audit: subscription + invoice creation ON; refund, delete, Stripe dashboard access OFF (refunds stay with Abdullah)
- SOP + Loom for the Cebu team on the full card-on-file flow

**▸ Retention & reviews** · Sep–Oct
- Post-activation review-request automation (timed after Tony's 1-week delivery check-in) + Google review link
- Re-engagement cadence for unconverted leads; missed-call-text-back if not live
- Feed activation + churn data to Nacer for the monthly report

*Needs:* BWS answers + WP test checkout URL (Sohib) · return policy final (Sohib/Am Ahmed) · VPN access for Becklar
*Done =* no live device billed after deactivation/return; one clean opportunity per order fully field-mapped; Cebu team charging phone orders in GHL without touching Stripe.

---

## Google Ads
**Lead:** Ads Team

**▸ Done (May–Aug)**
- Campaigns live since late April; conversion tracking verified; calls coming in from the channel

**▸ Tracking to revenue** · Aug–Sep
- ⛔ Import activated-subscriber conversions from GHL back into Google — bid to activations, not calls or form-fills; QA with test conversions
- Call conversions: confirm inbound calls are counted and attributed per campaign (calls are landing — make sure Google gets credit for the ones that activate)
- Confirm checkout/purchase events still fire after the June 19 checkout page changes

**▸ Structure & copy pass** · Aug–Sep
- Separate campaigns: brand / high-intent generic ("medical alert watch," "fall detection device") / competitor (Life Alert, Medical Guardian, Bay Alarm) / caregiver ("medical alert for mom")
- Negative seed: free government, Medicare-covered (unless offer exists), jobs, "how to," DIY, kids/child, smartwatch generic (Apple Watch intent)
- RSAs lead with the offer (annual = free device, $29.95/mo, 30-day money-back) + call assets, price/callout/sitelink assets; phone number in copy
- Ad ↔ landing page message match per campaign, set page-by-page with Web

**▸ Scale** · Sep–Oct
- Scale/cut by cost-per-activated-subscriber once offline import has data
- Test PMax only after conversion import is clean

*Needs:* landing pages per campaign (Web) · offline conversion feed (CRM) · offer confirmation (Account)
*Done =* Google optimizing to activated subscribers at target cost, phone + web orders both attributed.

---

## Meta Ads
**Lead:** Ads Team

**▸ Done (May–Aug)**
- Campaign live since late April; IG connected; channel producing calls

**▸ Tracking & account hygiene** · Aug–Sep
- Confirm the Apr 29 wrong-button pixel fix in Events Manager (purchase event on the correct button — one test order)
- ⛔ CAPI live, not just pixel; domain verification confirmed
- Build audiences: site visitors, video viewers, engagers, customer-list upload (with consent) → lookalikes

**▸ Creative rollout** · Aug–Sep
- Deploy the Belle W batch: 4 UGC (Interview hook only — slapstick presets are tonal mismatches) + 2 kinetic typography spots (delivered, 1080×1920)
- Generate the custom senior avatar in Higgsfield for direct-to-senior creatives (library skews young)
- Two audience tracks: adult daughter 45–65 (peace-of-mind angle) primary; senior-direct secondary
- ⛔ Personal-attributes policy on every creative; tone = reassurance, not fear
- Retargeting on site visitors + video viewers day one of clean tracking

**▸ Scale** · Sep–Oct
- Scale by contribution to activations; refresh creative before fatigue (next Higgsfield batch)
- Test lookalikes off the customer list

*Needs:* IG account (Sohib) · creative batch specs (Creative) · pixel events (Web/CRM)
*Done =* purchase tracking verified, retargeting recovering non-buyers, caregiver prospecting at acceptable cost per activation.

---

## Web / SEO
**Lead:** Hashir + Zayan (Digital Cordex — still on Web/SEO; off GHL only)

**▸ Done (May–Jul)**
- Chat widget live (A2P compliance) · SEO May report delivered · Checkout page updated June 19 (expired coupon removed, annual = free device, $29.95 pricing, device-page image) · GBP item opened July 15

**▸ Site & conversion pass** · Aug
- Verify the Feb punch list fully closed: menu consistency, form placeholders, single product, correct pricing everywhere
- Dedicated paid landing pages (caregiver vs senior-direct) — stop sending paid traffic to the homepage; phone number huge, offer in the headline, one CTA per page
- Message match with Google + Meta per campaign; click-to-call + tap-to-text on mobile
- Confirm form → GHL capture + UTM passthrough survives the checkout changes; ⛔ re-test pixels/events after any page edit
- Trust block: 30-day money-back, no contracts, lifetime price lock, testimonials with disclaimers

**▸ GBP & local** · Aug–Sep
- GBP fill: categories, services, photos, hours; weekly posting cadence (subitem already open)
- Review link wired to the CRM review automation

**▸ SEO & content** · Sep–Oct
- Monthly SEO report cadence (June/July reports owed)
- Bottom-funnel comparisons ("Liferun vs Life Alert / Medical Guardian"), caregiver guides, AEO: direct answers up top, FAQ blocks, schema (Product, FAQ, Review)
- Page-speed pass on the money pages

*Needs:* offer + testimonial approvals (Account) · event specs (CRM/Ads)
*Done =* paid traffic landing on match-built pages that convert by phone or checkout; GBP active; organic comparisons ranking.

---

## Creative
**Lead:** Sohib + editor (Higgsfield)

**▸ Done (May–Jul)**
- Belle W batch scoped: 4 UGC + 2 kinetic/product; 2 kinetic typography MP4s rendered + delivered (9:16, Apple-commercial style, senior-readable type)

**▸ Produce the batch** · Aug
- Generate the 4 UGC ads per spec sheets (avatar, hook, setting, style, prompt per ad — Interview hook only)
- Build the custom senior avatar before senior-direct UGC
- Handoff package per ad: file + text beats + editor instructions

**▸ Refresh cycle** · Sep–Oct
- New batch monthly off Meta performance data; retire fatigued creative
- Add product-only footage (watch avatar auto-attach limitation — QA every render)

*Done =* steady creative supply so Meta never runs stale.

---

## Account — Sohib

**▸ Run the account** · Ongoing
- Answer Ahmed's two BWS questions + provide WP test checkout URL (blocking CRM now)
- Create Liferun Instagram → hand to Ads Team (blocking Meta)
- Finalize return/refund policy with Am Ahmed (30-day money-back framework) — feeds Return Automation + all ad copy
- Confirm offer stack for Q3 copy: annual = free device, $29.95, 30-day guarantee
- Monthly review; scale/cut calls on cost-per-activated-subscriber

## Ops — Nacer

**▸ Run delivery** · Ongoing
- Timelines + gate sign-off across CRM, Ads, Web, Creative; monthly report off activation data
- Chase the two client blockers (BWS answers, IG) weekly until cleared
- Credential rotation post-Cordex-handoff: WordPress, SiteGround, Shippo, Zapier, Watch-Run — plaintext logins circulated in the old handoff PDF; coordinate with Naz
- Loom SOP library (old Admin item, still open): payments, labels, Becklar, returns — one per workflow as each gets verified

**▸ Stack re-test** · end of Aug
- ⛔ One end-to-end test after the Aug fixes: test order each path → single opportunity, fully mapped → activation → Shippo label untouched → deactivation → Becklar drop + billing confirmed → conversion lands in Google + Meta

---

## Sequence at a glance
| | May–Aug (done) | Aug–Sep | Sep–Oct |
|---|---|---|---|
| CRM (GHL) | Handoff, Stripe products, all 5 gaps built | Verify money paths ⛔ + phone-order build | Reviews + re-engagement |
| Google Ads | Live, tracking verified, calls coming | Offline conversion import + call attribution | Scale by cost/activation |
| Meta Ads | Live, IG connected, calls coming | CAPI + audiences + deploy batch | Scale + lookalikes |
| Web / SEO | Checkout fixed, widget, May report | Paid landing pages + GBP | Content + AEO compound |
| Creative | 2 kinetic delivered, batch scoped | Produce UGC ×4 + senior avatar | Monthly refresh |
| Ops | — | Credential rotation + stack re-test ⛔ | Monthly reporting rhythm |

**Do not scale spend until:** Google offline conversion import live · CAPI live · Becklar billing drop verified · BWS single-opportunity verified · end-to-end stack re-test passed.

---

## Client to-do (Nacer collects — client = Sohib)
**Decisions:** final return/refund policy (with Am Ahmed) · offer stack confirmation · testimonials/results approved for ads · Cebu intake coverage hours confirmed.
**Time:** weekly check with Nacer · monthly review.