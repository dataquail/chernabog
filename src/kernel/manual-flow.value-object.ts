// A manual flow has no trigger, so nothing finds its work: it runs only when a
// person names an item. How a person starts one, for the messages that say so.

// The flow `chernabog start <issue>` runs.
export const START_FLOW = "human-initiated";

export const howToStart = (flow: string) => {
  if (flow === START_FLOW) {
    return "chernabog start <issue>";
  }

  return `chernabog run ${flow} --item <key>`;
};

// Why a manual flow started nothing when no one named its work.
export const nothingNamed = (flow: string) =>
  `${flow} is a manual flow: it runs only when someone names the work, so use ${howToStart(flow)}`;

// What status shows for a manual flow in place of its schedule.
export const manualSchedule = (flow: string) => `manual (${howToStart(flow)})`;
