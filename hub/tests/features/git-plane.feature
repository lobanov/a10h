Feature: R2 task branches + pre-receive policy (git plane)
  Task branches are hub-precreated at promotion; the thin pre-receive hook
  enforces ref-match, token-match, fast-forward, and one-time force grants;
  verified-complete activities land on main through the serialized queue.

  Background:
    Given a plan with activity "alpha" is approved and promoted to a job

  Scenario: Promotion pre-creates the task branch with {branch, base_sha}
    Then the job carries branch "refs/tasks/alpha" and base_sha equal to main
    And the bare repo has ref "refs/tasks/alpha" pointing at main

  Scenario: Push to an unassigned ref is rejected
    When the hook is asked about a push of ref "refs/tasks/unknown" from old "seed" to a new commit
    Then the push is rejected with "no active job"

  Scenario: Push to a non-task ref is rejected
    When the hook is asked about a push of ref "refs/heads/feature" from old "seed" to a new commit
    Then the push is rejected with "only refs/tasks"

  Scenario: Push with a foreign node token is rejected when the job is leased
    Given the job is leased by node "worker-b"
    When node "worker-a" pushes a fast-forward commit to "refs/tasks/alpha"
    Then the push is rejected with "held by node"

  Scenario: Fast-forward push by the leasing node is accepted
    Given the job is leased by node "worker-a"
    When node "worker-a" pushes a fast-forward commit to "refs/tasks/alpha"
    Then the push is accepted

  Scenario: Non-fast-forward push without authorization is rejected
    Given the job is leased by node "worker-a"
    When node "worker-a" pushes a non-fast-forward commit to "refs/tasks/alpha"
    Then the push is rejected with "one-time authorization"

  Scenario: Authorized rebase push is accepted once, replay rejected
    Given the job is leased by node "worker-a"
    And the hub grants a one-time force authorization for "refs/tasks/alpha"
    When node "worker-a" pushes a non-fast-forward commit to "refs/tasks/alpha"
    Then the push is accepted
    When node "worker-a" pushes the same non-fast-forward commit to "refs/tasks/alpha" again
    Then the push is rejected with "one-time authorization"

  Scenario: Verified-complete activity fast-forward merges to main
    Given the job is leased by node "worker-a" and pushed a commit to "refs/tasks/alpha"
    And the job succeeded with gate pass and audit note
    When the scheduler lands verified activities
    Then main in the bare repo equals the "refs/tasks/alpha" tip

  Scenario: Concurrent landing produces one merge and one held rebase
    Given activities "alpha" and "beta" both verified-complete with diverged branches
    When the scheduler lands verified activities
    Then main in the bare repo has advanced to exactly one branch tip
    And exactly one rebase instruction exists for the other branch
    And a one-time force authorization is available for the other branch
