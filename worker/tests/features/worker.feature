Feature: Worker runner behavior
  As the worker half of the hub-worker plane
  I parse capabilities, discover progress streams, relay events,
  honor cancellation, and manage checkouts

  Scenario: Capability tags are parsed from NODE_TAGS
    When tags are parsed from "cpu:4,gpu,vram:24G"
    Then the tag "cpu" is 4
    And the tag "gpu" is true
    And the tag "vram" is "24G"

  Scenario: Progress files are discovered anywhere under the workspace
    Given a workspace containing progress.jsonl at "runs/exp1/progress.jsonl", "out/progress.jsonl" and ".git/progress.jsonl"
    When progress files are discovered
    Then 2 progress files are found
    And none of them are inside .git

  Scenario: New progress lines are relayed to the hub
    Given a fake hub capturing job events
    And a workspace containing progress.jsonl at "runs/x/progress.jsonl"
    When the progress tailer runs for job "relay-1" and 2 valid lines are appended
    Then the fake hub received 2 events for job "relay-1"
    And each event has fields "t", "pct" and "stage"

  Scenario: Cancellation flag stops the tailer
    Given a fake hub capturing job events that requests cancellation
    And a workspace containing progress.jsonl at "runs/y/progress.jsonl"
    When the progress tailer runs for job "cancel-1" and 2 valid lines are appended
    Then the cancellation callback was invoked
    And the fake hub received exactly 1 event for job "cancel-1"

  Scenario: Checkouts clone the project repo into the work dir
    Given a git origin repo containing "seed.txt"
    And REPO_PATH pointing at the origin and WORK_DIR pointing at an empty dir
    When a checkout is created for job "clone-1"
    Then the checkout contains "seed.txt"
    And the checkout is not the origin itself
