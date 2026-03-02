import * as cdk from 'aws-cdk-lib';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';
import { Construct } from 'constructs';

export interface CollectorAppSyncConstructProps {
  environment: string;
  regionCode: string;
}

export class CollectorAppSyncConstruct extends Construct {
  public readonly api: appsync.GraphqlApi;
  public readonly apiUrl: string;
  public readonly apiId: string;

  constructor(scope: Construct, id: string, props: CollectorAppSyncConstructProps) {
    super(scope, id);

    // Import User Pool from SSM (created by auth-essentials stack)
    const userPoolId = ssm.StringParameter.fromStringParameterName(
      this,
      'UserPoolId',
      `/${props.environment}/auth-essentials/cognito/user-pool-id`
    ).stringValue;

    const userPool = cognito.UserPool.fromUserPoolId(
      this,
      'ImportedUserPool',
      userPoolId
    );

    // Create IAM role for AppSync to write logs
    const apiLogsRole = new iam.Role(this, 'ApiLogsRole', {
      roleName: `${props.environment}-${props.regionCode}-collector-domain-appsync-logs-role`,
      assumedBy: new iam.ServicePrincipal('appsync.amazonaws.com'),
      description: 'IAM role for Collector AppSync API CloudWatch Logs',
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
                `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/appsync/apis/*`,
              ],
            }),
          ],
        }),
      },
    });

    // Create AppSync GraphQL API for Collector Domain
    this.api = new appsync.GraphqlApi(this, 'CollectorAppSyncApi', {
      name: `${props.environment}-${props.regionCode}-collector-domain-appsync`,
      definition: appsync.Definition.fromFile(
        path.join(__dirname, 'schema.graphql')
      ),
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.USER_POOL,
          userPoolConfig: {
            userPool: userPool,
          },
        },
        additionalAuthorizationModes: [
          {
            authorizationType: appsync.AuthorizationType.IAM,
          },
        ],
      },
      logConfig: {
        fieldLogLevel: appsync.FieldLogLevel.INFO,
        excludeVerboseContent: true,
        role: apiLogsRole,
      },
      xrayEnabled: false,
    });

    // Create CloudWatch Log Group for AppSync with manual retention
    // AppSync creates log groups with pattern: /aws/appsync/apis/{apiId}
    // The log group will be created after the API (since it uses apiId), and AppSync will use it if it exists
    const apiLogGroup = new logs.LogGroup(this, 'ApiLogGroup', {
      logGroupName: `/aws/appsync/apis/${this.api.apiId}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.apiUrl = this.api.graphqlUrl;
    this.apiId = this.api.apiId;

    // Export API URL and ID to SSM for other stacks
    new ssm.StringParameter(this, 'CollectorAppSyncApiUrlParameter', {
      parameterName: `/${props.environment}/collector-domain/appsync/api-url`,
      stringValue: this.apiUrl,
      description: 'Collector Domain AppSync GraphQL API URL',
    });

    new ssm.StringParameter(this, 'CollectorAppSyncApiIdParameter', {
      parameterName: `/${props.environment}/collector-domain/appsync/api-id`,
      stringValue: this.apiId,
      description: 'Collector Domain AppSync GraphQL API ID',
    });

    new cdk.CfnOutput(this, 'CollectorAppSyncApiUrl', {
      value: this.apiUrl,
      description: 'Collector Domain AppSync GraphQL API URL',
      exportName: `${props.environment}-${props.regionCode}-collector-domain-appsync-url`,
    });

    new cdk.CfnOutput(this, 'CollectorAppSyncApiId', {
      value: this.apiId,
      description: 'Collector Domain AppSync GraphQL API ID',
      exportName: `${props.environment}-${props.regionCode}-collector-domain-appsync-id`,
    });
  }
}
