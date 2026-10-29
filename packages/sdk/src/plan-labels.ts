// The labels of a plan's life on its spec: queued, proposed and waiting on a
// person, approved, and made into an epic. Plan.LABELS; here, apart, so
// implement's trigger can find epics without importing the plan recipe.
export const LABELS = {
  plan: "auto:plan",
  proposed: "auto:plan-proposed",
  approved: "auto:plan-approved",
  epic: "auto:epic",
} as const;
