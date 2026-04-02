import "dotenv/config";
import { Telegraf } from "telegraf";
import Anthropic from "@anthropic-ai/sdk";
import { supabase, logAudit } from "../lib/db";
import { runGuardrails } from "../lib/guardrails";
import { computePrice } from "../lib/pricing";
import type { SessionContext } from "../lib/guardrails";
import type { PricingInput } from "../lib/pricing";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const BOT_TOKEN = process.env.BOT_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const BIJOY_CHAT_ID = process.env.BIJOY_CHAT_ID;
const SHYLESH_CHAT_ID = process.env.SHYLESH_CHAT_ID;
const NIRANJAN_CHAT_ID = process.env.NIRANJAN_CHAT_ID;

if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN in .env");
if (!ANTHROPIC_API_KEY) throw new Error("Missing ANTHROPIC_API_KEY in .env");

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const bot = new Telegraf(BOT_TOKEN);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// Session context shape stored in Supabase sessions.context JSONB
// ---------------------------------------------------------------------------

interface BotSessionContext {
    customerName: string;
    region: string;
    productCodes: string[];
    quantities: Record<string, number>;
    applicationContext: string;
    projectName: string;
    pricingAuthority: string;
    quoteId: string;
    messageHistory: { role: "user" | "assistant"; content: string }[];
}

function defaultContext(): BotSessionContext {
    return {
        customerName: "",
        region: "",
        productCodes: [],
        quantities: {},
        applicationContext: "",
        projectName: "",
        pricingAuthority: "",
        quoteId: "",
        messageHistory: [],
    };
}

// ---------------------------------------------------------------------------
// Session persistence (Supabase `sessions` table)
// ---------------------------------------------------------------------------

async function loadSession(chatId: string): Promise<BotSessionContext> {
    const { data, error } = await supabase
        .from("sessions")
        .select("context")
        .eq("chat_id", chatId)
        .single();

    if (error || !data) return defaultContext();
    return { ...defaultContext(), ...(data.context as BotSessionContext) };
}

async function saveSession(
    chatId: string,
    ctx: BotSessionContext
): Promise<void> {
    await supabase.from("sessions").upsert(
        {
            chat_id: chatId,
            context: ctx as unknown as Record<string, unknown>,
            last_updated: new Date().toISOString(),
        },
        { onConflict: "chat_id" }
    );
}

// ---------------------------------------------------------------------------
// Escalation chat-ID map
// ---------------------------------------------------------------------------

const ESCALATION_CHAT_IDS: Record<string, string | undefined> = {
    Bijoy: BIJOY_CHAT_ID,
    Shylesh: SHYLESH_CHAT_ID,
    Niranjan: NIRANJAN_CHAT_ID,
};

async function notifyAuthority(
    authority: string,
    summary: string
): Promise<void> {
    const chatId = ESCALATION_CHAT_IDS[authority];
    if (!chatId) {
        console.warn(
            `No chat ID configured for ${authority} — escalation message not sent.`
        );
        return;
    }
    try {
        await bot.telegram.sendMessage(
            chatId,
            `🔔 *Escalation — ${authority}*\n\n${summary}`,
            { parse_mode: "Markdown" }
        );
    } catch (err) {
        console.error(`Failed to notify ${authority}:`, err);
    }
}

// ---------------------------------------------------------------------------
// Claude API system prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(session: BotSessionContext): string {
    return `You are a sales support assistant for Genotek Global, an expansion joint cover company.
You help AK (the sales coordinator) draft quotes and manage customer inquiries.

HARD RULES — you MUST follow these without exception:
- You NEVER set a price. You NEVER compute or suggest a price.
- You NEVER confirm a delivery date without supplier confirmation.
- All prices come from Bijoy (GCC large/KSA), Shylesh (UAE small), or Niranjan (India).
- If asked for a price directly, say: "Pricing is being confirmed with [authority]. I'll update you as soon as it's received."
- Quote file naming: [Country].[ProductType].[ProjectName].[AK].[Rev].pdf
- Always BCC: 6235100@bcc.hubspot.com
- Sign-off: "Best Regards;"

Current session context: ${JSON.stringify(session)}`;
}

// ---------------------------------------------------------------------------
// /start command
// ---------------------------------------------------------------------------

bot.start(async (ctx) => {
    const chatId = String(ctx.chat.id);
    const session = defaultContext();
    await saveSession(chatId, session);

    await ctx.reply(
        `👋 Welcome to Genotek Sales Manager Bot!\n\n` +
        `I help AK draft quotes and manage customer inquiries for expansion joint covers.\n\n` +
        `To get started, please tell me:\n` +
        `1. Customer name\n` +
        `2. Region (GCC / India / SEA / NZ)\n\n` +
        `Or just send me an inquiry and I'll parse it automatically.\n\n` +
        `Commands:\n` +
        `/status — View current session\n` +
        `/reset — Clear session\n` +
        `/quote — Compile quote from current session`
    );
});

