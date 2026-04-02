# Genotek Sales Manager Bot

This repository contains the architecture, logic, and Telegram bot implementation for the Genotek Sales Manager assistant, designed specifically for expansion joint cover sales coordination.

## Overview & Architecture

This system automates the sales coordination process for Genotek Global. It handles inquiry parsing, application compatibility checks, pricing logic, human escalation, and follow-up generation.

The architecture consists of:
1. **Core Database (`schema.sql` & `lib/db.ts`)**: 
   - Uses Supabase PostgreSQL with `pgvector` for semantic search capabilities.
   - Includes tables for `customer_cards`, `quotes`, `follow_ups`, `pricing_rules`, `bot_audit_log`, and `sessions`.
2. **Business Guardrails (`lib/guardrails.ts`)**: 
   - A fast regex and semantics-based pipeline that extracts intent (Product Codes, Quantities, Region) before ANY LLM call.
   - Protects against invalid applications (e.g. quoting a non-submerged product for a swimming pool) by outright blocking the request based on hardcoded rules.
3. **Pricing Engine (`lib/pricing.ts`)**: 
   - Implements strict regional multiplier logic for GCC, India, and SEA.
   - Detects boundary conditions like deals > AED 100/LM, or discounts > 15%, routing these out of the bot's hands and triggering an escalation to human pricing authorities (Bijoy, Shylesh, or Niranjan).
4. **Telegram Bot Interface (`bot/index.ts`)**: 
   - Built with Telegraf, managing per-chat context windows via Supabase JSONB storage.
   - Leverages Anthropic's `claude-sonnet-4-6` to parse complex quotes, structured safely via prompt rules.
5. **Follow-Up Scheduler (`scheduler/followup.ts` & `scheduler/index.ts`)**: 
   - A `node-cron` daemon that evaluates overdue quote follow-ups.
   - Auto-generates regionally configured check-in emails via `claude-haiku-4-5-20251001` throughout a 96-day lifespan.
   - Includes a "Deal Death Detector" that marks quotes as lost/dead beyond day 96.

---


## Question 1: Context degradation in long-running agents + mitigation

In conversational agents, context degrades over time. For this bot, context degrades in three specific ways, each with a targeted mitigation:

1. **Token window overflow (Sliding Window Loss)**
   - *The Problem:* The bot stores only the last 20 messages in the session to manage token costs and limit context size. When message 21 arrives, message 1 is dropped. If message 1 contained the product code, the bot might ask for it again, creating a frustrating loop.
   - *The Mitigation:* We use structured extraction via the `runGuardrails` regex scanner. Fast parsing extracts key entities (`productCodes`, `region`, `quantities`, `applicationContext`) and saves them explicitly to `session.context`. This JSON state object survives indefinitely, outliving the 20-message rolling window.
2. **Stale session context (Temporal Decay)**
   - *The Problem:* A conversation started on Friday and resumed on Tuesday might have outdated pricing parameters or stock assumptions.
   - *The Mitigation:* The Supabase `sessions` table includes a `last_updated` timezone-aware timestamp. If the session rests for too long, the bot treats the next message with a refresh pass, allowing the human to clarify if project details changed.
3. **Contradictory context (User Pivot)**
   - *The Problem:* A user asks for `WTZ-1800`, then halfway through the chat changes their mind to `WE-50`.
   - *The Mitigation:* The guardrails module re-runs on *every single incoming message*. The resulting `ParsedIntent` always overwrites the session fields with the latest extracted entities, ensuring the active context accurately reflects the customer's most recent pivot.

---

## Question 2: Five escalation rules (Task vs Job Boundaries)

Clear boundaries separate tasks the bot can automate from jobs requiring human authority. 

- **RULE E1 (Application Incompatibility):**
  - *Boundary:* Fully automated task.
  - *Example:* Customer asks for WTZ-1800 (above-waterline only) for a submerged swimming pool.
  - *Action:* The bot handles this entirely. It actively REFUSES the quote, logs to audit, and asks the user for a different product. No human intervention is needed because the answer is definitively, technically wrong.
- **RULE E2 (GCC Large Deal):**
  - *Boundary:* Human authority required.
  - *Example:* A GCC deal volume exceeds AED 100/LM or requires a discount > 15%. 
  - *Action:* The bot has ZERO pricing authority (verified from 18-month historical audits). It drafts the quote structure, stops, and pings **Bijoy** via Telegram, refusing to quote a final price to the customer.
- **RULE E3 (KSA > SAR 500K):**
  - *Boundary:* Human authority required.
  - *Example:* Total quoted deal value in Saudi Arabia hits SAR 550,000.
  - *Action:* Same as E2. Automatically escalates to **Bijoy**.
