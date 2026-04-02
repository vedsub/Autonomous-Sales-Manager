import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { supabase, getOverdueFollowUps, logAudit } from "../lib/db";
import type { FollowUp } from "../lib/db";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const BIJOY_CHAT_ID = process.env.BIJOY_CHAT_ID;
const BOT_TOKEN = process.env.BOT_TOKEN;

if (!ANTHROPIC_API_KEY) throw new Error("Missing ANTHROPIC_API_KEY in .env");

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// Follow-up milestone progression
// ---------------------------------------------------------------------------

const NEXT_MILESTONE: Record<number, number | null> = {
    3: 7,
    7: 14,
    14: 30,
    30: 60,
    60: 96,
    96: null, // terminal — deal death
};

const ALERT_BIJOY_AT = [30, 60, 96]; // Day 30+ → alert Bijoy

// ---------------------------------------------------------------------------
// Telegram notification helper (lightweight — no full Telegraf needed)
// ---------------------------------------------------------------------------

async function sendTelegramMessage(
    chatId: string,
    text: string
): Promise<void> {
    if (!BOT_TOKEN || !chatId) return;
    try {
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
        await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: chatId,
                text,
                parse_mode: "Markdown",
            }),
        });
    } catch (err) {
        console.error("Telegram notification failed:", err);
    }
}

// ---------------------------------------------------------------------------
// Generate follow-up message via Claude Haiku
// ---------------------------------------------------------------------------

async function generateFollowUpMessage(params: {
    customerName: string;
    company: string;
    projectName: string;
    products: string;
    followupNumber: number;
    dayNumber: number;
    region: string;
    daysSinceLastContact: number;
}): Promise<string> {
    const prompt = `Generate a professional follow-up email for:
- Customer: ${params.customerName}, Company: ${params.company}
- Project: ${params.projectName}
- Products: ${params.products}
- This is follow-up number ${params.followupNumber} (Day ${params.dayNumber})
- Region: ${params.region}
- Previous contact: ${params.daysSinceLastContact} days ago
Rules: Be specific to the project. Never generic. No price discussion. Sign off: 'Best Regards;'
For GCC: formal English. For India: warmer, relationship-first. For SEA: professional, concise.`;

    const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
    });

    return response.content[0].type === "text"
        ? response.content[0].text
        : "Follow-up message could not be generated.";
}

// ---------------------------------------------------------------------------
// Schedule next follow-up milestone
// ---------------------------------------------------------------------------

async function scheduleNextFollowUp(
    quoteId: string,
    currentDayNumber: number
): Promise<void> {
    const nextDay = NEXT_MILESTONE[currentDayNumber];
    if (nextDay === null || nextDay === undefined) return; // terminal or unknown

    const daysUntilNext = nextDay - currentDayNumber;
    const scheduledAt = new Date();
    scheduledAt.setDate(scheduledAt.getDate() + daysUntilNext);

    const { error } = await supabase.from("follow_ups").insert({
        quote_id: quoteId,
        day_number: nextDay,
        scheduled_at: scheduledAt.toISOString(),
    });

    if (error) {
        console.error(`Failed to schedule Day ${nextDay} follow-up for quote ${quoteId}:`, error);
    } else {
        console.log(`📅 Scheduled Day ${nextDay} follow-up for quote ${quoteId} at ${scheduledAt.toISOString()}`);
    }
}

// ---------------------------------------------------------------------------
// Process a single overdue follow-up
// ---------------------------------------------------------------------------

