-- ============================================================
-- Genotek Sales Manager Bot — Supabase PostgreSQL Schema
-- ============================================================

-- Enable pgvector for embedding similarity search
create extension if not exists vector;

-- ============================================================
-- CUSTOMER CARDS
-- ============================================================
create table customer_cards (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  company              text,
  region               text check (region in ('GCC', 'India', 'SEA', 'NZ', 'Other')),
  email                text,
  channel_partner      text,
  preferred_honorific  text,
  preferences_notes    text,
  embedding            vector(1536),
  total_quotes         int default 0,
  total_orders         int default 0,
  conversion_rate      float default 0,
  last_contact         timestamptz,
  created_at           timestamptz default now()
);

-- ============================================================
-- QUOTES
-- ============================================================
create table quotes (
  id                 uuid primary key default gen_random_uuid(),
  customer_id        uuid references customer_cards(id),
  project_name       text not null,
  products           jsonb not null,
  region             text,
  value_estimate     float,
  currency           text default 'USD',
  pricing_authority  text check (pricing_authority in ('Bijoy', 'Shylesh', 'Niranjan', 'Pending')),
  status             text check (status in ('DRAFT', 'SENT', 'FOLLOW_UP', 'WON', 'LOST', 'DORMANT', 'DEAD')),
  file_name          text,
  sent_at            timestamptz,
  last_followup      timestamptz,
  followup_count     int default 0,
  days_since_sent    int generated always as (extract(day from now() - sent_at)::int) stored,
  created_at         timestamptz default now()
);

-- ============================================================
-- FOLLOW-UPS
-- ============================================================
create table follow_ups (
  id            uuid primary key default gen_random_uuid(),
  quote_id      uuid references quotes(id),
  day_number    int check (day_number in (3, 7, 14, 30, 60, 96)),
  scheduled_at  timestamptz not null,
  sent_at       timestamptz,
  message_text  text,
  created_at    timestamptz default now()
);

-- ============================================================
-- PRICING RULES
-- ============================================================
create table pricing_rules (
  id                       uuid primary key default gen_random_uuid(),
  region                   text not null,
  product_family           text,
  material_multiplier_min  float not null,
  material_multiplier_max  float not null,
  shipping_multiplier_min  float not null,
  shipping_multiplier_max  float not null,
  gm_target                float default 0.55,
  valid_until              timestamptz not null,
  notes                    text,
  created_at               timestamptz default now()
);

-- ============================================================
-- BOT AUDIT LOG
-- ============================================================
create table bot_audit_log (
  id                uuid primary key default gen_random_uuid(),
  session_id        text not null,
  telegram_user_id  text,
  action            text not null,
  input             text,
  output            text,
  confidence        float check (confidence between 0 and 1),
  escalated_to      text,
  timestamp         timestamptz default now()
);

-- ============================================================
-- SEED DATA — pricing_rules
-- ============================================================
insert into pricing_rules (region, product_family, material_multiplier_min, material_multiplier_max,
                           shipping_multiplier_min, shipping_multiplier_max, gm_target, valid_until, notes)
values
  ('GCC',   null, 2.0, 3.0, 1.5, 2.0, 0.55, now() + interval '90 days',
   'Standard GCC multiplier: material×2–3 + shipping×1.5–2, targeting 55% GM'),

  ('India', null, 1.0, 1.0, 1.0, 1.0, 0.55, now() + interval '90 days',
   'Pidilite base + installation — multipliers are 1× (pricing is not multiplier-based)'),

  ('SEA',   null, 2.5, 2.5, 2.0, 2.0, 0.55, now() + interval '90 days',
   'Ankara×2.5 material + sea freight×2');