- **RULE E4 (India Pricing):**
  - *Boundary:* Absolute hard break.
  - *Example:* Customer requests WE-50 in Mumbai.
  - *Action:* The bot *never* calculates India pricing because Pidilite channel rates fluctuate in ways the bot cannot access. It always drafts the spec and forwards the request to **Niranjan**.
- **RULE E5 (48-hour Timeout):**
  - *Boundary:* State detection vs Decision making.
  - *Example:* The bot asks Niranjan for pricing, and 48 hours pass with no reply.
  - *Action:* The bot can easily detect the silence, but cannot decide whether to push Niranjan harder or guess a price. It logs `action='pricing_timeout'` and escalates to **Bijoy** to break the deadlock.

---

## Question 3: JIORP spec for "generate GCC quotation"

The JIORP framework breaks down the exact operational boundary:

- **J (Job):** Generate a complete GCC quotation document.
- **I (Input):** `customer_id`, `project_name`, `products[]`, `quantities{}`, `region='GCC'`, `application_context`
- **O (Output):** A `quotes` record in Supabase + a PDF-named draft string sent to AK for review + a `bot_audit_log` entry.
- **R (Rules):** 
  - Must pass application guardrails.
  - Must NOT contain a price (requires pricing authority).
  - Draft file name must strictly follow: `[Country].[ProductType].[ProjectName].[AK].[Rev].pdf`.
  - Must include instructions to BCC `6235100@bcc.hubspot.com`.
- **P (Process):** 
  1. `runGuardrails()` (extract intent / block bad applications)
  2. `computePrice()` (calculates values to check trigger limits, returns escalation instruction)
  3. Notify Bijoy/Shylesh via Telegram
  4. Draft quote outline via Claude API
  5. `createQuote()` in Supabase
  6. `logAudit()` the action

---

## Question 4: Token economics at 200 conversations/day

**Assumptions per conversation:**
- 10 messages average
- 500 input tokens per message
- 300 output tokens per message

**Routing split (bot/index.ts & scheduler/followup.ts):**
- **80% (160 convos):** `claude-haiku-4-5-20251001` ($0.25 / 1M in, $1.25 / 1M out)
- **15% (30 convos):** `claude-sonnet-4-6` ($3.00 / 1M in, $15.00 / 1M out)
- **5% (10 convos):** Handled by hardcoded guardrails/escalations (0 API calls)
- **Scheduler:** 20 follow-ups/day using Haiku (est. 200 in, 150 out)

**Daily Haiku Cost:**
* 160 convos × 10 messages = 1,600 calls
* Input: 1,600 × 500 = 800,000 tokens = $0.20
* Output: 1,600 × 300 = 480,000 tokens = $0.60
* *Daily Haiku: $0.80*

**Daily Sonnet Cost:**
* 30 convos × 10 messages = 300 calls
* Input: 300 × 500 = 150,000 tokens = $0.45
* Output: 300 × 300 = 90,000 tokens = $1.35
* *Daily Sonnet: $1.80*

**Scheduler Cost (Haiku):**
* 20 calls × 200 input = 4,000 tokens = $0.001
* 20 calls × 150 output = 3,000 tokens = $0.004
* *Daily Scheduler: $0.005*

**Total Estimated Output**
- **Daily:** ~$2.60
- **Monthly (22 working days):** **~$57.20 / month**

> **Note on Prompt Caching:**
> We cache the system prompt as a persistent prefix via Anthropic prompt caching. Because the system prompt (rules, naming conventions, signatures) is large and identical across turns, caching it saves ~90% of the token cost for that static block on every subsequent turn in a conversation.

---

## Setup & Execution

### 1. Prerequisites
- **Node.js:** v18 or heavily compatible later version (Note: v20.11 via WSL may have `util` resolution bugs with Vite 3+; Node 22+ recommended).
- **Supabase:** Active account with pgvector support.
- **Telegram:** Bot token via `@BotFather`.
- **Anthropic AI:** API key.

### 2. Environment Variables
Copy the template and fill in your keys:
```bash
cp .env.example .env
```
Ensure you have set: `BOT_TOKEN`, `BIJOY_CHAT_ID`, `SHYLESH_CHAT_ID`, `NIRANJAN_CHAT_ID`, `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`.

### 3. Database Deployment
Deploy the schema (which enables pgvector, creates tables, and adds GCC/India rule seed data) to Supabase:
```bash
# If using supabase CLI
supabase db push schema.sql

# Or manually run the contents of schema.sql in the Supabase SQL editor
```

### 4. Running the Stack
Install dependencies:
```bash
npm install
```

Start the Telegram bot (handles user interactions):
```bash
npm run bot:start
```

In a separate terminal, start the standalone follow-up cron scheduler:
```bash
npm run scheduler
```

### 5. Running Tests
We use Vitest to mock the database and run isolated business logic tests for pricing rules, guardrails, and application intent blocks.

```bash
npx vitest tests/guardrails.test.ts
# or to run all tests
npm test
```
