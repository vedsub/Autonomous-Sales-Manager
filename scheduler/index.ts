import "dotenv/config";
import cron from "node-cron";
import { runFollowUpScheduler } from "./followup";

// ---------------------------------------------------------------------------
// Cron schedules
// ---------------------------------------------------------------------------

// Run every hour — process any overdue follow-ups + deal death detector
cron.schedule("0 * * * *", () => {
    console.log("⏰ Hourly follow-up scheduler triggered");
    runFollowUpScheduler().catch((err) => {
        console.error("Scheduler run failed:", err);
    });
});

// Run daily at 8 AM UTC (≈ 12 PM GST for GCC, 1:30 PM IST for India)
cron.schedule("0 8 * * *", () => {
    console.log("🌅 Daily 8 AM UTC scheduler triggered (GCC/India morning)");
    runFollowUpScheduler().catch((err) => {
        console.error("Daily scheduler run failed:", err);
    });
});

// Run daily at 1 AM UTC (≈ 8 AM SGT/ICT for SEA)
cron.schedule("0 1 * * *", () => {
    console.log("🌅 Daily 1 AM UTC scheduler triggered (SEA morning)");
    runFollowUpScheduler().catch((err) => {
        console.error("SEA scheduler run failed:", err);
    });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

console.log("📅 Genotek Follow-Up Scheduler started.");
console.log("   Schedules:");
console.log("   • Every hour  — overdue follow-ups + deal death detector");
console.log("   • 8 AM UTC    — GCC/India morning run");
console.log("   • 1 AM UTC    — SEA morning run");
console.log("");

// Run once immediately on startup
runFollowUpScheduler().catch((err) => {
    console.error("Initial scheduler run failed:", err);
});
