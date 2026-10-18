import { expect, test } from 'bun:test';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';

import { eligibleIssuesFrom, interpretCreateRefResponse, type LabelledIssueNode, orderClaimCandidates, statusChangeFor } from './issues.ts';

const board = { projectNumber: 31, readyStatus: 'Ready', inProgressStatus: 'In Progress' };

const onProject = (number: number, status: Option.Option<string>) => ({ project: { number }, status: Option.map(status, (name) => ({ name })) });

const labelled = (number: number, items: LabelledIssueNode['projectItems']['nodes'] = []): LabelledIssueNode => ({
  number,
  title: `Issue ${number}`,
  body: Option.none(),
  url: `https://github.com/dataquail/demo/issues/${number}`,
  createdAt: `2026-10-0${number}T00:00:00Z`,
  labels: { nodes: [{ name: 'auto:eligible' }] },
  projectItems: { nodes: items },
});

const readyIssue = labelled(1, [onProject(31, Option.some('Ready'))]);
const triageIssue = labelled(2, [onProject(31, Option.some('Triage'))]);

const numbers = (issues: ReadonlyArray<{ readonly number: number }>) => issues.map((issue) => issue.number);

test('without a board, the label alone makes an issue eligible', () => {
  expect(numbers(eligibleIssuesFrom([readyIssue, triageIssue, labelled(3)], Option.none()))).toEqual([1, 2, 3]);
});

test('with a board, an auto:eligible issue must also have the ready Status', () => {
  expect(numbers(eligibleIssuesFrom([readyIssue, triageIssue], Option.some(board)))).toEqual([1]);
});

test('a ready Status on some other project does not count', () => {
  expect(eligibleIssuesFrom([labelled(4, [onProject(7, Option.some('Ready'))])], Option.some(board))).toEqual([]);
});

test('with a board, an issue on no project, or with no Status set, is not eligible', () => {
  expect(eligibleIssuesFrom([labelled(5), labelled(6, [onProject(31, Option.none())])], Option.some(board))).toEqual([]);
});

test('candidates are tried oldest issue first', () => {
  const ordered = orderClaimCandidates([
    { number: 300, createdAt: '2026-10-03T00:00:00Z' },
    { number: 100, createdAt: '2026-10-01T00:00:00Z' },
    { number: 200, createdAt: '2026-10-02T00:00:00Z' },
  ]);

  expect(numbers(ordered)).toEqual([100, 200, 300]);
});

test('GitHub creating the ref is a successful claim', () => {
  expect(interpretCreateRefResponse(201, Option.some({ ref: 'refs/heads/auto/issue-100' }))).toEqual(Result.succeed('created'));
});

test("GitHub's 422 for an existing ref means another run won the claim", () => {
  expect(interpretCreateRefResponse(422, Option.some({ message: 'Reference already exists', status: '422' }))).toEqual(Result.succeed('already-exists'));
});

test('any other failure to create the ref stops the claim rather than skipping the issue', () => {
  const failure = (status: number, message: string) => Result.getFailure(interpretCreateRefResponse(status, Option.some({ message })));
  expect(Option.getOrElse(failure(422, 'Object does not exist'), () => '')).toMatch(/Object does not exist/);
  expect(Option.getOrElse(failure(403, 'Resource not accessible by integration'), () => '')).toMatch(/403/);
});

const statusField = {
  id: 'PVT_project',
  field: { id: 'PVTSSF_status', options: [{ id: 'opt-ready', name: 'Ready' }, { id: 'opt-progress', name: 'In Progress' }] },
};

const issueProjectItems = { id: 'I_issue', projectItems: { nodes: [{ id: 'PVTI_item', project: { number: 31 } }] } };

test("claiming moves the issue to in progress on the repo's board, as a person picking it up would", () => {
  expect(statusChangeFor(statusField, issueProjectItems, board, board.inProgressStatus)).toEqual(
    Result.succeed({ projectId: 'PVT_project', itemId: 'PVTI_item', fieldId: 'PVTSSF_status', optionId: 'opt-progress' }),
  );
});

test('an issue that is not on the board cannot have its Status moved', () => {
  const onAnotherProject = { ...issueProjectItems, projectItems: { nodes: [{ id: 'PVTI_other', project: { number: 7 } }] } };
  expect(statusChangeFor(statusField, onAnotherProject, board, board.inProgressStatus)).toEqual(Result.fail('The issue is not on project #31'));
});

test('a Status the board does not offer is an error rather than a silent no-op', () => {
  expect(statusChangeFor(statusField, issueProjectItems, board, 'Doing')).toEqual(Result.fail('Project #31 has no "Doing" option for Status'));
});
