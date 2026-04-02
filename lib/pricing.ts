import { getPricingRules, PricingExpiredError } from "./db";
import type { PricingRule } from "./db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PricingInput {
    region: string;
    productCode: string;
    materialCostUSD: number;
    shippingCostUSD: number;
    quantityLM: number;
    discountPercent?: number;
}

export interface PricingBreakdown {
    baseMaterialCost: number;
    baseShippingCost: number;
    materialMultiplier: number;
    shippingMultiplier: number;
    subtotal: number;
    discountAmount: number;
}

export interface PricingOutput {
    quotedPrice: number;
    gmPercent: number;
    requiresEscalation: boolean;
    escalateTo: string | null;
    escalationReason: string | null;
    breakdown: PricingBreakdown | null;
}

// ---------------------------------------------------------------------------
// Application compatibility check
// ---------------------------------------------------------------------------

interface ProductApplicationRule {
    allowed_applications: string[];
    blocked_keywords: string[];
}

const PRODUCT_APPLICATION_RULES: Record<string, ProductApplicationRule> = {
    "WTZ-1800": {
        allowed_applications: ["above-waterline", "exterior", "roof", "facade"],
        blocked_keywords: [
            "submerged",
            "pool",
            "underwater",
            "wet area",
            "below waterline",
            "swimming",
        ],
    },
    "WTZ-1700": {
        allowed_applications: [
            "general",
            "interior",
            "exterior",
            "submerged",
            "pool",
        ],
        blocked_keywords: [],
    },
    "WE-50": {
        allowed_applications: ["general", "interior", "exterior"],
        blocked_keywords: [],
    },
};

/**
 * Check whether a product is safe for the described application context.
 * Returns { safe: true } or { safe: false, reason: '...' }.
 */
export function checkApplicationCompatibility(
    productCode: string,
    applicationContext: string
): { safe: boolean; reason?: string } {
    const rules = PRODUCT_APPLICATION_RULES[productCode];

    if (!rules) {
        // Unknown product — let it through; product-master validation happens elsewhere
        return { safe: true };
    }

    const ctx = applicationContext.toLowerCase();

    for (const keyword of rules.blocked_keywords) {
        if (ctx.includes(keyword)) {
            return {
                safe: false,
                reason:
                    `${productCode} is not rated for ${keyword} applications. ` +
                    `${productCode} is above-waterline only.`,
            };
        }
    }

    return { safe: true };
}

// ---------------------------------------------------------------------------
// Pricing computation
// ---------------------------------------------------------------------------

function midpoint(min: number, max: number): number {
    return (min + max) / 2;
}

function buildEscalation(
    escalateTo: string,
    escalationReason: string
): PricingOutput {
    return {
        quotedPrice: 0,
        gmPercent: 0,
        requiresEscalation: true,
        escalateTo,
        escalationReason,
        breakdown: null,
    };
}

function computeGM(
    quotedPrice: number,
    materialCost: number,
    shippingCost: number
): number {
    if (quotedPrice === 0) return 0;
    return (quotedPrice - materialCost - shippingCost) / quotedPrice;
}

/**
 * Compute a quoted price using region-specific pricing rules.
 *
 * - GCC: midpoint multipliers, GM target 55 %, discount & value thresholds
 * - India: ALWAYS escalates to Niranjan — no price is ever computed
 * - SEA: material × 2.5 + shipping × 2.0, GM check
 * - Other regions: escalate to Bijoy
 */
