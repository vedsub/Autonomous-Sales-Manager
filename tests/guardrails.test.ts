import { describe, it, expect } from "vitest";
import { runGuardrails, SessionContext } from "../lib/guardrails";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const emptySession: SessionContext = {
    sessionId: "test-session-001",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runGuardrails", () => {
    // -----------------------------------------------------------------------
    // CRITICAL TEST — WTZ-1800 submerged pool must ALWAYS be blocked
    // -----------------------------------------------------------------------
    it("WTZ-1800 submerged pool is ALWAYS blocked", () => {
        const result = runGuardrails(
            "Please quote WTZ-1800 for a submerged pool project in Dubai, 500 LM",
            emptySession
        );
        expect(result.blocked).toBe(true);
        expect(result.blockReason).toContain("WTZ-1800");
        expect(result.blockReason).toContain("above-waterline");
        expect(result.auditEntry.action).toBe("GUARDRAIL_BLOCK");
        // Confirm no price was ever computed
        expect(result.parsedIntent).toBeUndefined();
    });

    // -----------------------------------------------------------------------
    // WTZ-1800 for rooftop → NOT blocked (rooftop is allowed)
    // -----------------------------------------------------------------------
    it("WTZ-1800 for a rooftop project is NOT blocked", () => {
        const result = runGuardrails(
            "Quote WTZ-1800 for a rooftop project in Abu Dhabi, 200 LM",
            emptySession
        );
        expect(result.blocked).toBe(false);
        expect(result.parsedIntent).toBeDefined();
        expect(result.parsedIntent!.productCodes).toContain("WTZ-1800");
        expect(result.parsedIntent!.region).toBe("GCC");
    });

    // -----------------------------------------------------------------------
    // WTZ-1700 for swimming pool → NOT blocked (WTZ-1700 allows submerged)
    // -----------------------------------------------------------------------
    it("WTZ-1700 for a swimming pool in Singapore is NOT blocked", () => {
        const result = runGuardrails(
            "Quote WTZ-1700 for a swimming pool in Singapore, 300 LM",
            emptySession
        );
        expect(result.blocked).toBe(false);
        expect(result.parsedIntent).toBeDefined();
        expect(result.parsedIntent!.productCodes).toContain("WTZ-1700");
        expect(result.parsedIntent!.region).toBe("SEA");
    });

    // -----------------------------------------------------------------------
    // Empty message → blocked=false, action=CLARIFICATION_NEEDED
    // -----------------------------------------------------------------------
    it("Empty message returns CLARIFICATION_NEEDED", () => {
        const result = runGuardrails("", emptySession);
        expect(result.blocked).toBe(false);
        expect(result.auditEntry.action).toBe("CLARIFICATION_NEEDED");
    });

    // -----------------------------------------------------------------------
    // Quote request without product code → CLARIFICATION_NEEDED
    // -----------------------------------------------------------------------
    it("Quote request without product codes asks for clarification", () => {
        const result = runGuardrails(
            "Can I get a price for expansion joint covers for a mall in Dubai?",
            emptySession
        );
        expect(result.blocked).toBe(false);
        expect(result.auditEntry.action).toBe("CLARIFICATION_NEEDED");
        expect(result.parsedIntent).toBeDefined();
        expect(result.parsedIntent!.productCodes).toEqual([]);
        expect(result.parsedIntent!.region).toBe("GCC");
    });

    // -----------------------------------------------------------------------
    // Quantity + region extraction
    // -----------------------------------------------------------------------
    it("Correctly parses quantities and region from message", () => {
        const result = runGuardrails(
            "Need WTZ-1700 for a facade in KSA, 1500 LM total",
            emptySession
        );
        expect(result.blocked).toBe(false);
        expect(result.parsedIntent!.quantities["WTZ-1700"]).toBe(1500);
        expect(result.parsedIntent!.region).toBe("GCC");
    });

    // -----------------------------------------------------------------------
    // India region detection
    // -----------------------------------------------------------------------
    it("Detects India region from city name", () => {
        const result = runGuardrails(
            "Quote WE-50 for an interior project in Mumbai, 100 meters",
            emptySession
        );
        expect(result.blocked).toBe(false);
        expect(result.parsedIntent!.region).toBe("India");
        expect(result.parsedIntent!.productCodes).toContain("WE-50");
    });
});
