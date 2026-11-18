---
name: resolve-merge-conflict
description: Resolve merge conflicts between one of your pull requests and its base branch. Merge the base branch into the pull request's branch, resolve each conflict keeping the intent of both sides, verify, and push without rewriting history. Use when a follow-up names this skill and a pull request with merge conflicts.
---

# Resolve a pull request's merge conflicts

The follow-up gives you the pull request URL and, usually, its base branch. You
opened the pull request yourself, earlier in this session. Work through the
steps in order.

## 1. Check out the branch

```bash
gh pr view "$PR_URL" --json headRefName,baseRefName,mergeable,title
gh pr checkout "$PR_URL" && git pull --ff-only
```

Take `BASE` from `baseRefName`, not from the follow-up: the pull request may
have been retargeted since. If `mergeable` is `MERGEABLE`, someone resolved the
conflicts already: skip to step 6.

## 2. Plan

Report the plan with `report_plan`: "Merge `<base>` and resolve conflicts",
"Verify", "Push". Keep every earlier step.

## 3. Merge the base branch

```bash
git fetch origin "$BASE"
git merge "origin/$BASE"
```

Merge, never rebase: rebasing rewrites the commits reviewers have seen and
needs a force-push. `git status` lists the conflicted files.

## 4. Resolve every conflict

For each conflicted file, find out what the other side meant before you edit:

```bash
git log --oneline "HEAD...origin/$BASE" -- "$FILE"   # the commits on both sides that touched it
git show "$COMMIT"                                     # one of them, with its message
gh pr list --state merged --search "$COMMIT"           # the pull request that brought it in, for its description
```

Resolve so both sides' intent survives: your change applied on top of what
the base branch changed, not one side discarded. Code the base branch renamed,
moved or removed must stay renamed, moved or removed; adapt your change to it.
Look beyond the conflict markers too: a clean merge can still break, for
example a call to a function the base branch changed the signature of.

If a conflict cannot be resolved safely, because both sides change the same
behaviour in incompatible ways, or you cannot tell what one side meant, do not
guess. Abort with `git merge --abort`, then:

- `supervised` task: ask with `ask_question`, naming the files and both
  sides' intent, and end your turn. Continue from step 3 once you are resumed
  with the answer.
- `autonomous` task: call `report_failure` with the files and why they cannot
  be resolved safely.

Report every resolution that is more than taking both sides' changes side by
side with `report_decision` (the conflict as the problem, how you resolved it
and why), so the engineer sees it on the task.

## 5. Verify and push

- Verify as before you first reported ready: build, tests, typecheck, and the
  checks the repository defines. Fix what the merge broke.
- `git add` the resolved files and commit the merge with `git commit --no-edit`,
  or with a message that says how you resolved non-trivial conflicts.
- Push with a plain `git push`. Never force-push, never open a new pull request.

## 6. Finish

Mark the plan steps done with `report_plan`, then call `report_ready` and end
your turn.
