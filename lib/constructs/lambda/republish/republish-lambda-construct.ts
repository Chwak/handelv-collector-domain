import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import { Construct } from "constructs";
import * as path from "path";

export interface RepublishLambdaConstructProps {
  environment: string;
  regionCode: string;
  domainName: string; // e.g., "collector-domain", "maker-domain"
  removalPolicy?: cdk.RemovalPolicy;
  outboxTable: dynamodb.ITable;
  eventBus: events.IEventBus;
  schemaRegistryName: string;
  /** Schedule expression. Default: rate(10 minutes) - "Safety Net" recovery */
  schedule?: events.Schedule;
}

/**
 * Republish Lambda - Transactional Outbox Pattern Implementation
 *
 * Flow:
 * 1. EventBridge scheduled rule triggers this Lambda every 10 minutes
 * 2. Lambda queries GSI-StatusCreatedAt for PENDING events older than 2 minutes
 * 3. For each event, sends it to EventBridge (PutEvents)
 * 4. Marks event as SENT in DynamoDB
 * 5. DynamoDB TTL auto-deletes SENT records after 24 hours
 *
 * Key guarantees:
 * - No event loss: Events are written BEFORE they're sent (atomic transaction)
 * - Fast recovery: Async trigger from business lambdas (sub-second delivery)
 * - Safety net: Scheduled recovery every 10 minutes for any missed events
 */
export class RepublishLambdaConstruct extends Construct {
  public readonly function: NodejsFunction;
  public readonly scheduleRule: events.Rule;
  public readonly failedOutboxAlarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: RepublishLambdaConstructProps) {
    super(scope, id);

    const role = new iam.Role(this, "RepublishLambdaRole", {
      roleName: `${props.environment}-${props.regionCode}-${props.domainName}-republish-lambda-role`,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "IAM role for Republish Lambda (publish PENDING events to EventBridge)",
      inlinePolicies: {
        CloudWatchLogsAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:PutLogEvents",
                "logs:DescribeLogGroups",
                "logs:DescribeLogStreams",
              ],
              resources: [
                `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/${props.environment}-${props.regionCode}-${props.domainName}-republish-lambda`,
                `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/${props.environment}-${props.regionCode}-${props.domainName}-republish-lambda:log-stream:*`,
              ],
            }),
          ],
        }),
        CloudWatchPutMetric: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["cloudwatch:PutMetricData"],
              resources: ["*"],
              conditions: {
                StringEquals: {
                  "cloudwatch:namespace": `HandMade/${props.domainName.charAt(0).toUpperCase() + props.domainName.slice(1)}/Outbox`,
                },
              },
            }),
          ],
        }),
        GlueSchemaRead: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["glue:GetSchema", "glue:GetSchemaVersion"],
              resources: ["*"],
            }),
          ],
        }),
      },
    });

    // Grant permissions to read/write outbox table and publish to EventBridge
    props.outboxTable.grantReadWriteData(role);
    props.eventBus.grantPutEventsTo(role);

    const logGroup = new logs.LogGroup(this, "RepublishLambdaLogGroup", {
      logGroupName: `/aws/lambda/${props.environment}-${props.regionCode}-${props.domainName}-republish-lambda`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.DESTROY,
    });

    // Path to the Lambda handler (create this file in functions/lambda/republish-lambda.ts)
    const lambdaCodePath = path.join(__dirname, "../../../functions/lambda/republish-lambda/republish-lambda.ts");

    this.function = new NodejsFunction(this, "RepublishFunction", {
      functionName: `${props.environment}-${props.regionCode}-${props.domainName}-republish-lambda`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "handler",
      entry: lambdaCodePath,
      role,
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      tracing: lambda.Tracing.DISABLED,
      logGroup,
      bundling: {
        minify: true,
        sourceMap: false,
        target: "node22",
        externalModules: ["@aws-sdk/*"],
      },
      environment: {
        ENVIRONMENT: props.environment,
        LOG_LEVEL: props.environment === "prod" ? "ERROR" : "INFO",
        OUTBOX_TABLE_NAME: props.outboxTable.tableName,
        EVENT_BUS_NAME: props.eventBus.eventBusName,
        DOMAIN_NAME: props.domainName,
        EVENT_SOURCE: `hand-made.${props.domainName}`,
        METRIC_NAMESPACE: `HandMade/${props.domainName.charAt(0).toUpperCase() + props.domainName.slice(1)}/Outbox`,
        MAX_RETRIES: "5",
        BATCH_SIZE: "50",
        // Safety Net: Find PENDING events older than 2 minutes
        PENDING_THRESHOLD_MINUTES: "2",
        SCHEMA_REGISTRY_NAME: props.schemaRegistryName,
      },
      description: "Republish Lambda: Publish PENDING outbox events to EventBridge (transactional outbox pattern)",
    });

    // 10-minute schedule as per Federated Event Mesh spec (Safety Net recovery)
    const schedule = props.schedule ?? events.Schedule.rate(cdk.Duration.minutes(10));

    this.scheduleRule = new events.Rule(this, "RepublishScheduleRule", {
      ruleName: `${props.environment}-${props.regionCode}-${props.domainName}-republish-rule`,
      description: `Republish Lambda: Send PENDING events to EventBridge every 10 minutes (Safety Net for ${props.domainName})`,
      schedule,
      enabled: true,
    });

    this.scheduleRule.addTarget(new targets.LambdaFunction(this.function));

    // CloudWatch Alarm: Alert if any events reach retry cap and transition to FAILED
    this.failedOutboxAlarm = new cloudwatch.Alarm(this, "RepublishFailedAlarm", {
      alarmName: `${props.environment}-${props.regionCode}-${props.domainName}-republish-failed-alarm`,
      metric: new cloudwatch.Metric({
        namespace: `HandMade/${props.domainName.charAt(0).toUpperCase() + props.domainName.slice(1)}/Outbox`,
        metricName: "RepublishFailedCount",
        statistic: cloudwatch.Statistic.SUM,
        period: cdk.Duration.minutes(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: "At least one outbox event hit retry cap (FAILED). Manual intervention required.",
    });

    if (props.removalPolicy) {
      this.function.applyRemovalPolicy(props.removalPolicy);
    }
  }
}
