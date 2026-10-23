import { EnrolledReposRepositoryLive } from './infrastructure/repositories/enrolled-repos.repository-live.ts';

// The enrollment module's live adapters, for a composition root to provide.
export const EnrollmentLayer = EnrolledReposRepositoryLive;
