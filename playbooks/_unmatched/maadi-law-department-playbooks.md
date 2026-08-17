<!-- modifiedTime: 2026-08-17T18:05:25.000Z -->
# Maadi Law — Build Tasks (per department)

Start July 1 · 6 months. Ad spend: ~$5,000 Google + ~$1,500 Meta/mo (direct to platforms). Measured on **cost-per-signed-case** — not clicks, not leads. Departments report to Nacer (Ops); client POC is Sohib (Account). ⛔ = launch blocker (blocks go-live or breaks attribution — clear these first).

**Compliance — all ad + web copy:** no result guarantees · no "best / #1 / expert / specialist" without certification · disclaimers on testimonials + past results · follow Google + Meta legal-ad policies.

---

## CRM & Automation — GHL

**Lead:** ________

### ▸ Replace Clio Grow · Month 1
- Audit the current Clio Grow workflow (forms, pipelines, automations) before sunset
- Confirm Clio Manage integration method — native vs Zapier vs API/webhook
- Build GHL to push directly into Clio Manage (system of record)
- Rebuild Grow's forms, pipelines, and automations in GHL
- Pipeline stages + user accounts/permissions for the firm's intake team
- Decommission Grow once GHL is live and verified

### ▸ Messaging setup · Month 1
- ⛔ A2P 10DLC brand + campaign registration — no SMS until approved (days–weeks)
- ⛔ Email auth: SPF / DKIM / DMARC — or nurture emails hit spam

### ▸ Routing & speed-to-lead · Month 1
- Route by source + case type; instant assignment
- First contact under 5 min in business hours
- After hours: instant auto-reply + next-morning callback queue
- 24/7 AI chat intake (with Web)
- Missed-call-text-back + follow-up cadence for unconverted leads
- Provision tracking phone numbers + calendar/booking for consults

### ▸ Tracking · Month 1
- Call tracking + dynamic numbers per channel
- UTM standard; form + chat capture
- Wire conversion events back to Google + Meta (Web installs pixels)
- Test a lead end-to-end into Clio Manage before go-live

### ▸ Maintain · Months 2–3
- Keep tracking clean as traffic turns on
- Post-matter review-request automation
- Review widget + Google review link wired to the automation
- Feed signed-case data to Nacer for the monthly report

### ▸ Nurture · Months 4–6
- Referral + review nurture sequences, incl. referral-partner gift automation
- Re-engagement sequences for unconverted leads

**Needs:** pixels + AI chat widget on site (Web) · intake coverage confirmed (Account/client)

**Done =** every lead captured, source-tagged, routed under 5 min, written into Clio Manage, traceable to a signed case.

---

## Google Ads / LSA

**Lead:** ________

### ▸ LSA verification · Month 1 (start Day 1)
- Submit verification immediately — takes 3–4 weeks and gates launch
- Set practice-area toggles: target case types only, exclude nuisance categories

### ▸ Market recon · Month 1
- From a local Orland Park geo: who holds the 3 LSA slots, who's buying the top search ads
- Lock targeting only after recon

### ▸ Tracking & account setup · Month 1
- Conversion actions + Google tag / GTM install
- Link GA4 + GBP + LSA to the ads account
- ⛔ Offline conversion import — push signed cases from CRM back into Google (so bidding optimizes to cases, not form-fills)
- Conversion-tracking QA with test conversions

### ▸ LSA live · Months 2–3
- Go live on approval
- LSA profile fill: photos, hours, service areas, bio, weekly budget, lead types
- Dispute wrong-number / solicitor / out-of-area leads within 24h, with call recordings (weekly)
- Drive review velocity with GHL (reviews + answer rate = ranking, not budget)

