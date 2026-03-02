import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';

import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as pipes from 'aws-cdk-lib/aws-pipes';
import { Construct } from 'constructs';
import * as path from 'path';

const SQS_MAX_RECEIVE_COUNT = 5;
const LAMBDA_TIMEOUT_SECONDS = 30;
const VISIBILITY_TIMEOUT_SECONDS = LAMBDA_TIMEOUT_SECONDS * 6;

export interface NewCollectorFromAuthLambdaConstructProps {
  environment: string;
  regionCode: string;
  collectorProfiles: dynamodb.ITable;
  collectorSettings: dynamodb.ITable;
  eventBus: events.IEventBus;
  idempotencyTable: dynamodb.ITable;
  outboxTable: dynamodb.ITable;
  schemaRegistryName: string;
  removalPolicy?: cdk.RemovalPolicy;
}

export class NewCollectorFromAuthLambdaConstruct extends Construct {
  public readonly function: NodejsFunction;
  public readonly queue: sqs.Queue;
  public readonly deadLetterQueue: sqs.Queue;
  public readonly dlqAlarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: NewCollectorFromAuthLambdaConstructProps) {
    super(scope, id);

    const deadLetterQueue = new sqs.Queue(this, 'NewCollectorEventsDlq', {
      queueName: `${props.environment}-${props.regionCode}-collector-domain-auth-events-dlq`,
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.DESTROY,
    });
    this.deadLetterQueue = deadLetterQueue;

    const queue = new sqs.Queue(this, 'NewCollectorEventsQueue', {
      queueName: `${props.environment}-${props.regionCode}-collector-domain-auth-events-queue`,
      retentionPeriod: cdk.Duration.days(14),
      visibilityTimeout: cdk.Duration.seconds(VISIBILITY_TIMEOUT_SECONDS),
      receiveMessageWaitTime: cdk.Duration.seconds(20),
      deadLetterQueue: {
        queue: deadLetterQueue,
        maxReceiveCount: SQS_MAX_RECEIVE_COUNT,
      },
      removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.DESTROY,
    });
    this.queue = queue;

    this.dlqAlarm = new cloudwatch.Alarm(this, 'DlqDepthAlarm', {
      alarmName: `${props.environment}-${props.regionCode}-collector-domain-new-collector-events-dlq-alarm`,
      metric: deadLetterQueue.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Message(s) in DLQ. Consumer domain must decide: fix code, fix payload, or manual redrive. Never auto-redrive.',
    });

    const pipeRole = new iam.Role(this, 'CollectorAuthEventPipeRole', {
      roleName: `${props.environment}-${props.regionCode}-collector-domain-auth-event-pipe-role`,
      assumedBy: new iam.ServicePrincipal('pipes.amazonaws.com'),
      description: 'IAM role for EventBridge Pipes to SQS (collector domain)',
    });
    pipeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'events:DescribeEventBus',
          'events:DescribeRule',
          'events:PutRule',
          'events:PutTargets',
          'events:RemoveTargets',
          'events:DeleteRule',
        ],
        resources: [props.eventBus.eventBusArn, '*'],
      }),
    );
    pipeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sqs:SendMessage'],
        resources: [queue.queueArn],
      }),
    );

    // Create EventBridge rule to route auth events to SQS queue
    new events.Rule(this, 'CollectorAuthEventRule', {
      eventBus: props.eventBus,
      eventPattern: {
        source: ['hand-made.auth-essentials'],
        detailType: ['user.identity.completed.v1'],
        detail: {
          payload: {
            event: ['UserRegistrationComplete'],
            collectorEnabled: [true],
          },
        },
      },
      description: 'Route user registration complete events to collector domain queue',
    }).addTarget(new targets.SqsQueue(queue));

    // Create EventBridge rule to route collector mode enabled events
    new events.Rule(this, 'CollectorModeEnabledRule', {
      eventBus: props.eventBus,
      eventPattern: {
        source: ['hand-made.auth-essentials'],
        detailType: ['user.mode.collector.enabled.v1'],
      },
      description: 'Route user collector mode enabled events to collector domain queue',
    }).addTarget(new targets.SqsQueue(queue));

    const role = new iam.Role(this, 'NewCollectorFromAuthLambdaRole', {
      roleName: `${props.environment}-${props.regionCode}-collector-domain-new-collector-from-auth-lambda-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'IAM role for New Collector From Auth Lambda (SQS consumer)',
      inlinePolicies: {
        CloudWatchLogsAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'logs:CreateLogGroup',
                'logs:CreateLogStream',
                'logs:PutLogEvents',
              ],
              resources: [
                `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/${props.environment}-${props.regionCode}-collector-domain-new-collector-from-auth-lambda*`,
              ],
            }),
          ],
        }),
        DynamoDBPutItem: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['dynamodb:PutItem', 'dynamodb:ConditionCheckItem', 'dynamodb:TransactWriteItems', 'dynamodb:Query'],
              resources: [
                props.collectorProfiles.tableArn,
                `${props.collectorProfiles.tableArn}/index/GSI2-Email`,
                props.collectorSettings.tableArn,
                props.idempotencyTable.tableArn,
                props.outboxTable.tableArn,
              ],
            }),
          ],
        }),
        GlueSchemaRead: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['glue:GetSchema', 'glue:GetSchemaVersion'],
              resources: ['*'],
            }),
          ],
        }),
      },
    });

    const logGroup = new logs.LogGroup(this, 'NewCollectorFromAuthLogGroup', {
      logGroupName: `/aws/lambda/${props.environment}-${props.regionCode}-collector-domain-new-collector-from-auth-lambda`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.DESTROY,
    });

    const lambdaCodePath = path.join(__dirname, '../../../../functions/lambda/collector/new-collector-from-auth/new-collector-from-auth-lambda.ts');
    this.function = new NodejsFunction(this, 'NewCollectorFromAuthFunction', {
      functionName: `${props.environment}-${props.regionCode}-collector-domain-new-collector-from-auth-lambda`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'handler',
      entry: lambdaCodePath,
      role,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      tracing: lambda.Tracing.DISABLED,
      logGroup,
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node22',
        externalModules: ['@aws-sdk/*'],
      },
      environment: {
        ENVIRONMENT: props.environment,
        REGION_CODE: props.regionCode,
        COLLECTOR_PROFILES_TABLE_NAME: props.collectorProfiles.tableName,
        COLLECTOR_SETTINGS_TABLE_NAME: props.collectorSettings.tableName,
        IDEMPOTENCY_TABLE_NAME: props.idempotencyTable.tableName,
        OUTBOX_TABLE_NAME: props.outboxTable.tableName,
        SCHEMA_REGISTRY_NAME: props.schemaRegistryName,
        LOG_LEVEL: props.environment === 'prod' ? 'ERROR' : 'INFO',
      },
      description: 'Create collector profile when new collector user completes registration (email verified)',
    });
    this.function.addEventSource(new lambdaEventSources.SqsEventSource(queue, {
      batchSize: 10,
      reportBatchItemFailures: true,
    }));

    props.collectorProfiles.grantWriteData(this.function);
    props.collectorSettings.grantWriteData(this.function);
    props.idempotencyTable.grantReadWriteData(this.function);
    props.outboxTable.grantWriteData(this.function);

    if (props.removalPolicy) {
      this.function.applyRemovalPolicy(props.removalPolicy);
    }
  }
}
