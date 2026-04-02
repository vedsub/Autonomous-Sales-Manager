import { checkApplicationCompatibility } from "./pricing";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionContext {
    sessionId: string;
    customerId?: string;
    region?: string;
    productCodes?: string[];
    quantities?: Record<string, number>;
    applicationContext?: string;
    projectName?: string;
    customerName?: string;
}

export interface ParsedIntent {
    productCodes: string[];
    quantities: Record<string, number>;
    region: string;
    applicationContext: string;
    projectName: string;
    customerName: string;
}

export interface AuditEntry {
    action: string;
    input: string;
    output: string;
    confidence: number;
}

export interface GuardrailResult {
    blocked: boolean;
    blockReason?: string;
    parsedIntent?: ParsedIntent;
    auditEntry: AuditEntry;
}

// ---------------------------------------------------------------------------
// Region detection map
// ---------------------------------------------------------------------------

const REGION_KEYWORDS: Record<string, string> = {
    gcc: "GCC",
    uae: "GCC",
    dubai: "GCC",
    "abu dhabi": "GCC",
    sharjah: "GCC",
    bahrain: "GCC",
    qatar: "GCC",
    oman: "GCC",
    kuwait: "GCC",
    ksa: "GCC",
    "saudi arabia": "GCC",
    "saudi": "GCC",
    riyadh: "GCC",
    jeddah: "GCC",
    india: "India",
    mumbai: "India",
    delhi: "India",
    chennai: "India",
    bangalore: "India",
    sea: "SEA",
    singapore: "SEA",
    thailand: "SEA",
    malaysia: "SEA",
    indonesia: "SEA",
    vietnam: "SEA",
    philippines: "SEA",
    nz: "NZ",
    "new zealand": "NZ",
    auckland: "NZ",
};

// ---------------------------------------------------------------------------
// Quote-request keyword set
// ---------------------------------------------------------------------------

const QUOTE_REQUEST_KEYWORDS = [
    "quote",
    "price",
    "rfq",
    "inquiry",
    "quotation",
    "pricing",
    "estimate",
    "proposal",
    "cost",
];

// ---------------------------------------------------------------------------
// Intent extraction helpers
// ---------------------------------------------------------------------------

function extractProductCodes(message: string): string[] {
    const regex = /W[A-Z]{1,2}-\d{3,4}/g;
    const matches = message.match(regex);
    return matches ? [...new Set(matches)] : [];
}

function extractRegion(message: string): string {
    const lower = message.toLowerCase();

    // Check multi-word keywords first (longer match wins)
    const sortedKeywords = Object.keys(REGION_KEYWORDS).sort(
        (a, b) => b.length - a.length
    );

    for (const keyword of sortedKeywords) {
        if (lower.includes(keyword)) {
            return REGION_KEYWORDS[keyword];
        }
    }

    return "Other";
}

function extractQuantities(message: string): Record<string, number> {
    const quantities: Record<string, number> = {};

    // Match patterns like "500 LM", "200 meter", "100m", "300 m"
    const qtyRegex = /(\d+(?:,\d{3})*(?:\.\d+)?)\s*(?:LM|lm|meter|meters|m\b)/g;
    let match: RegExpExecArray | null;

    const allQuantities: number[] = [];
    while ((match = qtyRegex.exec(message)) !== null) {
        const value = parseFloat(match[1].replace(/,/g, ""));
        allQuantities.push(value);
    }

    // Associate quantities with product codes if we can
    const productCodes = extractProductCodes(message);

    if (productCodes.length === 1 && allQuantities.length >= 1) {
        // Single product — sum all quantities
        quantities[productCodes[0]] = allQuantities.reduce((a, b) => a + b, 0);
    } else if (productCodes.length > 0 && allQuantities.length > 0) {
        // Best-effort: pair in order
        for (let i = 0; i < productCodes.length; i++) {
            quantities[productCodes[i]] = allQuantities[i] ?? allQuantities[0];
        }
    }

    return quantities;
}

function looksLikeQuoteRequest(message: string): boolean {
    const lower = message.toLowerCase();
    return QUOTE_REQUEST_KEYWORDS.some((kw) => lower.includes(kw));
}

// ---------------------------------------------------------------------------
// Main guardrail function
// ---------------------------------------------------------------------------

/**
 * Run the guardrail pipeline on an incoming message.
 *
 * 1. Extract structured intent (product codes, region, quantities)
 * 2. Check each product's application compatibility
 * 3. If no products but looks like a quote request → CLARIFICATION_NEEDED
 * 4. All clear → return parsed intent
 */
export function runGuardrails(
    message: string,
    sessionContext: SessionContext
): GuardrailResult {
    // ------------------------------------------------------------------
    // STEP 1 — Extract structured intent from raw message
    // ------------------------------------------------------------------
    const productCodes = extractProductCodes(message);
    const region = extractRegion(message) || sessionContext.region || "Other";
    const quantities = extractQuantities(message);
    const applicationContext = message; // full message for semantic check

    const parsedIntent: ParsedIntent = {
        productCodes,
        quantities,
        region,
        applicationContext,
        projectName: sessionContext.projectName ?? "",
        customerName: sessionContext.customerName ?? "",
    };

    // ------------------------------------------------------------------
    // STEP 2 — Application compatibility check for every product code
    // ------------------------------------------------------------------
    for (const code of productCodes) {
        const compat = checkApplicationCompatibility(code, applicationContext);
        if (!compat.safe) {
            return {
                blocked: true,
                blockReason: compat.reason,
                auditEntry: {
                    action: "GUARDRAIL_BLOCK",
                    input: message,
                    output: compat.reason!,
                    confidence: 1.0,
                },
            };
        }
    }

    // ------------------------------------------------------------------
    // STEP 3 — No product codes but looks like a quote request
    // ------------------------------------------------------------------
    if (productCodes.length === 0 && looksLikeQuoteRequest(message)) {
        return {
            blocked: false,
            parsedIntent,
            auditEntry: {
                action: "CLARIFICATION_NEEDED",
                input: message,
                output: "No product codes found in quote request — clarification needed",
                confidence: 0.5,
            },
        };
    }

    // ------------------------------------------------------------------
    // STEP 4 — Empty / non-quote message
    // ------------------------------------------------------------------
    if (productCodes.length === 0 && !looksLikeQuoteRequest(message)) {
        return {
            blocked: false,
            parsedIntent,
            auditEntry: {
                action: "CLARIFICATION_NEEDED",
                input: message,
                output: "Message does not appear to be a quote request",
                confidence: 0.3,
            },
        };
    }

    // ------------------------------------------------------------------
    // STEP 5 — All checks pass
    // ------------------------------------------------------------------
    return {
        blocked: false,
        parsedIntent,
        auditEntry: {
            action: "INTENT_PARSED",
            input: message,
            output: JSON.stringify(parsedIntent),
            confidence: 0.9,
        },
    };
}
