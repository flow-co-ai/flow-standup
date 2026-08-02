# Quality HVAC by Fibid — Build Tasks (per department)

**Onboarded April 2026 · This sheet covers Months 2–4 (May–Jul, done/in flight) and Months 5–7 (Aug–Oct).** Ad spend: ~$1,400 Google + ~$600 Meta/mo (direct to platforms), currently throttled on purpose — lead volume outpaced dispatch capacity. LSA runs client-side; we advise, we don't own it.
**Measured on booked jobs the dispatch board can actually absorb — not clicks, not raw leads.** Departments report to **Nacer (Ops)**; client POC is **Sohib (Account)**. Client contacts: Nader (field), Aiman (property mgmt/PM book), Xavier (office).
**⛔ = blocker** (blocks go-live, breaks attribution, or breaks the speed-to-lead promise — clear these first).
**✓ = done · ● = in flight**

**Compliance & hard rules — all ad + web copy:** financing positioned as a cash discount, never mention the finance fee (legal requirement) · tune-up promo floor is $59, never lower · equipment brand is **American Standard** (switched from Bryant 5/26) — no Goodman anywhere · no broad match on Google · no paid spend into Cicero, Berwyn, Midlothian, the east radius, or any 606** ZIP — organic only · never blend the two GBP listings in reporting · don't touch the Crestwood profile (145 reviews) · client-facing language stays jargon-free.

---

## Admin
**Lead:** Sohib (Account) / Nacer (Ops)

**▸ Access & credentials** · Months 2–3 ✓
- ✓ HCP admin (qualityhvacvendor@), Google Ads (admin@flowco.ai), Meta BM (sohib.bound@), both GBPs, Squarespace domain, Bluehost/WordPress (qualityhvac365 + fibid.com), Google Workspace admin, Grasshopper, Lessen Pro, EIN + W9
- ✓ Manager access on Crestwood + Minnesota GBP profiles; Fibid by-name profile added via aiman@qualityhvac365.com
- ✓ Technician emails collected (8 techs, 7/3) for calendar tagging

**▸ Cadence & reporting** · Ongoing ●
- ✓ WhatsApp group live day one; weekly Tuesday check-ins → moved to Thursday → biweekly as of 6/30
- ✓ Mid-month + end-of-month HTML/PDF performance reports (Jun 15, Jul 16 delivered) + WhatsApp check-in message to Nader — recurring
- ● August mid-month + EOM reports; keep the demand-control narrative (throttled spend + paused LSA = intentional, not underperformance); flag the last 2–3 days of any GBP window as Windsor data lag
- Use native LSA dashboard and native Google Ads exports as source of truth over Windsor for billable/conversion numbers

**▸ Intake ownership** · Month 5 (Aug) ⛔
- Vivian (dispatch) left 7/7 — confirm who owns intake now, their GHL login, and after-hours coverage. Speed-to-lead automations point at a seat that may be empty. Blocks scaling budgets back up.

**▸ Billing hygiene** · Month 5 (Aug)
- Confirm Meta billing moved off Nader's old Amex to the intended Visa/Chase card (raised 6/11, verified $1.00 METAPAY auth 6/15–16 — close the loop)
- Confirm HCP Pipeline trial cancelled and never billed the Visa ending 8674

**▸ Scale-back-up gate** · Months 5–7
- Do not raise budgets or un-pause LSA until: intake owner confirmed · dispatch capacity confirmed by Nader/Aiman · review velocity campaign live · financing page live

*Needs:* intake decision + Lessen API access + Wells Fargo approval (client via Nacer)
*Done =* every lane unblocked, reports on cadence, client relationship steady through the throttle period.

---

## CRM & Automation — GHL
**Lead:** Khurram (took over from Hashir 6/19) · Munib · Ali Shaheer + Ahmed Memon on tasks · Board of record: CRM board 18418241405

**▸ Core platform build** · Months 2–3 ✓
- ✓ GHL sub-account live; intake form live (call rep logs phone leads, contact + email alert to Nader/Aiman within 60s)
- ✓ Lead sources configured; leads@ + dispatch@ notification routing; dispatcher + 8 technician user accounts
- ✓ HCP job-complete → GHL converted-customer sync; HCP contact list imported
- ✓ A2P 10DLC submitted and approved; SHAKEN/STIR verified; CNAM registered (Quality HVAC Solutions caller ID); texting policy + SMS consent live on site
- ✓ GHL number +1 708-847-3832 purchased; forwards to Fibid local 708-688-9258; missed-call-text-back live; new-lead SMS confirmation <1 min; Meta lead ads → GHL native (no manual entry)
- ✓ SMTP via Google Workspace (info@qualityhvac365.com connected); HCP Pipeline decommissioned in favor of GHL
- ✓ Lessen Pro jobs → GHL calendar via email-parse pipeline (green events, tech name in description); color-coordinated calendar
- Platform ownership rule: GHL owns customer-facing comms and is booking source of truth; HCP is field execution only — don't duplicate HCP-native automations (e.g. on-the-way texts)

