/**
 * EventBridge Helper Utility
 *
 * Provides helper functions for importing the shared EventBridge bus.
 * This ensures all domains use the same EventBridge bus without creating duplicates.
 */

import * as events from "aws-cdk-lib/aws-events";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

/**
 * Import EventBridge bus from Shared Infra via SSM
 *
 * IMPORTANT: This function IMPORTS the bus, it does NOT create it.
 * Only Shared Infra creates the EventBridge bus.
 */
export function importEventBusFromSharedInfra(
  scope: Construct,
  environment: string
): events.IEventBus {
  const eventBusName = ssm.StringParameter.fromStringParameterName(
    scope,
    "ImportedEventBusName",
    `/${environment}/shared-infra/eventbridge/event-bus-name`
  ).stringValue;

  return events.EventBus.fromEventBusName(
    scope,
    "ImportedEventBus",
    eventBusName
  );
}
