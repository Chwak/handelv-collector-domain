import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import * as path from 'path';

export interface UpdateCollectorProfileLambdaConstructProps {
  environment: string;
  regionCode: string;
  collectorProfiles: dynamodb.ITable;
  auditLogs: dynamodb.ITable;
  idempotencyTable: dynamodb.ITable;
  removalPolicy?: cdk.RemovalPolicy;
}

export class UpdateCollectorProfileLambdaConstruct extends Construct {
  public readonly function: NodejsFunction;

  constructor(scope: Construct, id: string, props: UpdateCollectorProfileLambdaConstructProps) {
    super(scope, id);

    const role = new iam.Role(this, 'UpdateCollectorProfileLambdaRole', {
      roleName: `${props.environment}-${props.regionCode}-collector-domain-update-collector-profile-lambda-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'IAM role for Update Collector Profile Lambda',
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
                `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/${props.environment}-${props.regionCode}-collector-domain-update-collector-profile-lambda*`,
              ],
            }),
          ],
        }),
        DynamoDBAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:PutItem'],
              resources: [props.collectorProfiles.tableArn],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
              resources: [
                props.idempotencyTable.tableArn,
                props.auditLogs.tableArn,
              ],
            }),
          ],
        }),
      },
    });

    const logGroup = new logs.LogGroup(this, 'UpdateCollectorProfileLogGroup', {
      logGroupName: `/aws/lambda/${props.environment}-${props.regionCode}-collector-domain-update-collector-profile-lambda`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.DESTROY,
    });

    const lambdaCodePath = path.join(__dirname, '../../../../functions/lambda/collector/update-collector-profile/update-collector-profile-lambda.ts');
    this.function = new NodejsFunction(this, 'UpdateCollectorProfileFunction', {
      functionName: `${props.environment}-${props.regionCode}-collector-domain-update-collector-profile-lambda`,
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
        IDEMPOTENCY_TABLE_NAME: props.idempotencyTable.tableName,
        AUDIT_TABLE_NAME: props.auditLogs.tableName,
        FEATURE_FLAGS: 'auditTrail=true,rateLimit=true,idempotency=true',
        RATE_LIMIT_PER_MINUTE: '10',
        LOG_LEVEL: props.environment === 'prod' ? 'ERROR' : 'INFO',
      },
      description: 'Update collector profile',
    });

    // Grant read/write access to DynamoDB table
    props.collectorProfiles.grantReadWriteData(this.function);

    // Add log retention

    if (props.removalPolicy) {
      this.function.applyRemovalPolicy(props.removalPolicy);
    }
  }
}