// ---------------------------------------------------------------------------
// /status command
// ---------------------------------------------------------------------------

bot.command("status", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const session = await loadSession(chatId);

    const lines = [
        `📋 *Session Status*\n`,
        `*Customer:* ${session.customerName || "—"}`,
        `*Region:* ${session.region || "—"}`,
        `*Products:* ${session.productCodes.length > 0 ? session.productCodes.join(", ") : "—"}`,
        `*Quantities:* ${Object.keys(session.quantities).length > 0 ? Object.entries(session.quantities).map(([k, v]) => `${k}: ${v} LM`).join(", ") : "—"}`,
        `*Project:* ${session.projectName || "—"}`,
        `*Application:* ${session.applicationContext || "—"}`,
        `*Pricing Authority:* ${session.pricingAuthority || "Pending"}`,
        `*Quote ID:* ${session.quoteId || "—"}`,
        `*Messages in context:* ${session.messageHistory.length}`,
    ];

    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
});

// ---------------------------------------------------------------------------
// /reset command
// ---------------------------------------------------------------------------

bot.command("reset", async (ctx) => {
    const chatId = String(ctx.chat.id);
    await saveSession(chatId, defaultContext());
    await ctx.reply("🔄 Session cleared. Send a new inquiry to start fresh.");
});

// ---------------------------------------------------------------------------
// /quote command
// ---------------------------------------------------------------------------

bot.command("quote", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const session = await loadSession(chatId);

    if (session.productCodes.length === 0 || !session.region) {
        await ctx.reply(
            "⚠️ Not enough information to compile a quote yet.\n\n" +
            "I need at least: product code(s), region, and project name.\n" +
            "Send me the inquiry details or use /status to see what's missing."
        );
        return;
    }

    // Build a quote compilation prompt for Claude
    const quotePrompt =
        `Compile a professional quote summary from this session context. ` +
        `Include: customer name, project name, products with quantities, region, ` +
        `recommended file name using format [Country].[ProductType].[ProjectName].[AK].[Rev].pdf, ` +
        `and a reminder to BCC 6235100@bcc.hubspot.com. ` +
        `Do NOT include any prices — state that pricing is pending authority confirmation.`;

    session.messageHistory.push({ role: "user", content: quotePrompt });
    if (session.messageHistory.length > 20) {
        session.messageHistory = session.messageHistory.slice(-20);
    }

    try {
        const response = await anthropic.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 2048,
            system: buildSystemPrompt(session),
            messages: session.messageHistory.map((m) => ({
                role: m.role,
                content: m.content,
            })),
        });

        const reply =
            response.content[0].type === "text"
                ? response.content[0].text
                : "Unable to generate quote summary.";

        session.messageHistory.push({ role: "assistant", content: reply });
        if (session.messageHistory.length > 20) {
            session.messageHistory = session.messageHistory.slice(-20);
        }
        await saveSession(chatId, session);

        await logAudit(
            "CLAUDE_RESPONSE",
            quotePrompt,
            reply,
            0.85,
            chatId
        );

        await ctx.reply(reply);
    } catch (err) {
        console.error("Claude API error during /quote:", err);
        await ctx.reply("❌ Error generating quote summary. Please try again.");
    }
});

// ---------------------------------------------------------------------------
// Main message handler
// ---------------------------------------------------------------------------

