<!-- modifiedTime: 2026-09-24T20:59:11.371Z -->
# Senior Insurance Team — Build Tasks (per department)

Live October 15, 2026. Ad spend $1,500/month minimum, direct to platforms on client card.
Measured on cost per enrolled policy. Client POC is Sohib. Creative approver is Sabri.
⛔ = launch blocker.

Team on client side: Sabri, Hanif, Nada.
Entity: We Are Senior Insurance Inc, DBA Senior Insurance Team. Agency NPN 18521522.

Compliance — all ad, web, and video copy:

- TPMO disclaimer on every asset. Sabri's approved language, verbatim.

- No government or CMS affiliation. No specific benefit, premium, or dollar figures.

- Carrier-neutral at launch. Naming a carrier triggers that carrier's legal review.

- Meta personal attributes: group framing only, never "you're turning 65."

- SOA before any plan discussion. Ads sell the conversation, not a quote.

- ACA / under-65 marketplace out of scope.

Cleared: all three GBPs · live Google Ads account identified · G2RS approved · Meta, GHL, Google Ads access · cards on file both platforms · Stripe subscription · HIPAA add-on (Sabri managing) · content shot.

# Admin

### Senior Insurance Team

▸ Remaining paperwork · Month 1

- Confirm Illinois is on the G2RS certification. Approval covered Indiana; Illinois needed a separate state addition. No Illinois Google spend until it reads Illinois

- Agency-named E&O certificate, or written confirmation the entity is covered under Sabri's

- One address of record. EIN says Griffith, E&O says Crown Point

- Licensed-state list with numbers — verify via NIPR against the agency NPN. Drives the Arabic national campaign

- Notify G2RS of the DBA so certification and brand match

▸ Standing · Ongoing

- Sabri drops carrier termination and plan disruption news into WhatsApp as it breaks. Those states become targeting candidates

- ⛔ Pre-launch stack test: one lead per channel per language → tracked → into GHL with source → notification fires → appears in reporting

# CRM (GoHighLevel)

### Senior Insurance Team

Follow-up is the breakdown. Not lead volume, not intake. Leads arrive and go cold. Everything below serves that.

▸ Retire Flow gap · Month 1

- Retire Flow collects doctors, prescriptions, and SOA. It does not talk to GHL, so every record is entered twice

- Sabri is opening a ticket with Retire Flow support. Work their API or webhook options in parallel — do not wait on their roadmap

- If no integration exists: build the one-way push that matters most (contact + SOA status into GHL) and leave the rest manual rather than half-syncing two systems

- Until then, no automation may assume SOA status is accurate in GHL

▸ Pipeline rebuild · Month 1

- Stages as Sabri framed them: New lead → Attempting contact → Waiting on client → Waiting on eligibility → Follow-up → Sold → Policy active

- Keep "waiting on client" and "waiting on eligibility" separate. One is actionable, the other is not, and collapsing them is why follow-up dies

- Task reminders per stage with an owner — Sabri, Hanif, or Nada

- Automated nudge sequences on the waiting stages, language approved by Sabri before anything sends

▸ Source tagging · Month 1

- ⛔ Sources are inconsistent today, so attribution is currently guesswork. Fix before spend

- Lead sources to tag: paid calls, paid forms, Facebook organic, seminars, referrals, dental partners

- Opportunity auto-created on every inbound, not manually

▸ Tracking numbers · Month 1

- ⛔ Separate number per channel: Meta English, Meta Arabic, Google Ads, main line

- Two exist — English, and the Arabic line used for influencer traffic. A spare "internet" number is available

- Call recording on all tracked lines

- ⛔ A2P 10DLC — SMS blocked until approved

- ⛔ SPF / DKIM / DMARC

▸ Leave alone · —

- Appointment reminders at 7 days, 3 days, and 24 hours are working and have cut no-shows. Do not touch

- Google Calendar booking stays as is

▸ Conversion tracking · Month 1

- ⛔ Meta Conversions API — the account has a pixel, not CAPI

- Events on form submit, call connect over threshold, SOA signed

- ⛔ Push Sold-stage enrollments back to the platforms so bidding optimizes on policies, not form fills

▸ Review automation · Month 1

- Trigger at "Sold," regardless of carrier approval status

- Automated, not a button. Agents did not click the button last time

- Route to the correct GBP by office

▸ Conversations clutter · Month 1

- Automations cannot be hidden from the Conversations tab. Pipeline separation plus unread discipline is the fix

- Batch bulk sends so they do not bury real client replies. This is why Sabri turned automations off before

▸ Dashboard · Months 1–2

- Ad platform spend joined to GHL pipeline data. Cost per enrolled policy by channel and language

Target: 3–5 hours a week back for the client team.

# Web + SEO

### Senior Insurance Team

▸ Website rebuild · Month 1