export async function computePrice(
    input: PricingInput
): Promise<PricingOutput> {
    // ------------------------------------------------------------------
    // Step 1 — Fetch pricing rules (may throw PricingExpiredError)
    // ------------------------------------------------------------------
    let rules: PricingRule[];
    try {
        rules = await getPricingRules(input.region);
    } catch (err) {
        if (err instanceof PricingExpiredError) {
            return buildEscalation(
                "Bijoy",
                "Pricing rules expired — Bijoy must confirm current multipliers"
            );
        }
        throw err; // unexpected error — don't swallow
    }

    const rule = rules[0]; // most recent valid rule

    // ------------------------------------------------------------------
    // Step 2 — Region-specific logic
    // ------------------------------------------------------------------

    // ---- INDIA ----
    if (input.region === "India") {
        return buildEscalation(
            "Niranjan",
            "India pricing requires Pidilite base rate from Niranjan"
        );
    }

    // ---- GCC ----
    if (input.region === "GCC") {
        const matMult = midpoint(
            rule.material_multiplier_min,
            rule.material_multiplier_max
        );
        const shipMult = midpoint(
            rule.shipping_multiplier_min,
            rule.shipping_multiplier_max
        );

        const materialCharged = input.materialCostUSD * matMult;
        const shippingCharged = input.shippingCostUSD * shipMult;
        let subtotal = (materialCharged + shippingCharged) * input.quantityLM;

        const discountPct = input.discountPercent ?? 0;
        const discountAmount = subtotal * (discountPct / 100);
        const quotedPrice = subtotal - discountAmount;

        const totalCost =
            (input.materialCostUSD + input.shippingCostUSD) * input.quantityLM;
        const gm = computeGM(quotedPrice, totalCost, 0);

        const breakdown: PricingBreakdown = {
            baseMaterialCost: input.materialCostUSD,
            baseShippingCost: input.shippingCostUSD,
            materialMultiplier: matMult,
            shippingMultiplier: shipMult,
            subtotal,
            discountAmount,
        };

        // Discount > 15 % → Bijoy (SPEC E2)
        if (discountPct > 15) {
            return {
                quotedPrice,
                gmPercent: gm,
                requiresEscalation: true,
                escalateTo: "Bijoy",
                escalationReason: "Discount exceeds 15%",
                breakdown,
            };
        }

        // GM below target → Bijoy
        if (gm < (rule.gm_target ?? 0.55)) {
            return {
                quotedPrice,
                gmPercent: gm,
                requiresEscalation: true,
                escalateTo: "Bijoy",
                escalationReason: "GM below 55% target",
                breakdown,
            };
        }

        // KSA value > SAR 500 K → Bijoy (SPEC E3)
        // (Approximate SAR ≈ 3.75 × USD)
        const valueInSAR = quotedPrice * 3.75;
        if (valueInSAR > 500_000) {
            return {
                quotedPrice,
                gmPercent: gm,
                requiresEscalation: true,
                escalateTo: "Bijoy",
                escalationReason: "KSA deal value exceeds SAR 500K",
                breakdown,
            };
        }

        // UAE deal < AED 100/LM → Shylesh auto-approve
        const pricePerLM = quotedPrice / input.quantityLM;
        const pricePerLMAED = pricePerLM * 3.67; // approximate AED conversion
        if (pricePerLMAED < 100) {
            return {
                quotedPrice,
                gmPercent: gm,
                requiresEscalation: true,
                escalateTo: "Shylesh",
                escalationReason: "UAE deal under AED 100/LM — Shylesh auto-approve",
                breakdown,
            };
        }

        // GCC deal > AED 100/LM → Bijoy (SPEC E2)
        return {
            quotedPrice,
            gmPercent: gm,
            requiresEscalation: true,
            escalateTo: "Bijoy",
            escalationReason:
                "GCC deal value exceeds AED 100/LM — requires Bijoy approval",
            breakdown,
        };
    }

    // ---- SEA ----
    if (input.region === "SEA") {
        const matMult = 2.5;
        const shipMult = 2.0;

        const materialCharged = input.materialCostUSD * matMult;
        const shippingCharged = input.shippingCostUSD * shipMult;
        let subtotal = (materialCharged + shippingCharged) * input.quantityLM;

        const discountPct = input.discountPercent ?? 0;
        const discountAmount = subtotal * (discountPct / 100);
        const quotedPrice = subtotal - discountAmount;

        const totalCost =
            (input.materialCostUSD + input.shippingCostUSD) * input.quantityLM;
        const gm = computeGM(quotedPrice, totalCost, 0);

        const breakdown: PricingBreakdown = {
            baseMaterialCost: input.materialCostUSD,
            baseShippingCost: input.shippingCostUSD,
            materialMultiplier: matMult,
            shippingMultiplier: shipMult,
            subtotal,
            discountAmount,
        };

        if (gm < 0.55) {
            return {
                quotedPrice,
                gmPercent: gm,
                requiresEscalation: true,
                escalateTo: "Bijoy",
                escalationReason: "GM below 55% target",
                breakdown,
            };
        }

        return {
            quotedPrice,
            gmPercent: gm,
            requiresEscalation: false,
            escalateTo: null,
            escalationReason: null,
            breakdown,
        };
    }

    // ---- ALL OTHER REGIONS ----
    return buildEscalation(
        "Bijoy",
        `No automated pricing logic for region "${input.region}" — requires Bijoy`
    );
}
