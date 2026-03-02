import * as cdk from "aws-cdk-lib";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

/**
 * Consumer Queue Pattern - Standard Queue with DLQ
 *
 * Each consuming domain maintains its own SQS queue.
 * EventBridge Rules target this queue with domain events.
 *
 * Configuration:
 * - Type: Standard Queue (maximum scale for high-volume events)
 * - Visibility Timeout: 6x Lambda timeout (prevents "ghost" retries)
 * - DLQ: Captures failed messages after maxReceiveCount
 * - Message Retention: 14 days (default, long enough for investigation)
 */
export interface ConsumerQueueConstructProps {
  environment: string;
  regionCode: string;
  consumerDomainName: string; // e.g., "maker-domain"
  queueName: string; // e.g., "auth-events" or "product-events"
  lambdaTimeoutSeconds?: number; // Default: 60, used to calculate visibility timeout (6x)
  removalPolicy?: cdk.RemovalPolicy;
}

export class ConsumerQueueConstruct extends Construct {
  public readonly queue: sqs.Queue;
  public readonly dlq: sqs.Queue;

  constructor(scope: Construct, id: string, props: ConsumerQueueConstructProps) {
    super(scope, id);

    const removalPolicy = props.removalPolicy ?? cdk.RemovalPolicy.DESTROY;
    const lambdaTimeout = props.lambdaTimeoutSeconds ?? 60;
    const visibilityTimeout = lambdaTimeout * 6; // Safety Net: 6x lambda timeout

    // Dead Letter Queue
    this.dlq = new sqs.Queue(this, "DLQ", {
      queueName: `${props.environment}-${props.regionCode}-${props.consumerDomainName}-${props.queueName}-dlq`,
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy,
      encryption: sqs.QueueEncryption.KMS_MANAGED,
    });

    // Standard Queue (high-volume, at-least-once delivery)
    this.queue = new sqs.Queue(this, "Queue", {
      queueName: `${props.environment}-${props.regionCode}-${props.consumerDomainName}-${props.queueName}`,
      visibilityTimeout: cdk.Duration.seconds(visibilityTimeout),
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy,
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      deadLetterQueue: {
        queue: this.dlq,
        maxReceiveCount: 5, // Move to DLQ after 5 failed attempts
      },
    });
  }
}