- Current site is vendor-built on Agent Methods, hosted SiteGround. Client owns the domain

- Build on staging. ⛔ 301 map before migration

- Replace the Agent Methods newsletter function

- ⛔ GHL forms embedded natively, every submission landing with source attached

- ⛔ TPMO disclaimer sitewide footer, plus the DBA and one consistent address

- Mobile-first, under 3 seconds. Audience is 65+

- Arabic pages with hreflang

▸ Landing pages · Month 1

- One per campaign theme, headline matched to its ad, English and Arabic

- Manual-entry forms with qualifying fields, not prefilled. Sabri wants the intent filter

- VSL page: video top, form below, secondary button to the live session

- Stripped PPC layout, click-to-call sized for older users

▸ Google Business Profiles · Months 1–2

- All three: categories, hours, service areas, shoot photos, Q&A, posts through AEP

- Resolve why the third profile keeps getting flagged

- Equal push across all three

▸ Technical and organic · Months 1–3

- Search Console, GA4, GTM · schema · title tags and H1s (current site has generic tags, no prominent H1)

- Local pages: Crown Point, Griffith, Tinley Park, Schererville, Merrillville, Indianapolis

- Question-format content answering real enrollment questions

# Ads

### Senior Insurance Team

▸ Plug into the existing Meta account · Month 1

- Account is live and spending. Inherit it — do not rebuild structure or discard pixel history

- Keep the existing pixel if it sits in their Business Manager and is firing. Rebuild only if it lives in the old vendor's BM

- ⛔ Add Conversions API. Aggregated Event Measurement, events prioritized

- Set spend limits

▸ Campaign structure · Month 1

- Core geography Indiana and Illinois. Add states as carrier disruptions surface

- English in core markets. Arabic across all licensed states — that audience already proved national reach organically

- $1,500/month is ~$50/day. Five creatives at $10/day, not twenty-five at $2

- Primary CTA: manual-entry lead form with qualifying questions

- Call CTA secondary, business hours only, no weekends

- WhatsApp CTA on Arabic campaigns

- Location targeting set to Presence

- Scale what works. Sabri has pre-approved budget increases on proven campaigns

▸ Timely angle — plan terminations · Month 1

- Non-renewal notices are required by October 2. Roughly 2.9 million members affected nationally

- This is the strongest hook available and it has a shelf life. Front-load it

- ⛔ Stay inside CMS scare-tactic rules. State the fact, do not predict outcomes for the viewer

▸ Google · Month 1

- Certification approved. Build Indiana now

- No Illinois spend until Illinois is on the certification

- Conversion actions and GTM; GA4 and GBPs linked

- Search split by product: Advantage, Supplement, Part D

- Negative seed list heavy on plan-comparison scrapers and lead resellers

- Evaluate Local Service Ads eligibility

▸ Audiences · Months 1–2

- Turning 65 · already on a plan · likely qualify for more · adult children · under-65 by disability

- Site visitors, video viewers, engagers; client list with consent plus lookalikes

▸ Partnership ads · Months 1–2

- ⛔ Creator must grant Partnership Ad permission in their own account before any collab video runs as paid. This killed the last attempt

- The influencer channel drove 400 calls in 30 days organically

# Video

### Senior Insurance Team

Shot September 23, Tinley Park. In edit now.

▸ Deliverables · Month 1

- VSL, 3–5 minutes, clean YouTube style, for the landing page

- 5 ad cuts, 9:16, 30 seconds, English

- 1 ad cut, 9:16, Arabic

- 15-second top-of-funnel cut leading into the VSL

- Stills pulled for GBPs and the site

▸ Edit rules · Month 1

- Burned-in captions on every cut. Audience is 65+ and watches muted

- TPMO disclaimer on an end card, legible, held long enough to read

- Carrier-neutral. No plan names, no benefit amounts, no premium figures

- Group framing in all on-screen text

- Hook in the first 2 seconds. One hook per cut, not three

- Arabic cut gets Arabic on-screen text, not translated English overlays

▸ Handoff · Month 1

- Footage to Frame.io, link into the editor task

- On-screen text plan per cut, timestamped

- Ads needs finals with enough runway to build and get Sabri's approval before October 15

## Do not launch until

New pixel or CAPI firing · A2P approved · a tracking number per channel routing correctly · source tagging live · TPMO disclaimer on every asset and on the site · SOA flow tested end to end · one test lead per channel per language landed attributed in GHL · Sabri has approved every creative.

Google specifically: Indiana only until Illinois is added to the certification.

## Client to-do (Sohib collects)

Documents: Illinois certification status · TPMO disclaimer language · licensed-state list with numbers · agency-named E&O
Decisions: one address of record · weekly live session day and time · approval on automated follow-up language
Open with vendors: Retire Flow support ticket on the GHL integration