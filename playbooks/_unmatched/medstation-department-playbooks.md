<!-- modifiedTime: 2026-08-17T18:05:28.000Z -->
# Medstation — Build Tasks (per department)

Start July 1 · 3 months (Phase 1 proof-of-concept). Flat service retainer, $3,500–$5,000/mo (range confirmed 7/1; final number pending sign-off from Mateus's father). Ad platform budgets scoped separately per department below — cold Meta prospecting stays with the Brazilian agency; Flow runs a dedicated account for reactivation and persona lanes only.

Internally benchmarked on **booked appointments and reactivated patients** — not clicks, not raw leads. (Billing itself is flat-fee; Phase 1 intentionally has no performance-based pricing.) Departments report to Nacer (Ops); client POC is Sohib (Account). ⚠ = launch blocker (blocks go-live or breaks attribution — clear these first).

**Compliance — all ad + web copy:** no outcome/result guarantees · no "best / #1 / top-rated" claims without substantiation · PHI never uploaded raw to ad platforms (hashed match only, GHL/EHR is system of record) · patient testimonials need signed consent + disclaimers · Meta Personalized Health / Special Ad Category rules apply — don't imply a viewer's condition · Google healthcare ad policy + restricted-procedure list · Portuguese-first copy, English/Spanish parity where used.

> This is a coordination-heavy build before it's a campaign build — Medstation has an existing Brazilian agency, an existing intake team, and PHI to route around. The block below is the overhead that has to clear before any department's Month 1 checklist can actually start.

---

# ADMIN & COORDINATION

*Strategic coordination · campaign alignment · access · compliance — clear before execution starts*

## Account — Sohib

### ▸ Run the account · Ongoing
- Client point of contact + strategy — primary: Mateus, escalation: his father
- Monthly review, framed for a data-driven, skeptical, English-limited audience
- Budget confirmation loop with the father before anything scales past Phase 1
- Own the Phase 1 → Phase 2 conversation (out-of-FL expansion, MedCard relaunch, Wellness funnel, full Meta takeover — none of it starts until Phase 1 proves out)

## Ops — Nacer

### ▸ Campaign alignment & delivery · Ongoing
- Timelines + gate sign-off across all four execution departments
- Alignment meetings with Medstation's existing Google Ads manager, Meta ads manager, scheduling developer, and intake team — avoid duplicate work
- Confirm targeting/audience boundaries with the Brazilian agency before any Google or Meta account goes live — this is the #1 way Phase 1 quietly breaks
- WhatsApp groups set up for cross-team communication
- Monthly report
- Stripe payment link / monthly billing setup

### ▸ Pre-launch test · end of Month 1
- ⚠ One end-to-end stack test — a touch from each channel → tracked → into GHL/NextGen EHR → appears in reporting

## Access, Decisions & Time — Nacer collects

**Access:** Google Ads + GBP admin (all locations) · Meta Business Manager (for the new dedicated account) · medstation.com / domain / hosting · Como CRM export access · WhatsApp Business API · NextGen EHR / scheduling platform.

**Decisions:** final budget number with the father ($3,500–$5,000/mo range) · which Meta lanes/personas Flow owns vs. the Brazilian agency · which results/testimonials can be used, with signed consent · who monitors WhatsApp and when (after-hours coverage).

**Time:** intro/alignment calls with the existing Google Ads manager, Meta ads manager, scheduling developer, and intake team · monthly review · sign-off on the three-month roadmap.

## Launch Gate — HIPAA / Compliance / Attribution

Do not launch ads until all of the following are true — most of these are compliance or attribution risks, not campaign preferences:

- ⚠ Duplicate "Brazilian Clinic" GBP listing resolved (reputation + attribution risk at the HQ address)
- ⚠ Como → GHL migration live and tested, with a PHI handling review signed off (what stays in GHL vs. Como/NextGen EHR)
- ⚠ WhatsApp Business API consent language + compliance reviewed before send volume scales
- ⚠ UTM tracking fixed end-to-end, website → booking funnel
- ⚠ Meta CAPI live + Custom Audiences confirmed hashed-match only — no raw PHI in any upload
- ⚠ Dedicated Meta ad account confirmed separate from the Brazilian agency's, audience overlap checked

---

# EXECUTION DEPARTMENTS

*CRM & Automation · Google / Local / LSA · Meta · Web / SEO / Creative*

## CRM & Automation — GHL

**Lead:** ________

### ▸ Como → GHL migration · Month 1
- Audit current Como workflows (patient records, pipelines, automations) before sunset
- Confirm migration method — export/import vs. API — and map fields (patient history, appointment history, lead source)
- Build GHL pipelines for intake + reactivation stages
- Decommission Como once GHL is live and verified

### ▸ WhatsApp-first review engine · Month 1
- Post-visit review-request automation via WhatsApp (WhatsApp runs ~40% engagement here vs. near-zero on SMS)
- Route negative feedback to intake before it reaches a public review
- Google review link wired to the automation

### ▸ Scheduling & routing · Months 1–2
- Integrate the new AI scheduling platform with GHL + NextGen EHR (per 7/1 alignment call)
- Route by clinic/location + service type
- Missed-call / missed-message follow-up cadence

### ▸ Tracking · Month 1
- Form + WhatsApp capture tagged by source
- Test one lead end-to-end into GHL + NextGen EHR before go-live

### ▸ Maintain · Month 2
- Keep tracking clean as reactivation traffic turns on
- Feed booked-appointment data to Nacer for the monthly report

### ▸ Nurture · Month 3
- Reactivation sequences against the 150K-lead database, staged by segment — not all at once
- Re-engagement cadence for unconverted / lapsed patients

**Needs:** 150K-lead list cleaned + segmented, PHI/WhatsApp compliance cleared (see Launch Gate above)

**Done =** every patient touch is source-tagged, routed, logged in GHL + NextGen EHR, and traceable to a booked visit.

---

## Google Search / Local SEO / LSA

**Lead:** ________

### ▸ GBP triage · Month 1, start Day 1
- Fix miscategorization across clinic listings (several read as "store," not medical clinic)
- Ship the Weston location fix first — cleanest, fastest win; use as the internal proof point

### ▸ Local SEO build · Month 1
- NAP consistency across every location + directory
- Category, service area, hours, photos per clinic
- Review-ask wired to the GHL/WhatsApp automation (see CRM dept)

### ▸ Search build · Months 1–2
- Scope: non-pharmaceutical services only — pharmacy/dispensing stays out of paid search per compliance
- Separate campaign per service line — never one bucket
- Exact/phrase on branded + high-intent terms; negative-keyword list from day one
- Google Customer Match upload from the 150K-lead list — reactivation, not cold acquisition
- Message match: each ad's landing page mirrors the ad (build with Web)

### ▸ LSA · Month 3
- Submit verification early enough to be live by Month 3 (approval takes weeks)
- Service-type toggles set to target categories only
- Profile fill: photos, hours, service areas, weekly budget
- Dispute wrong-number / out-of-area leads within 24h

### ▸ Scale · Month 3
- Scale what's converting to booked visits; cut what isn't
- Keep review velocity running

**Needs:** landing pages (Web) · GBP access + clinic list · GBP duplicate-listing dispute cleared (see Launch Gate above)

**Done =** HQ + Weston are clean and ranking, no listing is miscategorized, Search + LSA are delivering tracked booked visits.

---

## Meta — Reactivation & Persona Targeting

**Lead:** ________
**Scope:** retargeting + reactivation + persona lanes only. Cold prospecting stays with the Brazilian agency — do not compete with it.

### ▸ Account & tracking setup · Month 1, before launch
- Domain verification + Aggregated Event Measurement config
- Build the Custom Audiences from the 150K-lead list

### ▸ Creative · Months 1–2
- Persona-targeted creative for lanes the Brazilian agency isn't running
- Production via Higgsfield AI assets, art-directed by Flow
- Every ad routes to WhatsApp or a matching landing page — no dead-end destinations

### ▸ Launch · Month 2
- Reactivation live first — 150K list, staged by segment (lapsed, never-booked, etc.)
- Persona lanes live second
- ⚠ Personalized Health / Special Ad Category review on every ad — don't imply the viewer's condition
- No outcome guarantees; disclaimers wherever a testimonial appears

### ▸ Scale · Month 3
- Scale by contribution to booked visits, not raw engagement
- Refresh creative before fatigue
- Feed performance into the Phase 2 conversation — full Meta takeover is a Phase 2 decision, not automatic

**Needs:** signed testimonial/consent releases · Higgsfield asset direction (Account) · CAPI + dedicated account cleared (see Launch Gate above)

**Done =** reactivation is recovering lapsed patients, persona lanes run clean next to — not against — the Brazilian agency's cold campaigns.

---

## Web / SEO / Creative — medstation.com

**Lead:** ________

### ▸ Landing pages & CRO · Month 1
- Build/optimize landing pages per service line + per clinic geo — match Search + Meta 1:1
- Portuguese-first copy; confirm English/Spanish parity needs per market
- Conversion path: WhatsApp click-to-chat as the primary CTA, short form as backup
- Trust signals: real clinic photos, credentials, testimonials with consent + disclaimers
- Strip PPC landing pages down — one goal per page, no nav rabbit holes

### ▸ Tech & tracking · Month 1
- ⚠ Google + Meta pixels installed and firing across all three domains
- GA4 + Search Console + GTM on all domains
- Audit current organic traffic before any structural changes — all three domains currently run near-total branded-only organic; don't tank the one thing already working

### ▸ Local SEO support · Month 1
- Feed GBP category + NAP fixes to the Google/LSA dept
- Schema: MedicalClinic, LocalBusiness, FAQ, Review

### ▸ CRO — test · Month 2
- A/B test headline + CTA on top pages, one variable at a time
- Heatmaps installed on highest-traffic landing pages
- Feed winning patterns back to Google + Meta

### ▸ Creative production · Months 1–2
- Higgsfield AI asset direction for Meta creative (coordinate with Meta dept)
- Real clinic/team photography where possible — no stock

**Needs:** domain/hosting access · clinic photo library or shoot access · results/testimonials cleared for use

**Done =** every paid landing page matches its ad, tracking is live and clean, organic traffic is protected through the rebuild.

---

## Sequence at a glance

| Department | Month 1 | Month 2 | Month 3 |
|---|---|---|---|
| Admin / Coordination | Alignment meetings + access collection + budget confirm | Monthly review | Phase 2 conversation |
| CRM & Automation (GHL) | Audit Como → build GHL + WhatsApp engine | Scheduling integration · maintain tracking | Reactivation nurture live |
| Web / SEO | Landing pages + tracking + GBP fixes | CRO testing | Compound + feed results back |
| Google / Local / LSA | GBP triage + Search build | Search live · LSA verification submitted | LSA live · scale |
| Meta | Account / CAPI / audience setup | Reactivation + persona lanes live | Scale by contribution |