bot.on("text", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const message = ctx.message.text;

    // ------------------------------------------------------------------
    // 1. Load session
    // ------------------------------------------------------------------
    const session = await loadSession(chatId);

    // ------------------------------------------------------------------
    // 2. Add user message to history (keep last 20)
    // ------------------------------------------------------------------
    session.messageHistory.push({ role: "user", content: message });
    if (session.messageHistory.length > 20) {
        session.messageHistory = session.messageHistory.slice(-20);
    }

    // ------------------------------------------------------------------
    // 3. Run guardrails
    // ------------------------------------------------------------------
    const sessionCtx: SessionContext = {
        sessionId: chatId,
        region: session.region || undefined,
        productCodes: session.productCodes,
        quantities: session.quantities,
        applicationContext: session.applicationContext || undefined,
        projectName: session.projectName || undefined,
        customerName: session.customerName || undefined,
    };

    const guardrailResult = runGuardrails(message, sessionCtx);

    // ------------------------------------------------------------------
    // 4. If blocked → reply with reason, audit, return early
    // ------------------------------------------------------------------
    if (guardrailResult.blocked) {
        const blockMsg =
            `🚫 *Request Blocked*\n\n${guardrailResult.blockReason}\n\n` +
            `Please specify a different product or application. Which product would you like instead?`;

        await ctx.reply(blockMsg, { parse_mode: "Markdown" });

        await logAudit(
            "GUARDRAIL_BLOCK",
            message,
            guardrailResult.blockReason || "Blocked",
            1.0,
            chatId
        );

        await saveSession(chatId, session);
        return;
    }

    // ------------------------------------------------------------------
    // 5. Merge parsed intent into session context
    // ------------------------------------------------------------------
    const intent = guardrailResult.parsedIntent;
    if (intent) {
        if (intent.productCodes.length > 0) {
            // Merge product codes (deduplicate)
            const merged = new Set([...session.productCodes, ...intent.productCodes]);
            session.productCodes = [...merged];
        }
        if (Object.keys(intent.quantities).length > 0) {
            session.quantities = { ...session.quantities, ...intent.quantities };
        }
        if (intent.region && intent.region !== "Other") {
            session.region = intent.region;
        }
        if (intent.applicationContext) {
            session.applicationContext = intent.applicationContext;
        }
        if (intent.projectName) {
            session.projectName = intent.projectName;
        }
        if (intent.customerName) {
            session.customerName = intent.customerName;
        }
    }

    // ------------------------------------------------------------------
    // 6. If product codes + region found → pricing / escalation check
    // ------------------------------------------------------------------
    let escalationNote = "";

    if (session.productCodes.length > 0 && session.region) {
        for (const code of session.productCodes) {
            const pricingInput: PricingInput = {
                region: session.region,
                productCode: code,
                materialCostUSD: 0, // unknown at this stage
                shippingCostUSD: 0, // unknown at this stage
                quantityLM: session.quantities[code] ?? 0,
            };

            try {
                const pricingResult = await computePrice(pricingInput);

                if (pricingResult.requiresEscalation && pricingResult.escalateTo) {
                    session.pricingAuthority = pricingResult.escalateTo;

                    const summary =
                        `📋 *New Inquiry Escalation*\n` +
                        `*Product:* ${code}\n` +
                        `*Region:* ${session.region}\n` +
                        `*Quantity:* ${session.quantities[code] ?? "TBD"} LM\n` +
                        `*Customer:* ${session.customerName || "TBD"}\n` +
                        `*Project:* ${session.projectName || "TBD"}\n` +
                        `*Reason:* ${pricingResult.escalationReason}`;

                    await notifyAuthority(pricingResult.escalateTo, summary);

                    escalationNote =
                        `\n\n📌 I've flagged this to *${pricingResult.escalateTo}* for pricing. ` +
                        `I'll draft the quote structure while we wait.`;

                    await logAudit(
                        "ESCALATION",
                        message,
                        `Escalated to ${pricingResult.escalateTo}: ${pricingResult.escalationReason}`,
                        0.9,
                        chatId,
                        pricingResult.escalateTo
                    );
                }
            } catch (err) {
                console.error(`Pricing error for ${code}:`, err);
            }
        }
    }

    // ------------------------------------------------------------------
    // 7. Call Claude API
    // ------------------------------------------------------------------
    try {
        const response = await anthropic.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 2048,
            system: buildSystemPrompt(session),
            messages: session.messageHistory.map((m) => ({
                role: m.role,
                content: m.content,
            })),
        });

        const claudeReply =
            response.content[0].type === "text"
                ? response.content[0].text
                : "I'm unable to process this request right now.";

        // ------------------------------------------------------------------
        // 8. Audit log the Claude API call
        // ------------------------------------------------------------------
        await logAudit("CLAUDE_RESPONSE", message, claudeReply, 0.85, chatId);

        // ------------------------------------------------------------------
        // 9. Send response to user
        // ------------------------------------------------------------------
        session.messageHistory.push({ role: "assistant", content: claudeReply });
        if (session.messageHistory.length > 20) {
            session.messageHistory = session.messageHistory.slice(-20);
        }
        await saveSession(chatId, session);

        const fullReply = claudeReply + escalationNote;
        await ctx.reply(fullReply, { parse_mode: "Markdown" });
    } catch (err) {
        console.error("Claude API error:", err);
        await ctx.reply(
            "❌ I encountered an error processing your request. Please try again."
        );
        await saveSession(chatId, session);
    }
});

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

bot.launch();
console.log("🤖 Genotek Sales Manager Bot is running...");

// Graceful shutdown
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
