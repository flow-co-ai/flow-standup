<!-- modifiedTime: 2026-07-30T15:02:21.000Z -->
# Steel Group (AGS · O'Hare · Forte · PGB · PGM) — Build Tasks (per department)

**Retainer: $10,500/mo (Flow Company, Jan 2026).** Scope: web/SEO/GBP across 5 sites · cold email outreach · content · reporting · CRM maintenance · Google Ads management free first 3 months. Paid direct by client: CRM development, ad spend, optional cold-calling team.
**Window: May–Jul 2026 (done/in-flight) → Aug–Oct 2026 (next).**
**Measured on RFQs → quotes → orders and revenue recovered from quiet accounts — not clicks, not traffic.** Dev work runs through **Ahmed + Ali (Dev team)**; Epicor side is **Jorge (TCP)**; client POC is **Sohib (Account)**, owner-side lead **Nabil**.
**⛔ = blocker** (gates a downstream build or breaks data integrity — clear these first).

**Data rules — all CRM work:** join key is `Company + '-' + Cust. ID` (IDs repeat across entities) · never merge across different Customer IDs · true merge not delete, repoint Epicor sync before deleting · most-recent value wins on Status/Type conflicts · audited batches with rollback files posted to the Monday CRM board.

---

## CRM & Automation — SugarCRM (Sugar ↔ Epicor ↔ Sales-i)
**Lead:** Ahmed (data) / Dev 2 (automations) — *dev costs billed direct to client*

**▸ Dev handoff + data cleanup** · May–Jul ✅
- Handoff from Digital Cordex complete; 1st Directives issued July 7 (clean data → verified automations → inactivity live)
- Dedup phase closed: approved workbook for 447 duplicate groups delivered (437 merges with keeper IDs, 2 split-CID partial merges, 6 do-not-merge, 2 held pending Epicor verification, rebrand renames inline)
- 126 accounts absent from Sugar created
- Inactivity automation confirmed working — 11-account test passed (status → Dormant, tasks created); Module Loader block bypassed

**▸ Finish the data floor** · Aug–Oct
- ⛔ Reconcile the 342 stub accounts (name-based match against the authoritative customer sheet) — Sales-i sync keys on Customer ID, so these accounts get nothing until fixed
- Execute the approved 447-group merge workbook in audited batches; post rollback files to Monday
- Zoho notes migration (~14K): match parentID against Leads and Accounts, set-aside list for no-matches, sample-verify after import (in progress)
- Verify every existing BPM automation fires (For Review — close it out)
- Triple-duplication from Epicor has no integration-layer fix — keep the standing merge protocol running as new accounts sync
- Chase the "Quote Ordered = True" sync bug with Jorge

**▸ Sales-i → Sugar data pipeline** · Aug–Oct
- Architecture locked: Sales-i is the sensor, Sugar is the engine — Sales-i never sets statuses, it only populates fields the BPM reads
- ⛔ Dev 2 builds the export parser from one sample export: saved enquiry → scheduled CSV → parser → Sugar REST API (fields: `si_last_purchase_date_c`, `si_days_since_purchase_c`, `si_avg_order_interval_c`, `si_qtd_spend_c`, `si_variance_pct_c`, `si_decline_flag_c`, `si_gap_flag_c`, `si_dropped_products_c`, `si_last_sync_c`)
- Lock the saved enquiry format; parser fails loudly on format change, never writes garbage
- Weekly refresh cadence (matches the 30/90/180-day logic; daily not needed)
- ⛔ Jorge parallel path: can Epicor push invoice-line data (date, value, product, customer ID) to Sugar directly — if yes it replaces the export pipeline; nothing downstream changes
- CSV handling: `encoding='utf-8-sig'`, `thousands=','`

**▸ Automations — switch the clock + early warning** · Aug–Oct
- Inactivity chain reads `si_last_purchase_date_c` instead of quote date: 30d → Dormant + re-engage task · 90d → At-Risk + follow-up task · 180d → Lost + final-attempt task · 365d → Lost + Type: Inactive (skip if Lost/Under Review)
- Quarterly review reads fields, no math: variance > 0 → Growing · variance < 0 → Losing · QTD spend > $15K → Type: High Value
- Early-warning tier: decline flag → At-Risk + "Declining Spend — Proactive Call" task with dropped products in the body · gap flag → "Missed Regular Order — Check In" task only (no status change)
- Recovery triggers unchanged: new quote on Dormant/At-Risk → Stable; on Lost → Under Review
- Guardrail: if `si_last_sync_c` older than 48h, inactivity chain pauses — no status changes off stale data
- Lifecycle segmentation stays in Accounts via Account Type (Prospect/Suspect/Customer) — no Lead rollback, it's one-way in Sugar