**▸ Full GHL build audit** · Month 4–5 ● 
- Complete end-to-end audit of every live workflow — not just flagged ones; the point is catching what hasn't been reported
- Audit every integration point: HCP, Lessen Pro, Grasshopper, Meta lead forms, website contact form
- Document findings before treating any other item as the full open-work picture

**▸ QA the known bugs** · Month 5 (Aug)
- Missed-call automation double-fire: place live test calls, confirm exactly one text + one email per event; check opportunity naming off the intake form
- Web form SMS confirmation: verify qualityhvac365.com contact form fires the same <1 min SMS as Meta forms; build if missing
- Duplicate "new lead" logging: work orders re-opening as new leads (flagged 6/9) — confirm resolved
- Grasshopper greeting removal — confirm it was done (recommended 6/2 to cut connection delay)

**▸ Technician calendar routing** · Month 5 (Aug) ●
- HCP jobs landing on Nader's calendar instead of the named tech's; description already carries "Technician: Arnie" etc.
- Direction per 7/29: use HCP's native GHL integration to place scheduled jobs, then auto-reassign calendar owner off the description field

**▸ Lessen Pro calendar — real integration** · Months 5–6 ⛔
- Email-parse pipeline only fires on jobs assigned to Aiman (he only gets emails for his own calls) — jobs scheduled by others never populate. This is the known gap from the 6/24 Vivian escalation.
- Build against the Lessen Pro calendar API instead — blocked on API access/login scope from client (Xavier provided portal login; API access still open)

**▸ Review Boost campaign** · Month 5 (Aug) — launch ⛔ for LSA re-ranking
- Slow-drip 3-message sequence on the Homer Glen/Fibid listing: Day 1 ask, Day 7 reminder, Day 14 final ask + $50 referral gift. Target 63 → 80+ reviews. Crestwood untouched.
- Blocked on confirming which tag the HCP import applied; build trigger, then launch
- Pacing intentional — never bulk-blast reviews on this account

**▸ Revenue sequences** · Months 5–6
- Membership sequence: 2-message yearly maintenance plan SMS (copy done, "Fibid Service Plans.csv" delivered) — define trigger logic, test, launch
- $59 tune-up offer blast to past-customer list (approved in principle 6/2) — time to shoulder season, not peak heat
- Booking bot: benchmark GHL booking flow vs ConversationAI HVAC template (instant booking on the two windows 8–12 / 1–5, lead capture + qualification, FAQ) — due 7/31; document gaps, then build to close them in Aug

**▸ Phase 2 automations** · Months 6–7 (Sep–Oct)
- Quote follow-up sequence; invoice-paid SMS
- Comment-triggered DM automation on Meta (per original scope, explicitly Phase 2)
- Re-engagement sequence for unconverted leads before heating season

*Needs:* Lessen API access + intake owner (Admin/client) · import tag confirmation · pixels/forms on any new pages (Web)
*Done =* every lead captured and source-tagged regardless of channel or who scheduled it, one message per event, calendar accurate per technician, reviews compounding.

---

## Web + SEO
**Lead:** Hashir (+ Zayan on GBP posting)

**▸ Site rebuild & launch** · Months 2–3 ✓
- ✓ 3 homepage directions presented; client picked home-3 direction; site rebuilt and live on qualityhvac365.com under Quality HVAC by Fibid (no new domain — SEO equity kept)
- ✓ fibid.com URL-swap incident resolved: site back on fibid.com, data-backed ranking defense delivered; Fibid and Quality kept as **separate entities/sites** by design (GBP↔site name match = local trust)
- ✓ Fibid on-page SEO audit + fixes (services URL bug, /conatct-us/ typo, lorem-ipsum meta, hours unified 7a–10p daily)
- ✓ 39 Minnesota service-area pages removed from qualityhvac365.com (7/17)

**▸ GBP program** · Months 2–3 ✓ → ongoing ●
- ✓ Both GBP audits delivered and implemented: new description, 12 cleaned services, NAP unified on 60445, main number unified to (708) 476-7079, http→https, service areas (removed Chicago Metro + Midlothian; added Burr Ridge + Lockport)
- ✓ Minnesota profile relocated to Homer Glen and renamed **Quality HVAC by Fibid** — 63 reviews retained (confirmed 6/25); empty duplicate profile removed; fake review reported to Google
- Active listings: Crestwood `locations/6129595594309014752` (145 reviews) · Homer Glen `locations/935628167137586436` (63 reviews) — always tracked and reported separately
- ● Weekly GBP posts cadence on both listings (Posting subitem open); seed Q&A section
- ● GBP image optimization — prompts drafted (Higgsfield; equipment-only framing to dodge false flags, logo composited in post); execution manual, both listings
- Set holiday hours via Special Hours before Labor Day / Thanksgiving

