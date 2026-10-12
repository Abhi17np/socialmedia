// Flags for UI that exists but isn't wired up yet — a flag here means
// "visible, not functional," not "hidden." Flip when the real feature
// is ready; nothing should need touching besides this file and the one
// spot that reads it.

// Pricing & Plans nav entry (TopBar): placeholder for a future
// self-serve plan page. Distinct from src/social/Billing.jsx (the
// "Workspace" settings page), which already does real Razorpay billing
// today and is untouched by this flag.
export const PRICING_PLANS_ENABLED = false;