### ▸ Search build · Months 2–3
- Separate campaign per case type (auto, truck, slip/fall…) — never one bucket
- Exact/phrase on money terms; broad only heavily filtered
- Negative-keyword list + prune search terms weekly
- Geo radius 10–25 mi; location setting = "Presence" (not "Presence or interest"); add area place-names as keywords for locally-injured searchers
- RSA ad copy + sitelink / callout / call / location assets
- Bid strategy (tCPA or max-conversions w/ target) + ad schedule
- Point each ad group at its matched landing page (from Web)
- Message match: each ad's headline mirrors the keyword and its landing-page headline — set page-by-page with Web
- RSA headline/CTA testing ("No Win, No Fee" vs "Maximum Compensation"; "Free Case Evaluation" vs "Speak to an Attorney") — one variable at a time, run to significance
- Flag any low-converting ad↔page pair to Web for a page-side fix
- Import conversions from GHL; optimize weekly

### ▸ Scale · Months 4–6
- Scale winners / cut losers by cost-per-signed-case
- Keep disputes + review velocity running

**Negative seed:** free, pro bono, self-represent, DIY, salary, jobs, "how to become," law school, workers' comp (if excluded), criminal, family, competitor names.

**Needs:** landing pages (Web) · tracking + conversions (GHL) · verification docs (client via Nacer)

**Done =** LSA ranking in the local 3-pack + Search delivering tracked signed cases at target cost.

---

## Meta Ads

**Lead:** ________
**Scope:** retargeting + brand/awareness only. Not cold lead-gen at this budget.

### ▸ Account & tracking setup · Months 2–3 (do before launch)
- ⛔ Conversions API (CAPI) live — not just the pixel
- Domain verification + Aggregated Event Measurement config
- Account billing / payment + spend limit
- Build custom audiences: site visitors, video viewers, engagers, client-list upload
- Events Manager QA (test events firing)

### ▸ Pre-build · Months 2–3
- Check competitor Meta Ad Library before building creative

