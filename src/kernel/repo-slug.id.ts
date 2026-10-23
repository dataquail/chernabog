// A repo's identity: its owner/name on GitHub. Machine config keys a repo's
// settings by it, and so does every record about the repo, so they follow the
// repo rather than wherever its checkout is.

import * as Schema from 'effect/Schema';

export const RepoSlug = Schema.String.pipe(Schema.brand('RepoSlug'));

export type RepoSlug = typeof RepoSlug.Type;
