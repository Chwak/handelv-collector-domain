import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import * as path from 'path';

export interface CollectorItemsLambdaConstructProps {
  environment: string;
  regionCode: string;
  collectionsTable: dynamodb.ITable;
  collectionItemsTable: dynamodb.ITable;
  savedItemsTable: dynamodb.ITable;
  wishlistsTable: dynamodb.ITable;
  followsTable: dynamodb.ITable;
  removalPolicy?: cdk.RemovalPolicy;
}

export class CollectorItemsLambdaConstruct extends Construct {
  public readonly function: NodejsFunction;

  constructor(scope: Construct, id: string, props: CollectorItemsLambdaConstructProps) {
    super(scope, id);

    const role = new iam.Role(this, 'CollectorItemsLambdaRole', {
      roleName: `${props.environment}-${props.regionCode}-collector-domain-collector-items-lambda-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'IAM role for Collector Items Lambda',
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
                `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/${props.environment}-${props.regionCode}-collector-domain-collector-items-lambda*`,
              ],
            }),
          ],
        }),
      },
    });

    const logGroup = new logs.LogGroup(this, 'CollectorItemsLogGroup', {
      logGroupName: `/aws/lambda/${props.environment}-${props.regionCode}-collector-domain-collector-items-lambda`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.DESTROY,
    });

    const lambdaCodePath = path.join(
      __dirname,
      '../../../../functions/lambda/collector/collector-items/collector-items-lambda.ts',
    );

    this.function = new NodejsFunction(this, 'CollectorItemsFunction', {
      functionName: `${props.environment}-${props.regionCode}-collector-domain-collector-items-lambda`,
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
        COLLECTOR_COLLECTIONS_TABLE_NAME: props.collectionsTable.tableName,
        COLLECTOR_COLLECTION_ITEMS_TABLE_NAME: props.collectionItemsTable.tableName,
        COLLECTOR_SAVED_ITEMS_TABLE_NAME: props.savedItemsTable.tableName,
        COLLECTOR_WISHLISTS_TABLE_NAME: props.wishlistsTable.tableName,
        COLLECTOR_FOLLOWS_TABLE_NAME: props.followsTable.tableName,
        LOG_LEVEL: props.environment === 'prod' ? 'ERROR' : 'INFO',
      },
      description: 'Collector saved items, collections, follows, and wishlists operations',
    });

    props.collectionsTable.grantReadWriteData(this.function);
    props.collectionItemsTable.grantReadWriteData(this.function);
    props.savedItemsTable.grantReadWriteData(this.function);
    props.wishlistsTable.grantReadWriteData(this.function);
    props.followsTable.grantReadWriteData(this.function);

    if (props.removalPolicy) {
      this.function.applyRemovalPolicy(props.removalPolicy);
    }
  }
}
