Feature: Secretary agent duties (R6 — handoff, verification role, retention)
  The secretary authors the work handoff on every offer, performs formal
  gate verification (absorbing the v1 auditor role), and commits an attempt
  summary note to main for every closed attempt. It never decides research
  direction and never performs adversarial review.

  Background:
    Given a plan with activity "alpha" is approved and promoted to a job

  Scenario: Work offers carry secretary-authored handoff details
    When the job's offer is fetched from the instruction outbox
    Then the offer payload carries handoff with branch and artifact paths
    And the handoff constraints forbid deciding research direction

  Scenario: Gate verification is recorded by the secretary role
    Given the job is leased by node "worker-a" and pushed a commit to "refs/tasks/alpha"
    And the job succeeded with gate pass and audit note
    Then the verification note is recorded under the secretary role

  Scenario: A merged attempt gets a summary note committed to main
    Given the job is leased by node "worker-a" and pushed a commit to "refs/tasks/alpha"
    And the job succeeded with gate pass and audit note
    When the scheduler lands verified activities and runs retention
    Then main in the bare repo contains an attempt note referencing the task branch

  Scenario: The secretary skill carries the hard constraints
    Then the framework secretary skill forbids deciding research direction
    And the framework secretary skill forbids adversarial review
