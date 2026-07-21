Feature: SFTP ingestion connector — observability surface
  The SFTP ingestion ORCE flow exposes a namespaced health endpoint and a
  Prometheus metrics endpoint on the shared ORCE runtime.

  Background:
    Given the SFTP ingestion flow is deployed on a reachable ORCE runtime

  Scenario: Health endpoint reports the service status
    When I GET "/api/v1/sftp/health"
    Then the response status is 200
    And the JSON field "status" is present

  Scenario: Metrics endpoint exposes the DLQ counter family
    When I GET "/sftp/metrics"
    Then the response status is 200
    And the body contains "facis_sftp"
