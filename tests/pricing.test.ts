import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkApplicationCompatibility } from "../lib/pricing";
import type { PricingInput } from "../lib/pricing";

// ---------------------------------------------------------------------------
// Mock lib/db so we never hit a real Supabase instance
// ---------------------------------------------------------------------------
vi.mock("../lib/db", () => {
    const PricingExpiredError = class PricingExpiredError extends Error {
        region: string;
        expiredAt: string;
        constructor(region: string, expiredAt: string) {
            super(`Pricing rules for region "${region}" expired on ${expiredAt}.`);
            this.name = "PricingExpiredError";
            this.region = region;
            this.expiredAt = expiredAt;
        }
    };

    return {
        PricingExpiredError,
        getPricingRules: vi.fn(),
    };
});

// Import AFTER the mock is set up
import { computePrice } from "../lib/pricing";
import { getPricingRules, PricingExpiredError } from "../lib/db";

const mockGetPricingRules = vi.mocked(getPricingRules);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validGCCRule() {
    return {
        id: "rule-gcc",
        region: "GCC",
        product_family: null,
        material_multiplier_min: 2.0,
        material_multiplier_max: 3.0,
        shipping_multiplier_min: 1.5,
        shipping_multiplier_max: 2.0,
        gm_target: 0.55,
        valid_until: new Date(Date.now() + 86400_000 * 90).toISOString(),
        notes: null,
        created_at: new Date().toISOString(),
    };
}

function validIndiaRule() {
    return {
        id: "rule-india",
        region: "India",
        product_family: null,
        material_multiplier_min: 1.0,
        material_multiplier_max: 1.0,
        shipping_multiplier_min: 1.0,
        shipping_multiplier_max: 1.0,
        gm_target: 0.55,
        valid_until: new Date(Date.now() + 86400_000 * 90).toISOString(),
        notes: null,
        created_at: new Date().toISOString(),
    };
}

function gccInput(overrides: Partial<PricingInput> = {}): PricingInput {
    return {
        region: "GCC",
        productCode: "WTZ-1700",
        materialCostUSD: 10,
        shippingCostUSD: 5,
        quantityLM: 100,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("checkApplicationCompatibility", () => {
    it("WTZ-1800 + 'submerged pool' → safe=false", () => {
        const result = checkApplicationCompatibility(
            "WTZ-1800",
            "submerged pool in Dubai"
        );
        expect(result.safe).toBe(false);
        expect(result.reason).toContain("WTZ-1800");
        expect(result.reason).toContain("above-waterline only");
    });

    it("WTZ-1800 + 'exterior facade' → safe=true", () => {
        const result = checkApplicationCompatibility(
            "WTZ-1800",
            "exterior facade expansion joint"
        );
        expect(result.safe).toBe(true);
    });

    it("WTZ-1700 + 'submerged pool' → safe=true (WTZ-1700 supports pools)", () => {
        const result = checkApplicationCompatibility(
            "WTZ-1700",
            "submerged pool area"
        );
        expect(result.safe).toBe(true);
    });
});

describe("computePrice", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("GCC with 10% discount → no discount-based escalation (still escalates for value threshold)", async () => {
        mockGetPricingRules.mockResolvedValue([validGCCRule()]);

        const result = await computePrice(gccInput({ discountPercent: 10 }));

        // Should NOT escalate due to discount (10% < 15%)
        expect(result.escalationReason).not.toContain("Discount exceeds 15%");
        // Price should be computed (breakdown present)
        expect(result.breakdown).not.toBeNull();
        expect(result.quotedPrice).toBeGreaterThan(0);
    });

    it("GCC with 20% discount → escalate to Bijoy", async () => {
        mockGetPricingRules.mockResolvedValue([validGCCRule()]);

        const result = await computePrice(gccInput({ discountPercent: 20 }));

        expect(result.requiresEscalation).toBe(true);
        expect(result.escalateTo).toBe("Bijoy");
        expect(result.escalationReason).toBe("Discount exceeds 15%");
    });

    it("Expired pricing rules → escalate to Bijoy", async () => {
        mockGetPricingRules.mockRejectedValue(
            new PricingExpiredError("GCC", "2025-01-01T00:00:00Z")
        );

        const result = await computePrice(gccInput());

        expect(result.requiresEscalation).toBe(true);
        expect(result.escalateTo).toBe("Bijoy");
        expect(result.escalationReason).toContain("Pricing rules expired");
        expect(result.quotedPrice).toBe(0);
        expect(result.breakdown).toBeNull();
    });

    it("India pricing → always escalate to Niranjan, never compute price", async () => {
        mockGetPricingRules.mockResolvedValue([validIndiaRule()]);

        const result = await computePrice({
            region: "India",
            productCode: "WE-50",
            materialCostUSD: 10,
            shippingCostUSD: 5,
            quantityLM: 200,
        });

        expect(result.requiresEscalation).toBe(true);
        expect(result.escalateTo).toBe("Niranjan");
        expect(result.escalationReason).toContain("Pidilite base rate");
        expect(result.quotedPrice).toBe(0);
        expect(result.breakdown).toBeNull();
    });

    it("SEA pricing computes price with correct multipliers", async () => {
        mockGetPricingRules.mockResolvedValue([
            {
                id: "rule-sea",
                region: "SEA",
                product_family: null,
                material_multiplier_min: 2.5,
                material_multiplier_max: 2.5,
                shipping_multiplier_min: 2.0,
                shipping_multiplier_max: 2.0,
                gm_target: 0.55,
                valid_until: new Date(Date.now() + 86400_000 * 90).toISOString(),
                notes: null,
                created_at: new Date().toISOString(),
            },
        ]);

        const result = await computePrice({
            region: "SEA",
            productCode: "WTZ-1700",
            materialCostUSD: 10,
            shippingCostUSD: 5,
            quantityLM: 100,
        });

        // material: 10 * 2.5 = 25, shipping: 5 * 2.0 = 10 → per LM = 35 → total = 3500
        expect(result.quotedPrice).toBe(3500);
        expect(result.breakdown?.materialMultiplier).toBe(2.5);
        expect(result.breakdown?.shippingMultiplier).toBe(2.0);
        expect(result.gmPercent).toBeGreaterThan(0);
    });
});