**▸ CRM maintenance (retainer scope)** · Ongoing
- Monthly upkeep + dashboard updates; lead routing, customer segmentation, data cleaning
- Keep the RFQ → quote → sales chain fully visible (website form Zaps → Sugar verified after any site change)

**▸ Sales-i dashboards** · Aug–Oct
- Iframe dashlet is dead (single-page app, no per-report URLs) — do not revisit
- Save the enquiries in sales-i with Roll Dates on: Revenue Trend (12mo vs prior year), Customer Variance/Revenue Risk, Material/Product Variance; account-level views via the native Sugar dashlet + Recommendations module
- Monthly export of company-level Variance for the ownership report

**▸ Team onboarding** · Aug–Oct
- Build Tom's AGS quiet-accounts calling list into Sugar (Tom_Call_List_AGS_Quiet_Accounts.csv) — flagged priority July 28
- Onboard Tom Harmon to Sugar (Shahan possibly next)
- Sugar SOPs (Tango) + screen-recorded walkthrough video (Loom) for the client team

*Needs:* customer sheet mapping for stub reconciliation (client via Nabil) · one sample Sales-i export (Sohib) · Epicor answer (Jorge)
*Done =* clean deduplicated data, inactivity + early-warning automations running off real purchase data, Tom working his call list inside Sugar.

---

## Web / SEO (5 sites: AGS, Forte, O'Hare, PGB, PGM)
**Lead:** ________

**▸ Deindexing diagnosis** · May–Jul ✅
- Root cause isolated: Advance, Forte, O'Hare lost ~97–98% of impressions starting early Feb 2026; PGB (control) untouched — shared infrastructure/config change in the Jan 20–Feb 5 window, progressive deindexing (improving avg position + CTR with collapsing impressions = the fingerprint)
- Inquiries held steady anyway — GBP/Maps traffic unaffected; owner email + team brief sent

**▸ Recovery** · Aug–Oct
- ⛔ Name the mechanism in Search Console → Indexing → Pages for all three sites (which reason bucket spiked late Jan: robots.txt, noindex, 5xx, crawl block) — everything else waits on this
- Audit what the three share that PGB doesn't: host/server, WordPress instance, theme/plugin push, CDN/WAF rules against Googlebot; confirm PGM's status while in there
- Fix, then URL Inspection live-tests on homepage + key product pages (200, renders, no noindex), resubmit sitemaps
- Track recovery weekly via Windsor GSC connector (full URL property strings with trailing slashes); non-branded impressions are the recovery metric, not position
- Keep GBP optimized on all five listings — it's carrying inquiry volume during recovery

**▸ Retainer baseline** · Ongoing
- Ongoing maintenance, fixes, speed/uptime, RFQ conversion experience across all 5 sites
- Technical SEO, ranking management, keyword expansion
- Website refresh on legacy content
- Line cards: O'Hare delivered; produce the remaining company cards

*Needs:* hosting/server access + change log for late January (client IT via Nabil)
*Done =* three sites reindexed, non-branded impressions climbing back toward the January baseline, all five sites maintained and converting RFQs.

---

## Outreach — Email + Calling
**Lead:** Sohib

**▸ Campaigns run** · May–Jul ✅
- Medical-manufacturer cold campaign for Advance live: buyer list cleaned against customer file (~455 leads after suppression), First_Name parsed, 4-email sequence in Sohib's voice
- Q2 results: 152 email conversations → 52 quotes forwarded to sales
- Lapsed re-engagement built: 201-account list split per company; O'Hare fully enriched (57 accounts, 54 contacts — buyers/purchasing first, shipping + AP mailboxes excluded, one contact per company)

