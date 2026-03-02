import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

/**
 * Transactional Outbox Table (Atomic Outbox Pattern)
 *
 * Every domain maintains its own outbox table. When a business operation completes,
 * the event and the state change are written atomically in a single TransactWriteItems call.
 *
 * States:
 * - PENDING: Event written but not yet sent to EventBridge
 * - SENT: Event successfully delivered to EventBridge (marked by Republish Lambda)
 * - FAILED: Event failed after max retries (manual intervention required)
 */
export interface OutboxTableConstructProps {
  environment: string;
  regionCode: string;
  domainName: string; // e.g., "collector-domain"
  removalPolicy?: cdk.RemovalPolicy;
}

export class OutboxTableConstruct extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: OutboxTableConstructProps) {
    super(scope, id);

    const removalPolicy = props.removalPolicy ?? cdk.RemovalPolicy.DESTROY;

    this.table = new dynamodb.Table(this, "OutboxTable", {
      tableName: `${props.environment}-${props.regionCode}-${props.domainName}-outbox`,
      partitionKey: {
        name: "eventId",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.environment === "prod" },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: "expiresAt",
      // Enable Global Secondary Index for "Safety Net" recovery (find PENDING events older than 2 minutes)
    });

    // GSI-StatusCreatedAt: Used by Republish Lambda to query PENDING events
    // The lambda fetches all PENDING events older than 2 minutes and resends them
    this.table.addGlobalSecondaryIndex({
      indexName: "GSI-StatusCreatedAt",
      partitionKey: {
        name: "status",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: "createdAt",
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });
  }
}
