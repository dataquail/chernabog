// trust.json as it sits in the chernabog home: one object, by repo slug, of the
// tree of .chernabog/ a person trusted and when. The trust records repository
// writes it and the trust queries read it, so its shape is named once, here;
// what a record means stays the domain's, and turning one into a root the
// repository's mapper's.

import * as Schema from "effect/Schema";

export const TrustEntry = Schema.Struct({ tree: Schema.String, at: Schema.String });

export type TrustEntry = typeof TrustEntry.Type;

export const TrustFile = Schema.fromJsonString(Schema.Record(Schema.String, TrustEntry), {
  space: 2,
});

export type TrustFile = typeof TrustFile.Type;