### ▸ Launch · Months 2–3
- Retargeting live day one of paid (site + LSA visitors who didn't convert)
- Brand/awareness video + Reels (attorney on camera) — creative with Web/SEO
- Lookalikes off the past-client list (with consent)
- Destination page must match the ad's message + offer (message match)
- Campaign structure (CBO/ABO) + placements
- ⛔ Personal-attributes policy — don't imply the viewer's situation ("Were you injured?" trips it); phrase around it
- Tone: empathy and reassurance, not "call now"
- Bar-compliant disclaimers on every ad

### ▸ Scale · Months 4–6
- Scale retargeting + brand by contribution
- Refresh creative before fatigue

**Needs:** pixel + audiences (GHL/Web) · video assets (Web/SEO shoot)

**Done =** retargeting recovering lost visitors; brand keeping the firm top-of-mind so Search converts harder.

---

## Web / SEO (incl. content + shoots)

**Lead:** ________

### ▸ Site rebuild · Month 1
- Rebuild site, mobile-first, under 3s load (design bar = Sharif's reference site)
- ⛔ 301 redirect map from the old site — or existing rankings are lost
- One landing page per case type and per geo (Orland Park + suburbs + landmarks: I-80, La Grange Rd, 159th St, Orland Square Mall) — each maps 1:1 to an ad group
- Conversion paths: short mobile forms, click-to-call, 24/7 AI chat, trust signals up top, one CTA per page
- Form spam protection (reCAPTCHA / honeypot) + form→CRM connection test
- Optimize GBP (categories, service areas, NAP consistency, photos, review-ask)
- Spanish pages (Arabic where relevant) + hreflang tags
- Install Google + Meta pixels (GHL wires the events)
- Privacy policy / TOS / cookie-consent pages
- ADA / WCAG accessibility basics

### ▸ CRO — build · Month 1
- Each PPC landing page mirrors its ad's headline + hero + CTA (message match) — built per ad group with Google/LSA
- Strip PPC pages: no main nav, no footer menus, no blog links — one goal per page
- Primary CTA above the fold (esp. mobile); inline + sticky form
- Specific CTA copy ("Get My Free Case Evaluation" / "Speak to an Attorney Now"), not "Contact Us"
- Minimal fields (name, email, phone); test single-step vs multi-step form
- 30–60s qualification quiz on PI pages — pre-qualifies and feeds GHL's qualified-lead criteria
- Trust block matched to the page's case type: case results with $ amounts, testimonials, bar / Best Lawyers + "as seen on" badges
- Real team/office photos (no stock) + short attorney video
- "You"-language headlines; prominent click-to-call + tap-to-text on mobile
- Mirror all CRO on the Spanish pages (built, not just translated)

### ▸ CRO — test · Months 2–3, ongoing
- GA4 goal tracking on every form submit + call click; heatmaps installed
- A/B test one variable at a time to ~95% significance; start with headline + CTA
- Feed winning page patterns back to Google/LSA + Meta

### ▸ Tech & analytics setup · Month 1
- Search Console + GA4 + GTM
- robots.txt + XML sitemap submitted
- Schema: LegalService, Attorney, FAQ, Review, Breadcrumb
- Page-speed pass (image compression, lazy load, CDN)
- Per-page meta titles/descriptions + image alt text

### ▸ SEO + content · Months 2–3
- Technical + on-page SEO (Core Web Vitals, NAP, internal links)
- Keyword/intent map → mapped to pages
- Blogging cadence, question-format (statute of limitations, recorded statements, what to do after a crash)
- AEO setup: direct answer in first 1–2 sentences per section, FAQ blocks, schema, name statutes/places/attorney
- Shoot 1: brand (polished) + trust (raw) video

### ▸ Compound · Months 4–6
- Expand winning content clusters, deepen AEO
- Shoot 2

**Needs:** results/verdicts to feature + review-ask approval (client via Nacer)

**Done =** fast site that converts, landing pages ready before ads launch, organic + AI visibility climbing.

---

## Account — Sohib

### ▸ Run the account · Ongoing
- Client point of contact + strategy
- Monthly review
- Budget scale/cut calls

### ▸ Referral engine · Months 4–6
- Build attorney + medical-provider (chiro / ortho / PT) referral relationships
- Set up written, client-consented fee-sharing agreements (IL RPC 1.5 — joint responsibility)
- Refer overflow / out-of-scope cases out for fees

---

## Ops — Nacer

### ▸ Run delivery · Ongoing
- Timelines + gate sign-off across all four departments
- Shoot logistics
- Monthly report
- Collect client access + decisions
- Set a shared UTM / naming convention all channels use

### ▸ Pre-launch test · end of Month 1
- ⛔ One end-to-end stack test: a lead from each channel → tracked → into Clio Manage → notification fires → appears in reporting

---

## Sequence at a glance

| Department | Month 1 | Months 2–3 | Months 4–6 |
|---|---|---|---|
| CRM & Automation (GHL) | Audit Grow → build into Manage | Maintain | Nurture + gift automation |
| Web / SEO | Rebuild site + GBP + tech setup | SEO + Shoot 1 | Compound + Shoot 2 |
| Google / LSA | Verification + recon + tracking | Launch LSA + Search | Scale |
| Meta | — | Setup → launch retargeting + brand | Scale |
| Referral & reviews | — | — | Layer in |

**Do not launch ads until:** end-to-end stack test passed · site + landing pages live · intake answering confirmed · LSA verification submitted · offline conversion import + CAPI live.

---

## Client to-do (Nacer collects)

**Access:** Google Ads + GBP admin · Meta Business Manager · site/domain/hosting · phone/call-tracking · Clio Manage + Clio Grow (Grow access for the audit before we replace it) · bar license + insurance + ID (for LSA).

**Decisions:** which case types · geography & radius · budget split · the offer · which results/reviews we can use · who answers calls and when (incl. after-hours).

**Time:** intake call (Month 1) · first shoot (Months 2–3) · monthly review.