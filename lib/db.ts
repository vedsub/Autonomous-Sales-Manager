import { createClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CustomerCard {
    id: string;
    name: string;
    company: string | null;
    region: "GCC" | "India" | "SEA" | "NZ" | "Other" | null;
    email: string | null;
    channel_partner: string | null;
    preferred_honorific: string | null;
    preferences_notes: string | null;
    embedding: number[] | null;
    total_quotes: number;
    total_orders: number;
    conversion_rate: number;
    last_contact: string | null;
    created_at: string;
}

export interface QuoteInsert {
    customer_id: string;
    project_name: string;
    products: Record<string, unknown>;
    region?: string;
    value_estimate?: number;
    currency?: string;
    pricing_authority?: "Bijoy" | "Shylesh" | "Niranjan" | "Pending";
    status?: "DRAFT" | "SENT" | "FOLLOW_UP" | "WON" | "LOST" | "DORMANT" | "DEAD";
    file_name?: string;
    sent_at?: string;
    last_followup?: string;
    followup_count?: number;
}

export interface Quote extends QuoteInsert {
    id: string;
    days_since_sent: number | null;
    created_at: string;
}

export interface FollowUp {
    id: string;
    quote_id: string;
    day_number: number;
    scheduled_at: string;
    sent_at: string | null;
    message_text: string | null;
    created_at: string;
}

export interface PricingRule {
    id: string;
    region: string;
    product_family: string | null;
    material_multiplier_min: number;
    material_multiplier_max: number;
    shipping_multiplier_min: number;
    shipping_multiplier_max: number;
    gm_target: number;
    valid_until: string;
    notes: string | null;
    created_at: string;
}

export interface AuditLogEntry {
    id: string;
    session_id: string;
    telegram_user_id: string | null;
    action: string;
    input: string | null;
    output: string | null;
    confidence: number | null;
    escalated_to: string | null;
    timestamp: string;
}

// ---------------------------------------------------------------------------
// Custom errors
// ---------------------------------------------------------------------------

export class PricingExpiredError extends Error {
    region: string;
    expiredAt: string;

    constructor(region: string, expiredAt: string) {
        super(
            `Pricing rules for region "${region}" expired on ${expiredAt}. ` +
            `Escalate to pricing authority before quoting.`
        );
        this.name = "PricingExpiredError";
        this.region = region;
        this.expiredAt = expiredAt;
    }
}

// ---------------------------------------------------------------------------
// Supabase client
// ---------------------------------------------------------------------------

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
        "Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables."
    );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ---------------------------------------------------------------------------
// Data-access helpers
// ---------------------------------------------------------------------------

/**
 * Look up a customer by email address.
 * Returns the first matching CustomerCard or null.
 */
export async function getCustomerByEmail(
    email: string
): Promise<CustomerCard | null> {
    const { data, error } = await supabase
        .from("customer_cards")
        .select("*")
        .eq("email", email)
        .limit(1)
        .single();

    if (error && error.code === "PGRST116") return null; // no rows
    if (error) throw error;
    return data as CustomerCard;
}

/**
 * Insert a new quote and return the created row.
 */
export async function createQuote(data: QuoteInsert): Promise<Quote> {
    const { data: row, error } = await supabase
        .from("quotes")
        .insert(data)
        .select()
        .single();

    if (error) throw error;
    return row as Quote;
}

/**
 * Write a structured entry to bot_audit_log.
 */
export async function logAudit(
    action: string,
    input: string,
    output: string,
    confidence: number,
    sessionId: string,
    escalatedTo?: string
): Promise<void> {
    const { error } = await supabase.from("bot_audit_log").insert({
        session_id: sessionId,
        action,
        input,
        output,
        confidence,
        escalated_to: escalatedTo ?? null,
    });

    if (error) throw error;
}

/**
 * Retrieve pricing rules for a region.
 * Throws PricingExpiredError if the most-recent rule's valid_until is in the
 * past — the bot must escalate (per SPEC §3 F2) rather than compute a price.
 */
export async function getPricingRules(
    region: string
): Promise<PricingRule[]> {
    const { data, error } = await supabase
        .from("pricing_rules")
        .select("*")
        .eq("region", region)
        .order("valid_until", { ascending: false });

    if (error) throw error;
    if (!data || data.length === 0) {
        throw new Error(`No pricing rules found for region "${region}".`);
    }

    const rules = data as PricingRule[];

    // Check the most-recent rule for expiry (SPEC §3 F2 mitigation)
    const latest = rules[0];
    if (new Date(latest.valid_until) < new Date()) {
        throw new PricingExpiredError(region, latest.valid_until);
    }

    return rules;
}

/**
 * Return all follow-ups that are past their scheduled time but have not
 * been sent yet.
 */
export async function getOverdueFollowUps(): Promise<FollowUp[]> {
    const { data, error } = await supabase
        .from("follow_ups")
        .select("*")
        .lt("scheduled_at", new Date().toISOString())
        .is("sent_at", null)
        .order("scheduled_at", { ascending: true });

    if (error) throw error;
    return (data ?? []) as FollowUp[];
}
