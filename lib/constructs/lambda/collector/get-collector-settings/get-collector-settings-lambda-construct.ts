import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import * as path from 'path';

export interface GetCollectorSettingsLambdaConstructProps {
  environment: string;
  regionCode: string;
  collectorSettings: dynamodb.ITable;
  removalPolicy?: cdk.RemovalPolicy;
}

export class GetCollectorSettingsLambdaConstruct extends Construct {
  public readonly function: NodejsFunction;

  constructor(scope: Construct, id: string, props: GetCollectorSettingsLambdaConstructProps) {
    super(scope, id);

    const role = new iam.Role(this, 'GetCollectorSettingsLambdaRole', {
      roleName: `${props.environment}-${props.regionCode}-collector-domain-get-collector-settings-lambda-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'IAM role for Get Collector Settings Lambda',
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
                `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/${props.environment}-${props.regionCode}-collector-domain-get-collector-settings-lambda*`,
              ],
            }),
          ],
        }),
        DynamoDBAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
              resources: [
                props.collectorSettings.tableArn,
              ],
            }),
          ],
        }),
      },
    });

    const logGroup = new logs.LogGroup(this, 'GetCollectorSettingsLogGroup', {
      logGroupName: `/aws/lambda/${props.environment}-${props.regionCode}-collector-domain-get-collector-settings-lambda`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.DESTROY,
    });

    const lambdaCodePath = path.join(__dirname, '../../../../functions/lambda/collector/get-collector-settings/get-collector-settings-lambda.ts');
    this.function = new NodejsFunction(this, 'GetCollectorSettingsFunction', {
      functionName: `${props.environment}-${props.regionCode}-collector-domain-get-collector-settings-lambda`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'handler',
      entry: lambdaCodePath,
      role,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      tracing: lambda.Tracing.ACTIVE,
      logGroup,
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node22',
        externalModules: ['@aws-sdk/*'],
      },
      environment: {
        ENVIRONMENT: props.environment,
        COLLECTOR_SETTINGS_TABLE_NAME: props.collectorSettings.tableName,
      },
      description: 'Get collector preferences and settings (cached after login)',
    });
  }
}
