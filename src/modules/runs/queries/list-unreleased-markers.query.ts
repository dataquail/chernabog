import { Query } from "@effect-server-utils/cqrs";

import { RunMarkers } from "../domain/run-marker/run-marker-view.value-object.ts";

// What ended runs left on their items: markers still held, whose release is
// pending or keeps failing, and markers no flow defines a release for any
// more, for a person to take off. What a run in flight holds isn't listed.
export const ListUnreleasedMarkersQuery = Query.make("ListUnreleasedMarkersQuery", {
  success: RunMarkers,
});
