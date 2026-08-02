# Full Smile Dental — Build Tasks (per department)

**Original agreement Oct 27, 2025 · $2,200/mo · 6 months (SEO + GBP + web redesign + content + video). Month 10 now · window: May–Jul (done) → Aug–Oct (next).** Ad spend direct to platforms; per the 7/19 call, budget shifts mainly to Google/LSA.
**Departments report to Nacer (Ops); client POC is Sohib (Account).** Client side: Dr. Jamal, Dr. Adham, Lily (front desk) + new intake hire onboarding.

**🔴 AUGUST IS A PROVE-IT MONTH.** Renewal closed 7/23: **one more month at $2,200** — client explicitly cannot do multiple months or a higher number. They track results closely and decide: positive return → continue; same as before → they walk. Their scoreboard, in their words: legitimate leads → how many schedule → how many show → how many become new patients → production/revenue those patients generate. Their baseline claim: <20 attributable new patients over 7–8 months, $20k+ invested. Every task below serves that scoreboard or waits.

**Architecture locked on the 7/19 call:** OpenDental stays primary · GHL sits behind it as marketing CRM + lead tracker only · patient communication (reminders/confirmations/texting) moves to **Flex Dental (~$250/mo, client's tool)** — client declined the GHL texting + HIPAA-fee path · biweekly Lily sync · Flow owes: sync bugs, patient-vs-lead tagging cleanup, and a simple dashboard showing leads all the way to patients in the chair.

**⛔ = prove-it blocker** (breaks the August scoreboard or the client's trust — clear these first).

**Compliance — all work:** HIPAA — no tests on live patients, notifications disabled on all synced/test data, no PHI in dashboards without compliance review · no result guarantees in ad/web copy · testimonial disclaimers · Meta personal-attributes/health policy — don't imply the viewer's condition.

---

## CRM & Automation — GHL / OpenDental
**Lead:** Ahmed Memon + Ali Shaheer

**▸ Handoff + duplicate contacts** · May–Jul ✓
- Handoff doc + Monday items delivered to new dev team (7/7–8)
- Contact lookup before create: PatNum → normalized phone/email → safe upsert; no contact created without a usable identifier — live
- Update path fixed — edits hit the existing record, no new-record spawning
- 604-contact backup + rollback retained; verified duplicate groups merged
- Source field preserved on sync — attribution writes only when source is blank

**▸ OpenDental ↔ GHL sync repair** · May–Jul ✓
- Timezone root cause fixed (America/New_York → America/Chicago); 45/45 audit exact, 0 one-hour offsets
- "O.D." placeholder names fixed; doctor assignment mapping fixed
- Saturday sync working (Aug 1: 16/16); 18 queued appointments recovered
- Missed-appointment bug root-caused and fixed; 5-min sync restored and healthy

**▸ Phones + tracking** · May–Jul ✓
- GHL numbers purchased (~$1.15/mo ea) with client sign-off (5/22); Mango Voice stays the official office line; GHL → office call forwarding + missed-call textback live
- LSA number over-counting investigated and closed (7/27)
- Meta/LSA forwarding + attribution-only-when-blank confirmed with Ads Team

**▸ Automation incidents contained** · May–Jul ✓ — context for everything below
- 6/24 + 7/7: automations fired on non-patients / test data (Cindy Kawash SMS, wrong callback number) → no-tests-on-live-patients rule; missed-appt text scoped to No Show stage only
- 7/9: appointment-confirmation SMS sent wrong times (the timezone bug, patient-facing) → automation **paused** by Ahmed/Ali, still paused
- 7/11: No Show SMS **disabled entirely** at Lily's request — no-shows get a direct call, not a text

**▸ Close the open sync items** · Aug, Week 1–2
- ⛔ Confirm the 23 ambiguous "OD Patient" groups (59 placeholders) — sit-down with Lily, then Ahmed merges
- ⛔ Doctors' real working hours into GHL calendars — practice books **Fridays + Saturdays** (Lily, 6/29); re-queue permanently-skipped appointments after
- ⛔ Patient vs Lead tagging cleanup — Dr. Jamal's named complaint: existing patients and referrals from the doctors' other offices showing as marketing "opportunities." Clean the pipeline so only true marketing leads count, then the AI note scraper keeps it clean (7/19 call)
- Make sync ONE-WAY (OpenDental → GHL mirror only) — matches the locked architecture: OD primary, GHL mirrors for tracking
- OD-created appointment auto-moves the GHL opportunity to "Appointment Booked" — this is how "scheduled" gets counted on the scoreboard
- Facebook leads land in Contacts but not the Opportunities pipeline (flagged 6/22) — wire every lead source into the pipeline or the lead count undercounts
- Link AptNum 10987 + 11008 once identities confirmed; Dr. Graves (Provider 23) calendar decision (client deferred in June — revisit)
- ⛔ Rotate exposed credentials — DO root, Keragon, GHL, fullsmilechicago@gmail, and Mango Voice passwords are all in plaintext across WhatsApp, the handoff PDF, and a Monday update

**▸ Narrow GHL to its lane (per 7/19 call)** · Aug
- GHL = marketing CRM + lead tracker. Patient communication (appointment reminders, confirmations, patient texting, insurance-card photos, review requests) migrates to **Flex Dental** — client's tool, client sets it up; Flow coordinates so nothing double-fires
- Audit every live GHL automation: keep lead-facing (speed-to-lead, missed-call textback on the marketing numbers, no-show *lead* follow-up), kill or hand to Flex anything patient-facing
- Do NOT re-enable the paused appointment-confirmation SMS in GHL — that job moves to Flex
- Voicemail greeting on the GHL marketing number still needed (blocked on Lily since 6/18)
- Fix missed-call double-text on the marketing line; call routing lag GHL → office phones (7/19)
- Intake form: live calendar + "send to OpenDental" button — still valuable for lead booking; confirm it survives the narrowed scope before building

**▸ The dashboard** · Aug, done before the month-end review
- ⛔ Simple view the doctors can open: spend by channel → legitimate leads → scheduled → showed → new patients → collected production. This is the deliverable Sohib committed to on 7/20 and the artifact the stay/walk decision gets made on. HIPAA-compliant handling of any patient data in it.

**▸ If renewed** · Sep–Oct
- AI note scraper keeps the patient/lead tag clean without manual upkeep
- Dashboard hardens into the real-time GHL + OpenDental + ad-platform view from the 7/19 call

*Needs:* Lily sit-down + doctor hours + voicemail audio (Ops/client) · Flex Dental stood up (client) · forwarding answers (Ads)
*Done =* one-way sync clean, pipeline contains only true marketing leads, dashboard live before the month-end review, zero live-patient misfires.

---

## Attribution — the August scoreboard
**Lead:** Sohib + Ahmed

**▸ What's proven so far** · May–Jul ✓
- Cross-check ran: 167 active OD patients × 599 GHL contacts → 72 name matches, only 2 confirmed marketing sources — most matches were bulk sync-created, 21 call contacts nameless
- Root cause diagnosed: phone leads booked straight into OpenDental don't link back to their GHL call record when phone formatting differs — source lost by the time the invoice sync fires

**▸ Close the methodology gap** · Aug, Week 1
- ⛔ Pull OpenDental new-patient report **with phone numbers**; match against full all-time GHL export **with Source field** — phone-number match, not name match
- Normalize phone formats in the matching (country code, dashes, family-member numbers)
- Lily cross-checks unresolved caller numbers against OD patient records
- Production capture: sync the **Collected** amount, not Billed (Lily/Dr. Jamal, 6/11) — and define the pull timing, since collected balances settle only after insurance pays (open from 7/20); do not make Lily calculate manually

**▸ Run the scoreboard live through August** · weekly
- ⛔ Track the client's five metrics weekly, not month-end: legitimate leads → scheduled → showed → new patients → collected production, by channel — surface it on every biweekly Lily call so the month-end number is never a surprise
- Exclude existing patients and other-office referrals from every count — that inflation is what broke trust in the "72 leads" and "80 leads" reports

*Done =* the stay/walk decision gets made on a number both sides trust.

---

## Meta Ads
**Lead:** Hamdan / Ads Team

**▸ Engine status** · May–Jul ✓
- Instant-form engine: May $758 / 57 leads / ~$13 CPL; June avg $80/day total across channels with Meta at $50/day peak (~$35/form); 173 Meta leads YTD by mid-July; 7-mile radius from Worth
- Service-specific campaigns launched: Metal-Free Implants, Implants, Sleep Apnea (week of 7/10)
- Trim executed (7/21): paused everything under $5/week delivery; kept V3 ($15/lead — do not touch), Metal Free Implants, Adham Ad 2 V2, Smile Confidence, Jamal Ad 1, both retargeting sets
- **Lesson learned the hard way (7/6):** the mid-June cap increase went out without flagging the client — Dr. Jamal caught it in the report and it fed the trust problem. Sohib owned it in writing.

**▸ August discipline** · Aug
- ⛔ No budget change of any size without client sign-off first — the 7/19 direction is budget shifting mainly to Google/LSA; Meta holds at the agreed daily cap, confirmed in writing
- Launch the two retargeting ad sets already spec'd (Metal Free ~$10/day, Sleep Apnea ~$5/day, mirroring Retargeting - Implants at 4.5–4.9% CTR) — only if they fit inside the agreed cap
- Custom audiences per offer: 50%+ video viewers (180-day) + FB/IG engagers (180-day)
- Migrate retargeting + awareness fully to native Instant Forms; field-map submissions into GHL with Ahmed/Ali — no routing gaps, or August leads undercount
- Add tracking number +1 708-726-4276 as CTA where relevant; coordinate tagging with CRM

**▸ If renewed** · Sep–Oct
- Finish the 6-creative batch (1 posted as of 7/3); V3 lesson holds — broad restorative pain-point hooks for cold
- Scale/cut by cost-per-booked-patient off the dashboard — not by CPL; refresh retargeting creative before fatigue
- Adham floated performance-based pricing (7/14) — if that shapes the next contract, the dashboard is the billing source of truth

*Needs:* Instant Form → GHL field mapping (CRM) · scoreboard (Account) · creative (Video)
*Done =* Meta judged on patients scheduled, inside a cap the client approved.

---

## Google LSA
**Lead:** Ads Team

**▸ Standing up** · May–Jul ✓
- Full verification gauntlet cleared: docs + GBP owner access (early May) → background checks + insurance approval (6/2) → Dr. Jamal's individual verification saga → ID resubmission (7/8) → live
- Google Ads sunset (cost/conv had fallen $370 → $65; three $10/day service campaigns — Implants, Metal-Free, Sleep Apnea — ran late May before the cut)
- LSA live: 96%+ top impression rate from launch; first phone leads landed early-mid July; client guide delivered to Lily (6/30)

**▸ Run it right** · Aug–Oct
- Lily rates every LSA lead in-app as it lands (guide sent 7/8) — speed to phone + ratings + reviews drive lead volume, not budget; Ops keeps this cadence alive
- Filter spam/junk out of the LSA lead feed so intake counts reflect real leads only (7/15)
- Dispute wrong-number / solicitor / out-of-area leads within the window, weekly cadence
- Review velocity + answer rate drive the ranking — wire to the GHL review automation

*Done =* LSA delivering clean, disputed-down phone leads at pay-per-lead economics.

---

## Web / SEO
**Lead:** Hashir + Zayan

**▸ Compounding** · May–Jul ✓
- Keywords 45 (Apr) → 100 (Jun); organic impressions ~6× (1,512 → 8,751/mo); May SEO report delivered
- Website upkeep ongoing; GBP parent item stood up (7/15)

**▸ Local presence** · Aug
- GBP posting cadence live (posting, optimization, engagement)
- Fake 1-star review: keep flagging through Google's process until removed or formally disputed (7/19 call)
- Feed Google review link/widget into the CRM review automation

**▸ Content + conversion** · Sep–Oct
- Continue blog/service-page expansion on the implant, metal-free, and sleep apnea clusters
- Per-offer landing pages remain untested vs. instant forms — only build/test if pages get split by offer (unlocks pixel retargeting audiences)

*Done =* organic keeps compounding; review profile clean; local pack position defended.

---

## Video / Content
**Lead:** Sohib + Esteban (shoots)

**▸ Cadence held** · May–Jul ✓
- June shoot: 6 scripted doctor videos (3 per doctor) + walking interviews; monthly Sunday cadence
- Caption style guide formalized for the posting team (7/28); appreciation-post graphic formula locked (Higgsfield, 7/25)
- Organic posting running across dental anxiety, family, mission trips, implant pricing, sleep apnea, wisdom teeth

**▸ Next shoots** · Aug–Oct
- Monthly shoot per cadence; angles feed the three ad flywheels — restorative pain-point (cold), metal-free, sleep apnea ("dentist customized" vs OTC is the differentiator)
- Hand clips to Ads for retargeting refresh; post everything organic via the style guide

*Done =* every shoot yields ad creative + a month of organic.

---

## Account — Sohib

**▸ The prove-it month** · Aug
- Renewal closed 7/23: one month at $2,200 ✓ — client's terms accepted in writing, no counter
- Set the decision criteria WITH the client at the first-Sunday call: what number of scheduled/showed/new patients makes August a "yes" — agree on it up front, in writing, so month-end isn't a judgment call
- Weekly scoreboard visibility on the biweekly Lily calls; no surprises at month-end
- **Follow-through is being watched** (Dr. Jamal named the pattern 7/13: Lily onboarding, two months of unposted social) — everything committed on the 7/19 call ships or gets flagged early; organic posting stays current (Sohib owns it, publicly promised 7/14)
- Hold Adham's performance-based pricing idea (7/14) as the shape of the next negotiation — the dashboard makes it possible

**▸ If renewed** · Sep–Oct
- Formalize the new scope in writing — GHL narrowed, Flex handling patient comms, budget weighting to Google; no repeat of the creep
- Sleep apnea referral pipeline: brochure to sleep-study clinics; client bought in on sleep apnea as the growth line (Dr. Jamal, 5/26)

**▸ Run the account** · Ongoing
- Cadence locked 7/20–21: **first Sunday of the month** review call with the doctors + **biweekly Tuesday 12–12:30** ops call with Lily — hold both
- Get the new intake manager fully up to speed on GHL (flagged 6/21 — "catch every opportunity")

## Ops — Nacer

**▸ Run delivery** · Ongoing
- Monday hygiene across all lanes (devs log in Monday, not WhatsApp-only)
- Enforce no-tests-on-live-patients; notifications disabled on all synced data; nothing patient-facing fires from GHL once Flex owns that lane
- No credentials in WhatsApp going forward — password manager or DM'd one-time links only
- Monthly report; collect client items below

**▸ Collect from client** · Aug, Week 1
- Doctors' real working hours (Fri + Sat booking days confirmed) · Dr. Graves calendar decision · Lily sit-down on the 23 contact groups · voicemail script/audio from Lily · OpenDental new-patient report export · collected-amount pull timing · Flex Dental setup timeline · the agreed August success criteria in writing

---

## Sequence at a glance
| | May–Jul (done) | Aug — prove-it month | Sep–Oct — if renewed |
|---|---|---|---|
| CRM (GHL/OD) | Handoff · dupes fixed · sync repaired | Sync items closed · patient/lead cleanup · GHL narrowed, Flex takes patient comms · dashboard | AI tagging · real-time dashboard |
| Attribution | Gap diagnosed | Phone-match closed Week 1 · scoreboard run weekly | Standing report · perf-pricing basis |
| Meta | Service campaigns live · trim | Hold cap (client-approved) · retargeting ×2 · Instant Form migration | Scale by cost-per-patient |
| Google/LSA | Verified + live | Primary budget channel · spam filter + disputes · Lily rates leads | Review velocity |
| Web/SEO | 45→100 keywords | GBP cadence · fake review | Content clusters |
| Video | June shoot · style guide | Shoot + organic stays current | Shoot + refresh |

**August fails if:** the scoreboard isn't trusted (existing patients/referrals polluting counts) · any budget change ships without client sign-off · a patient-facing automation misfires again · a 7/19 commitment quietly slips. Clear the ⛔ items in Week 1–2.

---

## Client to-do (Nacer collects)
**Access/data:** OpenDental new-patient report w/ phone numbers · confirmation on 23 ambiguous contact groups · doctors' working hours (Fri + Sat) · Dr. Graves calendar decision · voicemail script/audio (Lily, open since 6/18).
**Decisions:** August success criteria in writing · collected-amount pull timing · Flex Dental setup timeline (client's side) · review-ask approval · which results/testimonials usable in creative.
**Time:** Lily — biweekly Tuesday 12–12:30 call, LSA lead rating as calls land, sit-down on the 23 groups · doctors — first-Sunday monthly review + monthly Sunday shoot.