async function processFollowUp(followUp: FollowUp): Promise<void> {
    const quoteId = followUp.quote_id;
    const dayNumber = followUp.day_number;

    // ---- a. Load parent quote ----
    const { data: quote, error: quoteErr } = await supabase
        .from("quotes")
        .select("*")
        .eq("id", quoteId)
        .single();

    if (quoteErr || !quote) {
        console.error(`Quote ${quoteId} not found for follow-up ${followUp.id}`);
        return;
    }

    // ---- Load customer ----
    let customerName = "Valued Customer";
    let company = "";
    let region = quote.region || "Other";

    if (quote.customer_id) {
        const { data: customer } = await supabase
            .from("customer_cards")
            .select("*")
            .eq("id", quote.customer_id)
            .single();

        if (customer) {
            customerName = customer.name;
            company = customer.company || "";
            region = customer.region || region;
        }
    }

    // ---- b. Determine follow-up number ----
    const followUpIndex = [3, 7, 14, 30, 60, 96].indexOf(dayNumber);
    const followupNumber = followUpIndex >= 0 ? followUpIndex + 1 : 1;

    // ---- c. Generate message via Claude ----
    const products =
        typeof quote.products === "object"
            ? JSON.stringify(quote.products)
            : String(quote.products);

    const daysSinceLastContact = quote.days_since_sent ?? dayNumber;

    let messageText: string;
    try {
        messageText = await generateFollowUpMessage({
            customerName,
            company,
            projectName: quote.project_name,
            products,
            followupNumber,
            dayNumber,
            region,
            daysSinceLastContact,
        });
    } catch (err) {
        console.error(`Claude API error for follow-up ${followUp.id}:`, err);
        messageText = `Follow-up #${followupNumber} (Day ${dayNumber}) for project ${quote.project_name}`;
    }

    // ---- d. Send follow-up (mock: console log + update sent_at) ----
    console.log(`\n📧 FOLLOW-UP SENT — Day ${dayNumber}`);
    console.log(`   Quote: ${quoteId}`);
    console.log(`   Customer: ${customerName} (${company})`);
    console.log(`   Project: ${quote.project_name}`);
    console.log(`   Message:\n${messageText}\n`);

    const now = new Date().toISOString();

    // Mark follow-up as sent
    await supabase
        .from("follow_ups")
        .update({ sent_at: now, message_text: messageText })
        .eq("id", followUp.id);

    // Update quote last_followup and followup_count
    await supabase
        .from("quotes")
        .update({
            last_followup: now,
            followup_count: (quote.followup_count ?? 0) + 1,
        })
        .eq("id", quoteId);

    // ---- e. Audit log ----
    await logAudit(
        "FOLLOW_UP_SENT",
        quoteId,
        messageText,
        0.9,
        "scheduler"
    );

    // ---- f. Schedule next milestone ----
    await scheduleNextFollowUp(quoteId, dayNumber);

    // ---- Alert Bijoy at Day 30+ ----
    if (ALERT_BIJOY_AT.includes(dayNumber) && BIJOY_CHAT_ID) {
        const alertMsg =
            `⚠️ *Follow-Up Alert — Day ${dayNumber}*\n\n` +
            `*Quote:* ${quoteId}\n` +
            `*Customer:* ${customerName} (${company})\n` +
            `*Project:* ${quote.project_name}\n` +
            `*Region:* ${region}\n` +
            `*Status:* No response after ${dayNumber} days`;

        await sendTelegramMessage(BIJOY_CHAT_ID, alertMsg);
    }

    // ---- Day 96 → mark deal DEAD ----
    if (dayNumber === 96) {
        await supabase
            .from("quotes")
            .update({ status: "DEAD" })
            .eq("id", quoteId);

        await logAudit(
            "DEAL_DEATH",
            quoteId,
            "96 days exceeded — marked DEAD",
            1.0,
            "scheduler",
            "Bijoy"
        );

        if (BIJOY_CHAT_ID) {
            await sendTelegramMessage(
                BIJOY_CHAT_ID,
                `💀 *Deal Marked DEAD*\n\n` +
                `*Quote:* ${quoteId}\n` +
                `*Customer:* ${customerName}\n` +
                `*Project:* ${quote.project_name}\n` +
                `96 days with no response.`
            );
        }

        console.log(`💀 Quote ${quoteId} marked as DEAD (96 days exceeded)`);
    }
}

// ---------------------------------------------------------------------------
// Deal Death Detector — catch any quotes that slipped past milestones
// ---------------------------------------------------------------------------

async function runDealDeathDetector(): Promise<void> {
    console.log("\n🔍 Running deal death detector...");

    const { data: staleQuotes, error } = await supabase
        .from("quotes")
        .select("*")
        .not("status", "in", '("WON","LOST","DEAD")')
        .gte("days_since_sent", 96);

    if (error) {
        console.error("Deal death detector query failed:", error);
        return;
    }

    if (!staleQuotes || staleQuotes.length === 0) {
        console.log("   No stale quotes found.");
        return;
    }

    for (const quote of staleQuotes) {
        console.log(`💀 Marking quote ${quote.id} as DEAD (${quote.days_since_sent} days)`);

        await supabase
            .from("quotes")
            .update({ status: "DEAD" })
            .eq("id", quote.id);

        await logAudit(
            "DEAL_DEATH",
            quote.id,
            `${quote.days_since_sent} days exceeded`,
            1.0,
            "scheduler",
            "Bijoy"
        );

        if (BIJOY_CHAT_ID) {
            let customerName = "Unknown";
            if (quote.customer_id) {
                const { data: customer } = await supabase
                    .from("customer_cards")
                    .select("name")
                    .eq("id", quote.customer_id)
                    .single();
                if (customer) customerName = customer.name;
            }

            await sendTelegramMessage(
                BIJOY_CHAT_ID,
                `💀 *Deal Marked DEAD*\n\n` +
                `*Quote:* ${quote.id}\n` +
                `*Customer:* ${customerName}\n` +
                `*Project:* ${quote.project_name}\n` +
                `${quote.days_since_sent} days with no response.`
            );
        }
    }

    console.log(`   Processed ${staleQuotes.length} stale quote(s).`);
}

// ---------------------------------------------------------------------------
// Main scheduler entry point
// ---------------------------------------------------------------------------

export async function runFollowUpScheduler(): Promise<void> {
    const startTime = Date.now();
    console.log(`\n${"=".repeat(60)}`);
    console.log(`🕐 Follow-Up Scheduler — ${new Date().toISOString()}`);
    console.log(`${"=".repeat(60)}`);

    // ---- Step 1: Process overdue follow-ups ----
    try {
        const overdueFollowUps = await getOverdueFollowUps();
        console.log(`\n📋 Found ${overdueFollowUps.length} overdue follow-up(s).`);

        for (const followUp of overdueFollowUps) {
            try {
                await processFollowUp(followUp);
            } catch (err) {
                console.error(`Error processing follow-up ${followUp.id}:`, err);
            }
        }
    } catch (err) {
        console.error("Failed to fetch overdue follow-ups:", err);
    }

    // ---- Step 2: Deal death detector ----
    try {
        await runDealDeathDetector();
    } catch (err) {
        console.error("Deal death detector failed:", err);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✅ Scheduler run completed in ${elapsed}s.\n`);
}