**▸ Homer Glen branch buildout** · Month 5 (Aug)
- Own phone number + own page on the site for the Homer Glen listing, service areas split cleanly from Crestwood so Google reads two real branches (per 6/11 duplicate-filter guidance)
- Keep Aiman's residential address non-public (service-area business)

**▸ Financing page** · Month 5 (Aug) ⛔
- Built and one press away — blocked on Wells Fargo approval from client. Blocks the financing-led installs landing experience; installs campaign leads with "$X/mo, 0% for 18 months."

**▸ Fibid website rebuild** · Months 5–6 (was Stuck 5/26–6/6)
- Unstick and reschedule; Fibid GBP is the stronger profile carrying the ads — its site shouldn't be the weak link

**▸ SEO + content compound** · Months 5–7
- Location pages for each target suburb (Frankfort, Homer Glen, Orland Park, Tinley Park, Burr Ridge, Mokena, Oak Brook, Naperville) + individual service pages per original scope
- Push existing rankings page 5 → page 1 on money keywords; keep AEO/AI visibility compounding (currently #2 map pack Crestwood, #2 AI Overview, #2 AI Mode, #1 ChatGPT — that's the ranking, protect it)
- Heating/furnace service + location content published **September**, before heating season — same play as the AC rush, in market before it, not during it

*Needs:* Wells Fargo approval + Homer Glen phone number (client via Nacer) · review velocity (CRM)
*Done =* two clean branches ranking separately, financing page live, heating content indexed before the first cold snap.

---

## Ads — Google / LSA
**Lead:** Khurram · Hamza · Board: Ads 18405754310, group `group_mm23tg6s` · Account 573-729-0129

**▸ Launch & restructure** · Months 2–3 ✓
- ✓ Search live early May; PMax paused and budget reallocated to search (Jun 4 call)
- ✓ Full AC Installation restructure (6/15): all prior keywords paused, exact match set live at uniform $12 CPC, location targeting locked to Burr Ridge, Orland Park, Homer Glen, Frankfort only, ad copy/quality-score fixes, geo-keyword strings replaced with location targeting + service keywords
- ✓ Budgets deliberately throttled June–July — demand exceeded dispatch supply
- ✓ Recruitment job ads ran ($10–15/day, call-direct) and were paused 6/16 / fully off 6/23 — client not hiring more techs

**▸ LSA (client-run, we advise)** · Ongoing ●
- ✓ Advisory delivered: rate leads weekly, real job-site photos added from ad-assets folder, heating toggles off for summer, automated bidding
- ● LSA intentionally paused right now — re-enable is gated on dispatch capacity + review velocity (reviews + answer rate = the ranking, not budget)
- Flip service-type toggles heating-on before September re-enable

**▸ Investigate the PMax push** · Month 5 (Aug, opened 7/30)
- Google rep pushing a transfer to a PMax campaign — Khurram to find out why it's happening and whether anything auto-migrated; keep the exact-match structure intact

**▸ Keyword & campaign hygiene** · Months 5–7 ●
- New keyword additions (open subitem) + negative-keyword list for installations (open subitem); weekly search-term pruning
- Emergency repairs campaign per original scope — build for the remaining heat waves and carry the same-day-availability angle into no-heat winter emergencies
- Competitor conquesting (Four Seasons, ABC branded terms, ~$200/mo) per original scope — never launched; build once budgets un-throttle, position on price + quality
- Native Google Ads exports = conversion truth for reporting, not Windsor

**▸ Heating season pivot** · Months 6–7 (Sep–Oct)
- Furnace install/replacement + emergency heating campaigns live **before** the first cold snap, financing-led, same 4-town lock
- Re-raise budgets per the scale-back-up gate (Admin)

*Needs:* landing/financing + location pages (Web) · lead-source truth in GHL (CRM) · capacity green light (Admin/client)
*Done =* every dollar in the 4 priority towns on exact match, LSA back on and ranking, heating campaigns in market by October 1.

---

## Ads — Meta
**Lead:** Khurram · Hamdan · Account 1100171161349243 (Fibid entity)

**▸ Launch & restructure** · Months 2–3 ✓
- ✓ Awareness launched 5/1; restructured per Jun 4 call: awareness off, 2 lead campaigns live (call-only + lead form, $10/day each), retargeting audience carried over
- ✓ Weather-reactive "90 degree days" campaign built and run through the heat waves (subitem Done); budget shifted onto the heat-wave ad ahead of the 90s week
- ✓ 606-area ZIP exclusions in; AI-generated videos pulled from HVAC creative per client feedback; creatives reworked Bryant → American Standard
- ✓ Meta lead forms wired into GHL natively

**▸ Retargeting list** · Month 5 (Aug) ● (open subitem)
- Upload the 1,200-contact HCP customer list as a custom audience; financing-angle retargeting once pixel + list audiences season

**▸ Weather-reactive protocol** · Ongoing
- Bursts stay in reserve; Nader/Aiman trigger on 85°+ forecasts via WhatsApp, ads team launches same day — keep through August, then retire for the season

**▸ Fall creative flip** · Months 6–7 (Sep–Oct)
- Evergreen $59 tune-up promo pivots to fall furnace tune-up framing; "call before the heat wave" angle becomes "call before the first freeze" (Nader's requested horror-font treatment lives here)
- Refresh before fatigue; before/after install proof + financing angle stay the backbone

*Needs:* video/kinetic assets (Video) · list + pixel events (CRM) · financing page destination (Web)
*Done =* retargeting recovering warm traffic on financing, weather bursts fired same-day all August, fall creative live by late September.

---

## Video / Creative
**Lead:** Sohib (production) · Muhammad Tahir (editing) · Board: Video 18100257069, group `group_mm2660b4`

**▸ Shot & shipped** · Months 2–3 ✓
- ✓ On-site shoot at Burr Ridge with Nader (5/5); frame.io review cuts approved by client
- ✓ Static image ad set launched (Bryant → American Standard rework, Goodman removed)
- ✓ Recruitment creatives (retired with the job ads)
- ✓ Kinetic text ad 1 — beat-the-rush angle (flat black, Anton, white + single red accent, motion-blur fly-ins)

**▸ Kinetic ads 2 & 3** · Month 5 (Aug)
- Render the two remaining angles: heat discomfort + wasted money/high bills — same kinetic spec, hand to Meta

**▸ Fall/heating creative package** · Month 6 (Sep)
- Furnace/no-heat urgency spots + fall tune-up statics; goosebumps-font "call before the freeze" concept for Sep/Oct per Nader
- Refresh before/after install library from Nader's Drive folder; job-site clips over polished graphics (personality + trust angle — both owners approved on camera)

*Needs:* before/after photos + shoot availability (client via Sohib) · angle briefs (Ads)
*Done =* Meta never runs a fatigued creative; fall package delivered before the Google/Meta heating pivot.

---

## Sequence at a glance
| | Months 2–3 (May–Jun) ✓ | Month 4 (Jul) ✓/● | Months 5–6 (Aug–Sep) | Month 7 (Oct) |
|---|---|---|---|---|
| Admin | Access + cadence | Reports · biweekly shift | Intake owner ⛔ · billing closeout · scale gate | Budget re-raise |
| CRM (GHL) | Core build + A2P + integrations | Handoff audit · booking bot test (7/31) | Bug QA · Lessen API ⛔ · Review Boost · membership/tune-up | Phase 2 automations |
| Web + SEO | Site live · GBP audits · Homer Glen relocation | Minnesota pages removed · posting cadence | Financing page ⛔ · Homer Glen branch · location pages | Heating content indexed |
| Google/LSA | Launch · 6/15 restructure · throttle | PMax question · hygiene | Conquesting + emergency builds · LSA re-enable | Heating campaigns live |
| Meta | Launch · lead-campaign split · weather bursts | Bursts through heat | Retargeting list · burst season ends | Fall creative flip |
| Video | Shoot 1 · statics · kinetic 1 | — | Kinetic 2–3 · fall package | Refresh |

**Do not scale budgets / re-enable LSA until:** intake owner confirmed post-Vivian · dispatch capacity green-lit by Nader/Aiman · Review Boost live and dripping · financing page live · Lessen calendar gap closed or accepted.

---

## Client to-do (Nacer collects)
**Access:** Lessen Pro API access (portal login alone isn't enough for the calendar sync) · Homer Glen dedicated phone number.
**Decisions:** who owns intake + after-hours now that Vivian is gone · Wells Fargo financing approval (unblocks the financing page) · green light + capacity check before budgets scale back up · confirm Meta billing card final.
**Time:** biweekly Thursday 7:00 AM check-in · fall creative shoot window (Sep) · keep triggering weather bursts on 85°+ forecasts via WhatsApp.

---

## Open questions (resolve before next report cycle)
- **BWS scoping** — confirm whether BWS is Fibid/Quality under another label or a separate client; affects historical Fibid report accuracy.
- **Booking bot gaps** — battle-test due 7/31; the gap doc decides the August CRM build list.