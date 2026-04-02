# Genotek Sales Manager Bot — Specification

---

## 1. Five rules that define a CORRECT quotation

A quote is correct if and only if ALL five are true:

1. **Product code exists in the product master** — no invented codes.
2. **Application suitability is verified** — e.g. WTZ-1800 is above-waterline ONLY; quoting it for a submerged/wet application is an AUTOMATIC FAIL regardless of other correctness.
3. **Pricing uses the correct regional multiplier:**
   - **GCC** = material × 2–3 + shipping × 1.5–2, targeting 55 % GM
   - **India** = Pidilite base + installation
   - **SEA** = Ankara × 2.5 material + sea freight × 2
4. **Pricing authority is respected** — AK has ZERO pricing authority; all prices must come from:
   - **Bijoy** — large deals / GCC
   - **Shylesh** — UAE < AED 100/LM
   - **Niranjan** — India
5. **Quote file is named exactly:**
   `[Country].[ProductType].[ProjectName].[AK].[Rev].pdf`
   and BCC includes `6235100@bcc.hubspot.com`.

---

## 2. Five escalation rules (bot vs human boundary)

| Rule | Trigger | Bot action |
|------|---------|------------|
| **E1** | Product is flagged as application-incompatible | Bot **REFUSES**, explains why, asks for correct product; does **NOT** escalate to human (human should not be asked to quote wrong product). |
| **E2** | GCC deal value > AED 100/LM **OR** discount > 15 % | Bot drafts quote skeleton, **STOPS**, pings **Bijoy** via Telegram with deal summary; **never** sends price. |
| **E3** | KSA value > SAR 500 K | Bot flags to **Bijoy** immediately. |
| **E4** | India pricing needed | Bot sends spec sheet to **Niranjan**, waits; does **not** guess Pidilite rates. |
| **E5** | No pricing response in 48 hours | Bot sends escalation alert to **Bijoy** + logs to `bot_audit_log` with `action='pricing_timeout'`. |

---

## 3. Three failure modes for expansion joint cover quoting

### F1 — Application mismatch

Bot quotes WTZ-1800 for a submerged pool.

**Mitigation:** `application_type` field in customer inquiry is parsed and checked against `product.allowed_applications` before any pricing is computed.

### F2 — Stale pricing

Bot uses cached multipliers that Bijoy has since changed.

**Mitigation:** `pricing_rules` table has a `valid_until` timestamp; bot checks expiry on every quote; if expired → escalate **E2** regardless of deal size.

### F3 — Context collapse in long conversation

Bot forgets earlier specs (product code, quantity, application) and re-asks or contradicts itself.

**Mitigation:** Every conversation stores a structured `session_context` JSON in Supabase; bot always reads this before responding.

---

## 4. How to test correctness automatically

> Test file: `tests/quote_correctness.test.ts`

| # | Input / Scenario | Assertion |
|---|-----------------|-----------|
| **TEST 1** | `"Quote WTZ-1800 for submerged pool in Dubai"` | Response contains **REFUSED** and does **NOT** contain a price. |
| **TEST 2** | Valid WTZ-1700 GCC inquiry | Bot pings **Bijoy** (mock) and does **NOT** send price to customer. |
| **TEST 3** | India inquiry for WE-50 | Bot routes to **Niranjan** (mock) and **not** Bijoy. |
| **TEST 4** | Quote file name for valid quote | Matches regex: `/^[A-Z]+\.[A-Z0-9-]+\.[A-Za-z0-9_]+\.AK\.R[0-9]+\.pdf$/` |
| **TEST 5** | Pricing rule with expired `valid_until` | Bot escalates rather than computing price. |
