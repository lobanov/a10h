Feature: Worker agent sessions (R4 — register-then-offer, SSE instructions)
  The worker registers at the hub, waits on its own SSE instruction stream
  (no polling loop), consumes instructions as agent turns, acks idempotently,
  reconnects with full unacked redelivery, and exits only on the exit signal
  — deferred while busy.

  Scenario: Session lifecycle — register, receive offer, ack, deferred exit
    Given a fake hub with SSE instruction streams
    When the worker agent registers
    Then it holds a session id
    When the hub offers instruction 1 as "work_offer" with a quick job
    And the hub sends instruction 2 as "gate_feedback"
    Then the worker acked instruction 1 with offer acceptance
    And the worker consumed instructions 1 and 2 as turns
    And the worker is still operational — no exit before the signal
    When the hub sends instruction 3 as "exit"
    Then the worker consumed instruction 3 as a turn
    And the worker exits after the exit signal while idle

  Scenario: Reconnect redelivers unacked instructions
    Given a fake hub with SSE instruction streams
    When the worker agent registers
    And the hub offers instruction 1 as "work_offer" with a quick job
    And the worker disconnects without acking
    And the worker reconnects
    Then the worker receives instruction 1 again — at-least-once

  Scenario: The worker never polls for work
    Given a fake hub with SSE instruction streams
    When the worker agent registers
    And the hub sends instruction 1 as "custom" and the worker processes it
    Then no work-poll request was made
