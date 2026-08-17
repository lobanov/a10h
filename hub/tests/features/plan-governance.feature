Feature: Plan governance
  As the research lab supervisor
  Plans must be approved before execution, gates must verify evidence,
  and failures must route back for repair

  Background:
    Given a plan graph with gated activity "alpha" and dependent "beta"

  Scenario: Submission blocks execution until approved
    When the plan is submitted
    Then the plan status is "pending_approval"
    And a pending plan approval exists
    And no jobs exist for the plan
    When the scheduler ticks
    Then no jobs exist for the plan

  Scenario: Approval schedules dependency-free activities only
    Given the plan is submitted
    When the plan approval is approved
    And the scheduler ticks
    Then exactly 1 job exists for the plan
    And activity "alpha" is "running"
    And activity "beta" is "pending"

  Scenario: Good evidence passes the gate and unlocks dependents
    Given the plan is submitted and approved
    And the scheduler has ticked
    When a worker completes the job of "alpha" with final_loss 0.2
    And the scheduler ticks
    Then activity "alpha" is "passed"
    And the last gate verdict for "alpha" is "pass"
    And exactly 2 jobs exist for the plan

  Scenario: Bad evidence fails the gate and triggers repair
    Given the plan is submitted and approved
    And the scheduler has ticked
    When a worker completes the job of "alpha" with final_loss 0.9
    And the scheduler ticks
    Then the last gate verdict for "alpha" is "fail"
    And activity "alpha" is "running"
    And exactly 2 jobs exist for the plan

  Scenario: Cyclic graphs are rejected
    When a cyclic plan graph is submitted
    Then the response status is 400