**▸ Finish + launch re-engagement** · Aug–Oct
- ⛔ Pull AGS + Forte contact exports and run the identical matching — 144 lapsed accounts still have no emails
- Launch the lapsed/nurture sequence per company once enriched; PGB positioned as network, others as direct suppliers
- Scrape, clean, verify the next prospect-list wave; domain setup + warmup, sequence copy, list building (carried items)
- Tom executes the AGS quiet-accounts call list from inside Sugar (CRM builds the list view); wider cold-calling team only if client reinstates it (client-paid)
- Patch sub-account raw-number names ("Sub-account of 00930-FORTE") from the customer sheet mapping in one pass across call lists and reports

*Needs:* AGS + Forte contact exports (client via Nabil) · call list in Sugar (CRM)
*Done =* every lapsed account with a named contact, sequences sending, Tom calling — recovered RFQs traceable in Sugar.

---

## Content
**Lead:** ________

**▸ Retainer cadence** · Aug–Oct
- Monthly blogs per site (supports SEO recovery — question-format around materials, grades, tolerances)
- Product photos/videos
- Email content for the campaigns and nurture sequences (feeds Outreach)
- Light website updates + LinkedIn posting
- Hold new blog publishing on the three collapsed sites until reindexing is confirmed — new content on a deindexed site is wasted; start on PGB/PGM meanwhile

*Needs:* reindexing confirmation (Web) · campaign calendar (Outreach)
*Done =* monthly content shipping across the brands and feeding SEO + campaigns.

---

## Ads — Google (management free through the first 3 months)
**Lead:** ________
*Status: pulled back after the two-week high-intent test (May decision); D&B passed on. Management is covered under the agreement, spend is client-paid — so restart is cheap when the timing is right.*

- Revisit after SEO recovery + re-engagement results land, or on ownership ask
- If restarted: high-intent search only (round bar stock, centerless grinding), retargeting as needed, per-case-type structure
- LinkedIn awareness ads remain the only other candidate paid channel — hold
- No flyers; direct mail to dormant/at-risk accounts is the approved offline alternative if wanted

---

## Account & Reporting — Sohib

**▸ Run the account** · Ongoing
- Client POC + strategy; owner comms in plain language, revenue-framed, lead with what's healthy
- Monthly report per the agreement: website performance, SEO, RFQs, leads — simple dashboards, trends across customers, materials, time periods
- Quarterly ownership report (WeasyPrint PDF): deals in, getting found, systems improving — sales-i Variance export feeds it
- Always verify date-range parity before surfacing revenue to ownership (matched-period YoY, not partial-vs-full)
- Bundled retainer invoicing — no itemized lines

---

## Sequence at a glance
| | May–Jul (done) | Aug–Sep | Sep–Oct |
|---|---|---|---|
| CRM data | Handoff · dedup workbook · 126 created · inactivity test passed | 342 stubs ⛔ · execute merges · Zoho notes | Standing merge protocol · monthly maintenance |
| Sales-i pipeline | Architecture locked · dashboards scoped | Parser build ⛔ · Jorge answer ⛔ | Field-driven automations + early warning live |
| Web / SEO | Collapse diagnosed | Root cause ⛔ · fix · resubmit | Recovery monitoring · refresh · line cards |
| Outreach | Medical campaign live · O'Hare list enriched | AGS/Forte contacts ⛔ · launch lapsed sends | Tom calling in Sugar · next campaign wave |
| Content | — | Blogs on PGB/PGM · campaign copy | Full cadence once reindexed |
| Ads | Pulled back after test | — | Revisit post-recovery / on ownership ask |
| Reporting | Q2 report delivered | Monthly cadence | Monthly + quarterly ownership PDF |

**Do not switch the inactivity clock to Sales-i data until:** 342 stubs reconciled · parser tested against a real export · stale-data guardrail live · one account verified end-to-end (export → fields → status → task).

---

## Client to-do (via Nabil)
**Access/data:** AGS + Forte customer contact exports · hosting/server access + late-January change log for the three collapsed sites · customer-sheet mapping for stub and sub-account names · sample Sales-i scheduled export.
**Decisions:** confirm Tom (and Shahan?) as Sugar users · greenlight lapsed-account sends per company · whether to restart Google Ads (spend client-paid) · whether the cold-calling team gets reinstated (client-paid) · whether direct mail to dormant accounts is wanted.
**Time:** Tom's Sugar onboarding session · monthly report review.