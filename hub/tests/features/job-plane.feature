Feature: Hub job plane
  As a worker runner
  I interact with the hub over pull-only HTTP
  So that work executes without inbound connections to workers

  Scenario: Health check
    When I GET "/api/health"
    Then the response status is 200
    And the response body field "ok" is the boolean true

  Scenario: Invalid progress events are rejected
    Given a queued job "t-invalid"
    When the worker posts a progress event with pct 150
    Then the response status is 400

  Scenario: Work pull grants a lease exactly once
    Given a queued job "t-lease"
    When worker "w1" pulls work
    And worker "w2" pulls work
    Then worker "w1" receives job "t-lease"
    And worker "w2" receives no job
